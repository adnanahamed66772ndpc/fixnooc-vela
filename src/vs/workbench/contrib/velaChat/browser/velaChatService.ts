/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVelaChatRequest, IVelaChatResponseChunk, IVelaChatService, VelaChatError, VelaChatSettings } from '../common/velaChat.js';

/**
 * Talks to an OpenAI-compatible chat completions endpoint.
 *
 * The request goes to a relative path by default, so in the browser it is
 * same-origin and the API key stays with whatever serves Vela rather than
 * being handed to every tab.
 */
export class VelaChatService extends Disposable implements IVelaChatService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async *chat(request: IVelaChatRequest, token: CancellationToken): AsyncIterable<IVelaChatResponseChunk> {
		const endpoint = this.configurationService.getValue<string>(VelaChatSettings.Endpoint) || '/vela-chat/completions';
		const model = request.model || this.configurationService.getValue<string>(VelaChatSettings.Model) || '';

		const controller = new AbortController();
		const cancellation = token.onCancellationRequested(() => controller.abort());

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: model || undefined,
					stream: true,
					messages: request.messages.map(m => ({ role: m.role, content: m.content })),
				}),
				signal: controller.signal,
			});
		} catch (error) {
			cancellation.dispose();
			if (token.isCancellationRequested) {
				return;
			}
			this.logService.error('[velaChat] request failed', error);
			throw new VelaChatError(
				localize('velaChat.unreachable', "Could not reach the chat endpoint."),
				String(error));
		}

		try {
			if (!response.ok) {
				throw new VelaChatError(
					localize('velaChat.rejected', "The chat endpoint returned {0}.", response.status),
					await this.readErrorBody(response));
			}

			if (!response.body) {
				throw new VelaChatError(localize('velaChat.noBody', "The chat endpoint sent no response body."));
			}

			yield* this.readSSE(response.body, token);
		} finally {
			cancellation.dispose();
		}
	}

	/**
	 * Reads an OpenAI-style `text/event-stream`: `data:` lines carrying JSON
	 * deltas, terminated by `data: [DONE]`.
	 */
	private async *readSSE(body: ReadableStream<Uint8Array>, token: CancellationToken): AsyncIterable<IVelaChatResponseChunk> {
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

				// Events are separated by a blank line, but a chunk can split one in
				// half, so only consume up to the last complete separator.
				let separator = buffer.indexOf('\n\n');
				while (separator !== -1) {
					const event = buffer.slice(0, separator);
					buffer = buffer.slice(separator + 2);
					separator = buffer.indexOf('\n\n');

					const text = this.textFromEvent(event);
					if (text) {
						yield { text };
					}
				}
			}
		} finally {
			reader.cancel().catch(() => { /* the stream is going away anyway */ });
		}
	}

	private textFromEvent(event: string): string | undefined {
		let text = '';

		for (const line of event.split('\n')) {
			if (!line.startsWith('data:')) {
				continue;
			}

			const payload = line.slice('data:'.length).trim();
			if (!payload || payload === '[DONE]') {
				continue;
			}

			try {
				const parsed = JSON.parse(payload);
				const delta = parsed?.choices?.[0]?.delta?.content;
				if (typeof delta === 'string') {
					text += delta;
				}
			} catch {
				// A malformed event is not worth failing the whole reply over.
				this.logService.trace('[velaChat] skipped an unparseable event');
			}
		}

		return text || undefined;
	}

	private async readErrorBody(response: Response): Promise<string | undefined> {
		try {
			const body = (await response.text()).trim();
			return body ? body.slice(0, 500) : undefined;
		} catch {
			return undefined;
		}
	}
}
