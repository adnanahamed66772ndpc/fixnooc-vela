/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const VELA_CHAT_VIEW_ID = 'workbench.view.velaChat';
export const VELA_CHAT_CONTAINER_ID = 'workbench.view.velaChatContainer';

export const enum VelaChatSettings {
	Backend = 'velaChat.backend',
	Endpoint = 'velaChat.endpoint',
	Model = 'velaChat.model',
	ReasoningEffort = 'velaChat.reasoningEffort',
	ShowThoughts = 'velaChat.showThoughts',
}

/** `dsh` drives DeepSeek Harness as an agent; `openai` is a plain completions endpoint. */
export type VelaChatBackend = 'dsh' | 'openai';

export type VelaChatRole = 'user' | 'assistant' | 'system';

export interface IVelaChatMessage {
	readonly role: VelaChatRole;
	readonly content: string;
}

export interface IVelaChatRequest {
	readonly messages: readonly IVelaChatMessage[];
	/** The agent session to continue. Omit to have the backend open one. */
	readonly sessionId?: string;
	readonly model?: string;
}

/** Reply text to show. */
export interface IVelaChatTextChunk {
	readonly kind: 'text';
	readonly text: string;
}

/** The agent's reasoning, shown separately and only when asked for. */
export interface IVelaChatThoughtChunk {
	readonly kind: 'thought';
	readonly text: string;
}

/** A tool the agent ran: an edit, a command, a search. */
export interface IVelaChatToolChunk {
	readonly kind: 'tool';
	readonly id?: string;
	readonly title?: string;
	readonly status?: string;
}

/** A permission the backend answered on the agent's behalf. */
export interface IVelaChatPermissionChunk {
	readonly kind: 'permission';
	readonly approved: boolean;
	readonly title?: string;
}

/** The session this turn belongs to, so later turns can continue it. */
export interface IVelaChatSessionChunk {
	readonly kind: 'session';
	readonly sessionId: string;
	readonly agent?: string;
}

export type VelaChatChunk =
	| IVelaChatTextChunk
	| IVelaChatThoughtChunk
	| IVelaChatToolChunk
	| IVelaChatPermissionChunk
	| IVelaChatSessionChunk;

export const IVelaChatService = createDecorator<IVelaChatService>('velaChatService');

export interface IVelaChatService {
	readonly _serviceBrand: undefined;

	/**
	 * Sends a turn and yields what comes back as it arrives. Throws
	 * {@link VelaChatError} when the backend is unreachable or rejects the turn.
	 */
	chat(request: IVelaChatRequest, token: CancellationToken): AsyncIterable<VelaChatChunk>;
}

/** An error worth showing the user verbatim, rather than a stack trace. */
export class VelaChatError extends Error {
	constructor(message: string, readonly detail?: string) {
		super(message);
		this.name = 'VelaChatError';
	}
}
