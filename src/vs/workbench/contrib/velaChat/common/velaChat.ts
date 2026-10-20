/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const VELA_CHAT_VIEW_ID = 'workbench.view.velaChat';
export const VELA_CHAT_CONTAINER_ID = 'workbench.view.velaChatContainer';

export const enum VelaChatSettings {
	Endpoint = 'velaChat.endpoint',
	Model = 'velaChat.model',
	SystemPrompt = 'velaChat.systemPrompt',
	IncludeActiveFile = 'velaChat.includeActiveFile',
}

export type VelaChatRole = 'user' | 'assistant' | 'system';

export interface IVelaChatMessage {
	readonly role: VelaChatRole;
	readonly content: string;
}

export interface IVelaChatRequest {
	readonly messages: readonly IVelaChatMessage[];
	readonly model?: string;
}

/** Streamed back as the reply arrives, one chunk of text at a time. */
export interface IVelaChatResponseChunk {
	readonly text: string;
}

export const IVelaChatService = createDecorator<IVelaChatService>('velaChatService');

export interface IVelaChatService {
	readonly _serviceBrand: undefined;

	/**
	 * Sends a conversation and yields the reply as it streams in. Throws
	 * {@link VelaChatError} when the endpoint is unreachable or rejects the request.
	 */
	chat(request: IVelaChatRequest, token: CancellationToken): AsyncIterable<IVelaChatResponseChunk>;
}

/** An error worth showing the user verbatim, rather than a stack trace. */
export class VelaChatError extends Error {
	constructor(message: string, readonly detail?: string) {
		super(message);
		this.name = 'VelaChatError';
	}
}
