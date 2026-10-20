/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Drives DeepSeek Harness over the Agent Client Protocol.
 *
 * DSH speaks ACP v1 as JSON-RPC on stdio, so one child process serves every
 * chat session: ACP multiplexes sessions over a single connection. The process
 * is owned here, in the gateway, because a browser cannot spawn one and the
 * provider key must not reach it.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/** Updates DSH sends; anything else is passed through untouched. */
const TEXT_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk']);

export function dshConfigFromEnv(env) {
	return {
		command: env.VELA_DSH_BIN || '',
		profile: env.VELA_DSH_PROFILE || 'acp',
		home: env.VELA_DSH_HOME || '',
		workspace: env.VELA_DSH_WORKSPACE || env.VELA_WORKSPACE || process.env.HOME || '.',
		apiKey: env.DEEPSEEK_API_KEY || '',
		reasoningEffort: env.VELA_DSH_REASONING_EFFORT || '',
		// DSH asks before it edits a file or runs a command. Vela has no way yet
		// to put that question to the person, so the default refuses: an agent
		// acting unsupervised on this machine should be something you switch on
		// deliberately, not something you inherit from a default.
		autoApprove: env.VELA_DSH_AUTO_APPROVE === 'true',
		startupTimeoutMs: Number(env.VELA_DSH_STARTUP_TIMEOUT_MS || 60_000),
	};
}

export class DshBridge extends EventEmitter {

	#config;
	#log;
	#child;
	#starting;
	#buffer = '';
	#nextId = 1;
	#pending = new Map();
	/** sessionId -> listener set, so updates reach only the asking client. */
	#listeners = new Map();
	#initializeResult;

	constructor(config, log = () => { }) {
		super();
		this.#config = config;
		this.#log = log;
	}

