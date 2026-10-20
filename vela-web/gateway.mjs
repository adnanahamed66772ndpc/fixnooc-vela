#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Vela Web gateway.
 *
 * Puts a username/password login in front of the Vela web server, which itself
 * only listens on loopback. Everything here is stdlib: no dependencies to audit.
 */

import { createServer, request as httpRequest } from 'node:http';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';
import { chatConfigFromEnv, handleChatCompletions } from './chat-route.mjs';
import { DshBridge, dshConfigFromEnv } from './dsh-bridge.mjs';
import { handleDshPrompt } from './dsh-route.mjs';

const root = dirname(fileURLToPath(import.meta.url));

loadDotEnv(join(root, '.env'));

const config = {
	host: process.env.VELA_GATEWAY_HOST || '0.0.0.0',
	port: Number(process.env.VELA_GATEWAY_PORT || 8080),
	upstreamHost: process.env.VELA_UPSTREAM_HOST || '127.0.0.1',
	upstreamPort: Number(process.env.VELA_UPSTREAM_PORT || 8081),
	username: process.env.VELA_USERNAME || '',
	passwordHash: process.env.VELA_PASSWORD_HASH || '',
	sessionSecret: process.env.VELA_SESSION_SECRET || '',
	sessionHours: Number(process.env.VELA_SESSION_HOURS || 12),
	secureCookie: process.env.VELA_SECURE_COOKIE === 'true',
	trustProxy: process.env.VELA_TRUST_PROXY === 'true',
};

const chatConfig = chatConfigFromEnv(process.env);
const dshBridge = new DshBridge(dshConfigFromEnv(process.env), message => console.log(message));

const COOKIE = 'vela_session';
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

for (const key of ['username', 'passwordHash', 'sessionSecret']) {
	if (!config[key]) {
		console.error(`[vela-web] missing ${envNameFor(key)} — run: node vela-web/set-password.mjs <username>`);
		process.exit(1);
	}
}

const loginTemplate = readFileSync(join(root, 'login.html'), 'utf8');

/** Failed attempts per client address, so a loud guesser gets shut out. */
const attempts = new Map();

const server = createServer((req, res) => {
	const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

	if (url.pathname === '/vela-health') {
		return send(res, 200, 'text/plain; charset=utf-8', 'ok');
	}

	if (url.pathname === '/logout') {
		res.setHeader('Set-Cookie', cookieHeader('', 0));
		return redirect(res, '/login');
	}

	if (url.pathname === '/login') {
		if (req.method === 'GET') {
			if (readSession(req)) {
				return redirect(res, '/');
			}
			return sendLogin(res, 200, null, url.searchParams.get('next'));
		}
		if (req.method === 'POST') {
			return handleLogin(req, res);
		}
		res.setHeader('Allow', 'GET, POST');
		return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
	}

	if (!readSession(req)) {
		// Asset and API requests get a clean 401 rather than an HTML redirect they
		// cannot follow; only navigations are bounced to the login page.
		if (req.headers['sec-fetch-mode'] === 'navigate' || acceptsHtml(req)) {
			return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
		}
		return send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized');
	}

	// Signed in from here on, so the chat backend's keys never leave this process.
	if (url.pathname === '/vela-chat/dsh') {
		handleDshPrompt(req, res, dshBridge, message => console.log(message))
			.catch(err => {
				console.error(`[vela-dsh] unhandled: ${err.message}`);
				if (!res.headersSent) {
					send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
				} else {
					res.destroy();
				}
			});
		return;
	}

	if (url.pathname === '/vela-chat/completions') {
		handleChatCompletions(req, res, chatConfig, message => console.log(message))
			.catch(err => {
				console.error(`[vela-chat] unhandled: ${err.message}`);
				if (!res.headersSent) {
					send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
				} else {
					res.destroy();
				}
			});
		return;
	}

	proxyRequest(req, res);
});

// The workbench talks to the extension host over WebSockets; they need the same gate.
server.on('upgrade', (req, socket, head) => {
	if (!readSession(req)) {
		socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
		return socket.destroy();
	}
	proxyUpgrade(req, socket, head);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		dshBridge.dispose();
		process.exit(0);
	});
}

server.on('clientError', (_err, socket) => {
	if (socket.writable) {
		socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
	}
});

