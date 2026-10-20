/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `POST /vela-chat/dsh` — one agent turn, streamed as server-sent events.
 *
 * Body: `{ message: string, sessionId?: string, reasoningEffort?: string }`
 * The first event names the session so the client can continue the conversation.
 */

export async function handleDshPrompt(req, res, bridge, log) {
	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		return fail(res, 405, 'Method Not Allowed');
	}

	if (!bridge.configured) {
		return fail(res, 503, 'DSH is not configured. Set VELA_DSH_BIN in vela-web/.env.');
	}

	let body;
	try {
		body = JSON.parse(await readBody(req, 1024 * 1024));
	} catch {
		return fail(res, 400, 'Expected a JSON body.');
	}

	const message = typeof body?.message === 'string' ? body.message.trim() : '';
	if (!message) {
		return fail(res, 400, 'Expected a non-empty "message".');
	}

	let sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
	try {
		if (!sessionId) {
			const created = await bridge.newSession();
			sessionId = created.sessionId;
			log?.(`[vela-dsh] new session ${sessionId}`);
		}
		if (body.reasoningEffort) {
			await bridge.setReasoningEffort(sessionId, body.reasoningEffort);
		}
	} catch (error) {
		// Starting DSH or opening a session failed, so nothing has streamed yet.
		return fail(res, 502, error.message);
	}

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		'Connection': 'keep-alive',
		'X-Accel-Buffering': 'no',
	});

	const write = (event, data) => {
		if (!res.writableEnded) {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		}
	};

	write('vela.session', { sessionId, agent: bridge.agentInfo });

	// If the client goes away mid-turn, stop the agent rather than let it run on.
	let aborted = false;
	req.on('close', () => {
		if (!res.writableEnded) {
			aborted = true;
			bridge.cancel(sessionId);
		}
	});

	try {
		const stopReason = await bridge.prompt(sessionId, message, event => write(event.type, event));
		if (!aborted) {
			write('vela.done', { stopReason });
		}
	} catch (error) {
		log?.(`[vela-dsh] turn failed: ${error.message}`);
		write('error', { message: error.message });
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
