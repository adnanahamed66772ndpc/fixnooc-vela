/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `POST /vela-chat/completions`
 *
 * Asks Jev how heavy the request is, picks a model to match, then streams that
 * model's reply straight through. Both API keys stay in this process, so the
 * browser never holds either one.
 */

import { pickModel } from './model-router.mjs';

export function chatConfigFromEnv(env) {
	return {
		llmBaseUrl: (env.VELA_LLM_BASE_URL || '').replace(/\/+$/, ''),
		llmApiKey: env.VELA_LLM_API_KEY || '',
		router: {
			apiKey: env.TYPESAFE_API_KEY || '',
			judgeModel: env.VELA_JUDGE_MODEL || 'jev-latest',
			fallbackTier: env.VELA_FALLBACK_TIER || 'medium',
			models: {
				small: env.VELA_MODEL_SMALL || '',
				medium: env.VELA_MODEL_MEDIUM || '',
				large: env.VELA_MODEL_LARGE || '',
			},
		},
	};
}

export async function handleChatCompletions(req, res, config, log) {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		return fail(res, 405, 'Method Not Allowed');
	}

	if (!config.llmBaseUrl || !config.llmApiKey) {
		return fail(res, 503, 'No chat backend configured. Set VELA_LLM_BASE_URL and VELA_LLM_API_KEY in vela-web/.env.');
	}

	let request;
	try {
		request = JSON.parse(await readBody(req, 1024 * 1024));
	} catch {
		return fail(res, 400, 'Expected a JSON body.');
	}

	const messages = Array.isArray(request?.messages) ? request.messages : null;
	if (!messages?.length) {
		return fail(res, 400, 'Expected a non-empty "messages" array.');
	}

	// The routing judgment is about what the user just asked for.
	const lastUser = [...messages].reverse().find(m => m?.role === 'user');
	const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';

	const routed = request.model
		? { model: request.model, tier: 'explicit', judged: false, note: 'model named by the client' }
		: await pickModel(prompt, config.router);

	if (!routed.model) {
		return fail(res, 503, 'No model configured for this request. Set VELA_MODEL_SMALL, VELA_MODEL_MEDIUM and VELA_MODEL_LARGE in vela-web/.env.');
	}

	log?.(`[vela-chat] tier=${routed.tier} model=${routed.model}`
		+ (routed.weight !== null && routed.weight !== undefined ? ` weight=${routed.weight.toFixed(2)}` : '')
		+ (routed.note ? ` (${routed.note})` : ''));

	let upstream;
	try {
		upstream = await fetch(`${config.llmBaseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${config.llmApiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ ...request, model: routed.model, stream: true }),
		});
	} catch (error) {
		return fail(res, 502, `Could not reach the chat backend: ${error.message}`);
	}

	if (!upstream.ok || !upstream.body) {
		const detail = await upstream.text().catch(() => '');
		return fail(res, 502, `The chat backend returned ${upstream.status}. ${detail.slice(0, 300)}`);
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no',
	});

	// Tell the panel what was chosen before the reply starts, so it can show it.
	res.write(`event: vela.model\ndata: ${JSON.stringify(routed)}\n\n`);

	try {
		for await (const chunk of upstream.body) {
			if (!res.write(chunk)) {
				await once(res, 'drain');
			}
		}
	} catch (error) {
		log?.(`[vela-chat] stream ended early: ${error.message}`);
	} finally {
		res.end();
	}
}

function fail(res, status, message) {
	const body = JSON.stringify({ error: { message } });
	res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
	res.end(body);
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', chunk => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('body too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function once(emitter, event) {
	return new Promise(resolve => emitter.once(event, resolve));
}