server.listen(config.port, config.host, () => {
	console.log(`[vela-web] listening on http://${config.host}:${config.port}`);
	console.log(`[vela-web] proxying to http://${config.upstreamHost}:${config.upstreamPort}`);
	if (dshBridge.configured) {
		console.log('[vela-web] DSH agent: /vela-chat/dsh');
	} else {
		console.log('[vela-web] DSH not configured — /vela-chat/dsh will answer 503');
	}
	if (chatConfig.llmBaseUrl) {
		console.log(`[vela-web] chat backend: ${chatConfig.llmBaseUrl}`
			+ (chatConfig.router.apiKey ? ' (Jev routing on)' : ' (Jev routing off, no TYPESAFE_API_KEY)'));
	} else {
		console.log('[vela-web] chat backend not configured — /vela-chat/completions will answer 503');
	}
	if (!config.secureCookie) {
		console.warn('[vela-web] cookies are not Secure — put TLS in front before using this over the internet');
	}
});

// --- login ------------------------------------------------------------------

function handleLogin(req, res) {
	const client = clientAddress(req);
	const lock = lockoutFor(client);
	if (lock > 0) {
		return sendLogin(res, 429, `Too many failed attempts. Try again in ${Math.ceil(lock / 60000)} minute(s).`, null);
	}

	readBody(req, 8 * 1024).then(body => {
		if (body === null) {
			return sendLogin(res, 413, 'That request was too large.', null);
		}

		const form = new URLSearchParams(body);
		const username = (form.get('username') || '').trim();
		const password = form.get('password') || '';
		const next = form.get('next');

		if (!verifyCredentials(username, password)) {
			recordFailure(client);
			const left = MAX_ATTEMPTS - (attempts.get(client)?.count || 0);
			const hint = left > 0 && left <= 3 ? ` ${left} attempt(s) left.` : '';
			console.warn(`[vela-web] failed sign-in for "${username}" from ${client}`);
			return sendLogin(res, 401, `Incorrect username or password.${hint}`, next);
		}

		attempts.delete(client);
		console.log(`[vela-web] signed in: ${username} from ${client}`);
		res.setHeader('Set-Cookie', cookieHeader(createSession(username), config.sessionHours * 3600));
		redirect(res, safeNext(next));
	}).catch(() => sendLogin(res, 400, 'Could not read that request.', null));
}

function verifyCredentials(username, password) {
	// Both branches run so a wrong username costs the same time as a wrong password.
	const userOk = constantTimeEquals(username, config.username);
	const passOk = verifyPasswordHash(password, config.passwordHash);
	return userOk && passOk;
}