	get configured() {
		return Boolean(this.#config.command);
	}

	get agentInfo() {
		return this.#initializeResult?.agentInfo;
	}

	/** Starts DSH and completes the ACP handshake. Safe to call repeatedly. */
	async start() {
		if (this.#initializeResult) {
			return this.#initializeResult;
		}
		this.#starting ??= this.#startOnce().finally(() => { this.#starting = undefined; });
		return this.#starting;
	}

	async #startOnce() {
		if (!this.#config.command) {
			throw new Error('DSH is not configured. Set VELA_DSH_BIN in vela-web/.env.');
		}

		const env = { ...process.env };
		if (this.#config.apiKey) {
			env.DEEPSEEK_API_KEY = this.#config.apiKey;
		}
		if (this.#config.home) {
			env.DSH_HOME = this.#config.home;
		}

		this.#child = spawn(this.#config.command, ['--profile', this.#config.profile], {
			cwd: this.#config.workspace,
			stdio: ['pipe', 'pipe', 'pipe'],
			env,
		});

		// Stdout is protocol traffic only; DSH keeps its logging on stderr.
		this.#child.stdout.on('data', chunk => this.#consume(chunk));
		this.#child.stderr.on('data', chunk => this.#log(`[dsh] ${chunk.toString().trimEnd()}`));

		this.#child.on('exit', (code, signal) => {
			this.#log(`[dsh] exited code=${code} signal=${signal}`);
			const reason = new Error(`DSH exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
			for (const { reject } of this.#pending.values()) {
				reject(reason);
			}
			this.#pending.clear();
			for (const listeners of this.#listeners.values()) {
				for (const listener of listeners) {
					listener({ type: 'error', message: reason.message });
				}
			}
			this.#listeners.clear();
			this.#child = undefined;
			this.#initializeResult = undefined;
		});

		this.#child.on('error', error => this.#log(`[dsh] spawn failed: ${error.message}`));

		this.#initializeResult = await this.#request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {},
		}, this.#config.startupTimeoutMs);

		this.#log(`[dsh] ready: ${this.#initializeResult.agentInfo?.name} ${this.#initializeResult.agentInfo?.version}`);
		return this.#initializeResult;
	}

	async newSession(workspace = this.#config.workspace) {
		await this.start();
		const result = await this.#request('session/new', { cwd: workspace, mcpServers: [] });

		if (this.#config.reasoningEffort) {
			try {
				await this.#request('session/set_config_option', {
					sessionId: result.sessionId,
					optionId: 'reasoning_effort',
					value: this.#config.reasoningEffort,
				});
			} catch (error) {
				// A rejected effort should not cost us the session.
				this.#log(`[dsh] could not set reasoning_effort: ${error.message}`);
			}
		}

		return result;
	}

	async setReasoningEffort(sessionId, value) {
		return this.#request('session/set_config_option', { sessionId, optionId: 'reasoning_effort', value });
	}

	async closeSession(sessionId) {
		try {
			await this.#request('session/close', { sessionId });
		} catch (error) {
			this.#log(`[dsh] close failed: ${error.message}`);
		}
	}

	cancel(sessionId) {
		this.#notify('session/cancel', { sessionId });
	}

	/**
	 * Sends a prompt and yields normalised events until the turn settles.
	 * `onEvent` sees every update as it arrives; the promise resolves with the
	 * ACP stop reason.
	 */
	async prompt(sessionId, text, onEvent) {
		await this.start();

		const listeners = this.#listeners.get(sessionId) ?? new Set();
		listeners.add(onEvent);
		this.#listeners.set(sessionId, listeners);

		try {
			const result = await this.#request('session/prompt', {
				sessionId,
				prompt: [{ type: 'text', text }],
			}, 0);
			return result?.stopReason ?? 'end_turn';
		} finally {
			listeners.delete(onEvent);
			if (!listeners.size) {
				this.#listeners.delete(sessionId);
			}
		}
	}

	dispose() {
		this.#child?.kill();
		this.#child = undefined;
		this.#initializeResult = undefined;
	}

	// --- wire ----------------------------------------------------------------

	#request(method, params, timeoutMs = 120_000) {
		if (!this.#child) {
			return Promise.reject(new Error('DSH is not running.'));
		}

		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			let timer;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					this.#pending.delete(id);
					reject(new Error(`DSH did not answer ${method} within ${timeoutMs}ms`));
				}, timeoutMs);
			}

			this.#pending.set(id, {
				resolve: value => { clearTimeout(timer); resolve(value); },
				reject: error => { clearTimeout(timer); reject(error); },
			});

			this.#write({ jsonrpc: '2.0', id, method, params });
		});
	}

	#notify(method, params) {
		if (this.#child) {
			this.#write({ jsonrpc: '2.0', method, params });
		}
	}

	#write(message) {
		this.#child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#consume(chunk) {
		this.#buffer += chunk.toString();

		let newline;
		while ((newline = this.#buffer.indexOf('\n')) !== -1) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) {
				continue;
			}
			try {
				this.#dispatch(JSON.parse(line));
			} catch {
				// Not protocol traffic; DSH promises stdout is clean, so just note it.
				this.#log(`[dsh] ignored non-JSON stdout: ${line.slice(0, 200)}`);
			}
		}
	}

	#dispatch(message) {
		// A response to something we asked.
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const pending = this.#pending.get(message.id);
			if (!pending) {
				return;
			}
			this.#pending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(message.error.message || 'DSH returned an error'));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		// A request from DSH to us. Permission is the one we must answer.
		if (message.method && message.id !== undefined) {
			if (message.method === 'session/request_permission') {
				return this.#answerPermission(message);
			}
			this.#write({
				jsonrpc: '2.0',
				id: message.id,
				error: { code: -32601, message: `Vela does not implement ${message.method}` },
			});
			return;
		}

		if (message.method === 'session/update') {
			this.#deliverUpdate(message.params);
		}
	}

	#answerPermission(message) {
		const { sessionId, options, toolCall } = message.params ?? {};
		const allow = options?.find(o => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options?.[0];
		const reject = options?.find(o => o.kind === 'reject_once' || o.kind === 'reject_always');
		const chosen = this.#config.autoApprove ? allow : reject;

		this.#log(`[dsh] permission ${this.#config.autoApprove ? 'granted' : 'refused'}`
			+ ` for ${toolCall?.title ?? 'a tool call'}`
			+ (this.#config.autoApprove ? '' : ' (set VELA_DSH_AUTO_APPROVE=true to allow)'));

		this.#emitTo(sessionId, {
			type: 'permission',
			approved: Boolean(this.#config.autoApprove),
			title: toolCall?.title,
		});

		this.#write({
			jsonrpc: '2.0',
			id: message.id,
			result: chosen
				? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
				: { outcome: { outcome: 'cancelled' } },
		});
	}

	#deliverUpdate(params) {
		const update = params?.update;
		if (!update) {
			return;
		}

		const kind = update.sessionUpdate;

		if (TEXT_UPDATES.has(kind)) {
			const text = update.content?.text;
			if (text) {
				this.#emitTo(params.sessionId, {
					type: kind === 'agent_thought_chunk' ? 'thought' : 'text',
					text,
				});
			}
			return;
		}

		if (kind === 'tool_call' || kind === 'tool_call_update') {
			this.#emitTo(params.sessionId, {
				type: 'tool',
				id: update.toolCallId,
				title: update.title,
				status: update.status,
				input: update.rawInput,
				content: update.content,
			});
			return;
		}

		if (kind === 'usage_update' || kind === 'config_option_update') {
			this.#emitTo(params.sessionId, { type: kind === 'usage_update' ? 'usage' : 'config', update });
		}
	}

	#emitTo(sessionId, event) {
		for (const listener of this.#listeners.get(sessionId) ?? []) {
			try {
				listener(event);
			} catch (error) {
				this.#log(`[dsh] listener threw: ${error.message}`);
			}
		}
	}
}
