#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Fixnooc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Writes vela-web/.env with the sign-in credentials for the gateway.
 *
 *   node vela-web/set-password.mjs <username>              # prompts, hidden input
 *   node vela-web/set-password.mjs <username> --generate   # makes a strong password
 */

import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = dirname(fileURLToPath(import.meta.url));
const envFile = join(root, '.env');

// Interactive work factor: ~100ms on a small VPS, plenty for a single-user login.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 256 * 1024 * 1024 };

const [username, flag] = process.argv.slice(2);

if (!username) {
	console.error('usage: node vela-web/set-password.mjs <username> [--generate]');
	process.exit(1);
}

const password = flag === '--generate' ? generatePassword() : await promptPassword();

if (password.length < 8) {
	console.error('Password must be at least 8 characters.');
	process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, PARAMS.keylen, PARAMS);
const stored = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${hash.toString('hex')}`;

const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const keepSecret = /^VELA_SESSION_SECRET=(.+)$/m.exec(existing)?.[1];

writeFileSync(envFile, renderEnv({
	username,
	passwordHash: stored,
	// Reuse the secret when there is one, so existing sessions survive a password change.
	sessionSecret: keepSecret || randomBytes(32).toString('hex'),
	previous: existing,
}), { mode: 0o600 });

console.log(`\nSaved credentials to ${envFile} (mode 600)`);
console.log(`  username: ${username}`);
if (flag === '--generate') {
	console.log(`  password: ${password}`);
	console.log('\nStore that password now — it is hashed in .env and cannot be read back.');
}

function renderEnv({ username, passwordHash, sessionSecret, previous }) {
	const carried = ['VELA_GATEWAY_PORT', 'VELA_GATEWAY_HOST', 'VELA_UPSTREAM_PORT', 'VELA_UPSTREAM_HOST', 'VELA_SESSION_HOURS', 'VELA_SECURE_COOKIE', 'VELA_TRUST_PROXY']
		.map(key => {
			const found = new RegExp(`^${key}=(.*)$`, 'm').exec(previous);
			return found ? `${key}=${found[1]}` : null;
		})
		.filter(Boolean);

	return [
		'# Vela Web gateway credentials. Keep this file private; never commit it.',
		`# Written ${new Date().toISOString()}`,
		'',
		`VELA_USERNAME=${username}`,
		`VELA_PASSWORD_HASH=${passwordHash}`,
		`VELA_SESSION_SECRET=${sessionSecret}`,
		'',
		...(carried.length ? ['# Carried over from the previous .env', ...carried, ''] : []),
	].join('\n');
}

function generatePassword() {
	// Unambiguous alphabet: no 0/O/1/l/I to misread when typing it back.
	const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const bytes = randomBytes(24);
	return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
}

function promptPassword() {
	return new Promise(resolve => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		const stdout = process.stdout;

		// Swallow the echo so the password never lands in the scrollback.
		const write = stdout.write.bind(stdout);
		let muted = false;
		stdout.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));

		rl.question(`Password for "${username}": `, answer => {
			stdout.write = write;
			stdout.write('\n');
			rl.close();
			resolve(answer);
		});
		muted = true;
	});
}