function verifyPasswordHash(password, stored) {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') {
		console.error('[vela-web] VELA_PASSWORD_HASH is malformed — regenerate it with set-password.mjs');
		return false;
	}

	const [, n, r, p, saltHex, hashHex] = parts;
	const salt = Buffer.from(saltHex, 'hex');
	const expected = Buffer.from(hashHex, 'hex');
	try {
		const actual = scryptSync(password, salt, expected.length, {
			N: Number(n),
			r: Number(r),
			p: Number(p),
			maxmem: 256 * 1024 * 1024,
		});
		return timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

// --- sessions ---------------------------------------------------------------

function createSession(username) {
	const payload = Buffer.from(JSON.stringify({
		u: username,
		exp: Date.now() + config.sessionHours * 3600 * 1000,
		jti: randomBytes(8).toString('hex'),
	})).toString('base64url');
	return `${payload}.${signPayload(payload)}`;
}

function readSession(req) {
	const token = parseCookies(req.headers.cookie)[COOKIE];
	if (!token) {
		return null;
	}

	const dot = token.lastIndexOf('.');
	if (dot < 1) {
		return null;
	}

	const payload = token.slice(0, dot);
	if (!constantTimeEquals(token.slice(dot + 1), signPayload(payload))) {
		return null;
	}

	try {
		const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		return session.exp > Date.now() ? session : null;
	} catch {
		return null;
	}
}

function signPayload(payload) {
	return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

function cookieHeader(value, maxAgeSeconds) {
	const bits = [
		`${COOKIE}=${value}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${maxAgeSeconds}`,
	];
	if (config.secureCookie) {
		bits.push('Secure');
	}
	return bits.join('; ');
}

// --- proxy ------------------------------------------------------------------

function proxyRequest(req, res) {
	const upstream = httpRequest({
		host: config.upstreamHost,
		port: config.upstreamPort,
		method: req.method,
		path: req.url,
		headers: forwardedHeaders(req),
	}, upstreamRes => {
		res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
		upstreamRes.pipe(res);
	});

	upstream.on('error', err => {
		console.error(`[vela-web] upstream error: ${err.message}`);
		if (!res.headersSent) {
			send(res, 502, 'text/html; charset=utf-8', upstreamDownPage());
		} else {
			res.destroy();
		}
	});

	req.on('aborted', () => upstream.destroy());
	req.pipe(upstream);
}

function proxyUpgrade(req, socket, head) {
	socket.setNoDelay(true);

	const upstream = netConnect(config.upstreamPort, config.upstreamHost, () => {
		const headers = forwardedHeaders(req);
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (const [name, value] of Object.entries(headers)) {
			for (const single of Array.isArray(value) ? value : [value]) {
				lines.push(`${name}: ${single}`);
			}
		}
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (head?.length) {
			upstream.write(head);
		}
		upstream.pipe(socket);
		socket.pipe(upstream);
	});

	upstream.on('error', err => {
		console.error(`[vela-web] upgrade error: ${err.message}`);
		socket.destroy();
	});
	socket.on('error', () => upstream.destroy());
}

function forwardedHeaders(req) {
	const headers = { ...req.headers };
	// Don't leak the session cookie upstream; the workbench has no use for it.
	const cookies = parseCookies(headers.cookie);
	delete cookies[COOKIE];
	const rest = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
	if (rest) {
		headers.cookie = rest;
	} else {
		delete headers.cookie;
	}

	headers['x-forwarded-for'] = clientAddress(req);
	headers['x-forwarded-proto'] = config.secureCookie ? 'https' : 'http';
	return headers;
}

// --- helpers ----------------------------------------------------------------

function sendLogin(res, status, error, next) {
	const html = loginTemplate
		.replace('<!--ERROR_SLOT-->', error ? errorMarkup(error) : '')
		.replace('<!--NEXT_SLOT-->', escapeHtml(safeNext(next)));

	res.setHeader('Cache-Control', 'no-store');
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'no-referrer');
	send(res, status, 'text/html; charset=utf-8', html);
}

function errorMarkup(message) {
	return `<div class="alert" role="alert" aria-live="assertive">`
		+ `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">`
		+ `<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5"/><path d="M12 16.3h.01"/></svg>`
		+ `<span>${escapeHtml(message)}</span></div>`;
}

function upstreamDownPage() {
	return '<!doctype html><meta charset="utf-8"><title>Vela is starting</title>'
		+ '<body style="margin:0;height:100vh;display:grid;place-items:center;background:#070b14;'
		+ 'color:#e6e8eb;font:15px/1.6 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif">'
		+ '<div style="text-align:center"><h1 style="font-size:19px;font-weight:600;margin:0 0 6px">'
		+ 'Vela server is not responding</h1><p style="color:#9aa1ab;margin:0">'
		+ 'It may still be starting up. This page retries automatically.</p></div>'
		+ '<script>setTimeout(function(){location.reload();},4000)</script>';
}

/** Only same-origin paths, so ?next= can't be turned into an open redirect. */
function safeNext(next) {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) {
		return '/';
	}
	return next;
}

function lockoutFor(client) {
	const record = attempts.get(client);
	if (!record || record.count < MAX_ATTEMPTS) {
		return 0;
	}
	const remaining = record.until - Date.now();
	if (remaining <= 0) {
		attempts.delete(client);
		return 0;
	}
	return remaining;
}

function recordFailure(client) {
	const record = attempts.get(client) || { count: 0, until: 0 };
	record.count += 1;
	record.until = Date.now() + LOCKOUT_MS;
	attempts.set(client, record);

	if (attempts.size > 5000) {
		for (const [key, value] of attempts) {
			if (value.until < Date.now()) {
				attempts.delete(key);
			}
		}
	}
}

function clientAddress(req) {
	if (config.trustProxy) {
		const forwarded = req.headers['x-forwarded-for'];
		if (typeof forwarded === 'string' && forwarded) {
			return forwarded.split(',')[0].trim();
		}
	}
	return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', chunk => {
			size += chunk.length;
			if (size > limit) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function parseCookies(header) {
	const out = {};
	if (!header) {
		return out;
	}
	for (const pair of header.split(';')) {
		const eq = pair.indexOf('=');
		if (eq > 0) {
			out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
		}
	}
	return out;
}

function constantTimeEquals(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	if (left.length !== right.length) {
		// Still do the work, then fail: length alone shouldn't be a fast path.
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

function acceptsHtml(req) {
	return (req.headers.accept || '').includes('text/html');
}

function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function send(res, status, type, body) {
	res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
	res.end(body);
}

function redirect(res, location) {
	res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
	res.end();
}

function envNameFor(key) {
	return 'VELA_' + key.replace(/[A-Z]/g, c => '_' + c).toUpperCase();
}

function loadDotEnv(file) {
	if (!existsSync(file)) {
		return;
	}
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq < 1) {
			continue;
		}
		const name = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!(name in process.env)) {
			process.env[name] = value;
		}
	}
}
