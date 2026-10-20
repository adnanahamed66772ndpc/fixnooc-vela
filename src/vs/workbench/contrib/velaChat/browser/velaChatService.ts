/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVelaChatRequest, IVelaChatService, VelaChatBackend, VelaChatChunk, VelaChatError, VelaChatSettings } from '../common/velaChat.js';

/** One `event:`/`data:` pair from the stream. */
interface IServerSentEvent {
	readonly event: string;
	readonly data: string;
}

/**
 * Talks to whatever serves Vela over a relative path, so in the browser the
 * request is same-origin and the provider key stays on the server rather than
 * being handed to every tab.
 *
 * Two backends: `dsh` drives DeepSeek Harness as an agent over its own event
 * stream, and `openai` posts to an OpenAI-compatible completions endpoint.
 */
export class VelaChatService extends Disposable implements IVelaChatService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async *chat(request: IVelaChatRequest, token: CancellationToken): AsyncIterable<VelaChatChunk> {
		const backend = this.configurationService.getValue<VelaChatBackend>(VelaChatSettings.Backend) || 'dsh';
		const endpoint = this.configurationService.getValue<string>(VelaChatSettings.Endpoint)
			|| (backend === 'dsh' ? '/vela-chat/dsh' : '/vela-chat/completions');

		const body = backend === 'dsh'
			? {
				message: request.messages.filter(m => m.role === 'user').at(-1)?.content ?? '',
				sessionId: request.sessionId,
				reasoningEffort: this.configurationService.getValue<string>(VelaChatSettings.ReasoningEffort) || undefined,
			}
			: {
				model: request.model || this.configurationService.getValue<string>(VelaChatSettings.Model) || undefined,
				stream: true,
				messages: request.messages.map(m => ({ role: m.role, content: m.content })),
			};

		const response = await this.post(endpoint, body, token);
		if (!response) {
			return;
		}

		for await (const event of this.readEvents(response, token)) {
			const chunk = backend === 'dsh' ? this.readDshEvent(event) : this.readOpenAiEvent(event);
			if (chunk) {
				yield chunk;
			}
		}
	}

	private async post(endpoint: string, body: unknown, token: CancellationToken): Promise<ReadableStream<Uint8Array> | undefined> {
		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new VelaChatError(
					localize('velaChat.rejected', "The chat backend returned {0}.", response.status),
					await this.readErrorMessage(response));
			}
			if (!response.body) {
				throw new VelaChatError(localize('velaChat.noBody', "The chat backend sent no response body."));
			}
			return response.body;
		} catch (error) {
			if (token.isCancellationRequested) {
				return undefined;
			}
			if (error instanceof VelaChatError) {
				throw error;
			}
			this.logService.error('[velaChat] request failed', error);
			throw new VelaChatError(
				localize('velaChat.unreachable', "Could not reach the chat backend."),
				String(error));
		} finally {
			cancellation.dispose();
		}
	}

	/** Splits a `text/event-stream` into events, tolerating chunk boundaries. */
	private async *readEvents(body: ReadableStream<Uint8Array>, token: CancellationToken): AsyncIterable<IServerSentEvent> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (!token.isCancellationRequested) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				let separator = buffer.indexOf('\n\n');
				while (separator !== -1) {
					const raw = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					separator = buffer.indexOf('\n\n');

					let event = 'message';
					const data: string[] = [];
					for (const line of raw.split('\n')) {
						if (line.startsWith('event:')) {
							event = line.slice('event:'.length).trim();
						} else if (line.startsWith('data:')) {
							data.push(line.slice('data:'.length).trim());
						}
					}
					if (data.length) {
						yield { event, data: data.join('\n') };
					}
				}
			}
		} finally {
			reader.cancel().catch(() => { /* the stream is going away anyway */ });
		}
	}

	private readDshEvent(event: IServerSentEvent): VelaChatChunk | undefined {
		const payload = this.parse(event.data);
		if (!payload) {
			return undefined;
		}

		switch (event.event) {
			case 'text':
				return typeof payload.text === 'string' ? { kind: 'text', text: payload.text } : undefined;
			case 'thought':
				return typeof payload.text === 'string' ? { kind: 'thought', text: payload.text } : undefined;
			case 'tool':
				return { kind: 'tool', id: payload.id, title: payload.title, status: payload.status };
			case 'permission':
				return { kind: 'permission', approved: Boolean(payload.approved), title: payload.title };
			case 'vela.session':
				return typeof payload.sessionId === 'string'
					? { kind: 'session', sessionId: payload.sessionId, agent: payload.agent?.name }
					: undefined;
			case 'error':
				throw new VelaChatError(
					localize('velaChat.agentFailed', "The agent could not finish this turn."),
					typeof payload.message === 'string' ? payload.message : undefined);
			default:
				// usage, config and vela.done carry nothing to show yet.
				return undefined;
		}
	}

	private readOpenAiEvent(event: IServerSentEvent): VelaChatChunk | undefined {
		if (event.data === '[DONE]') {
			return undefined;
		}
		const delta = this.parse(event.data)?.choices?.[0]?.delta?.content;
		return typeof delta === 'string' && delta ? { kind: 'text', text: delta } : undefined;
	}

	private parse(data: string): any | undefined {
		try {
			return JSON.parse(data);
		} catch {
			// A malformed event is not worth failing the whole turn over.
			this.logService.trace('[velaChat] skipped an unparseable event');
			return undefined;
		}
	}

	private async readErrorMessage(response: Response): Promise<string | undefined> {
		try {
			const text = (await response.text()).trim();
			if (!text) {
				return undefined;
			}
			try {
				return JSON.parse(text)?.error?.message ?? text.slice(0, 500);
			} catch {
				return text.slice(0, 500);
			}
		} catch {
			return undefined;
		}
	}
}
