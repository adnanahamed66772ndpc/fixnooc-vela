# Vela Web

Runs Vela in a browser, behind a username/password login.

Two processes:

| Process | Binds | Role |
| --- | --- | --- |
| Vela server (`vela-server`) | `127.0.0.1:8081` | The editor itself: workbench, extension host, terminals |
| Gateway (`gateway.mjs`) | `0.0.0.0:8080` | Login page, sessions, reverse proxy to the server |

The editor never listens on a public interface, so an unauthenticated request
cannot reach it. The gateway has no dependencies — Node's standard library only.

## Setup

```bash
# 1. Credentials (writes vela-web/.env with a scrypt hash, mode 600)
node vela-web/set-password.mjs <username> --generate   # or omit --generate to be prompted

# 2. Build the server once
npm install
npm run gulp vscode-reh-web-linux-x64-min              # produces ../vscode-reh-web-linux-x64

# 3. Run
./vela-web/start.sh
```

Then open `http://<your-ip>:8080/`.

## Running as a service

```bash
mkdir -p ~/.config/systemd/user
cp vela-web/vela-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now vela-web
sudo loginctl enable-linger "$USER"    # survives logout and reboot
```

Logs go to `~/.vela-web.log`; `systemctl --user status vela-web` for state.

## Configuration

Everything lives in `vela-web/.env` — see [.env.example](.env.example).

| Variable | Default | Notes |
| --- | --- | --- |
| `VELA_USERNAME` | — | Required |
| `VELA_PASSWORD_HASH` | — | Required; `scrypt$N$r$p$salt$hash`, written by `set-password.mjs` |
| `VELA_SESSION_SECRET` | — | Required; 32 random bytes, signs session cookies |
| `VELA_GATEWAY_PORT` | `8080` | Public port |
| `VELA_UPSTREAM_PORT` | `8081` | Where the editor listens, loopback only |
| `VELA_SESSION_HOURS` | `12` | How long a sign-in lasts |
| `VELA_SECURE_COOKIE` | `false` | Set `true` once TLS terminates in front |
| `VELA_TRUST_PROXY` | `false` | Set `true` only behind a proxy you control, so rate limits read the real client IP |
| `VELA_WORKSPACE` | `$HOME` | Folder the editor opens |
| `VELA_SERVER_DIR` | `../vscode-reh-web-linux-x64` | Built server location |

Changing the password keeps the existing session secret, so open tabs stay
signed in. Delete `VELA_SESSION_SECRET` from `.env` and restart to boot everyone out.

## What the gateway does

- **Sessions** — an HMAC-SHA256 signed cookie (`HttpOnly`, `SameSite=Lax`), carrying
  only the username, an expiry and a random id. No server-side session store.
- **Password check** — scrypt (N=32768, r=8, p=1) with `timingSafeEqual`. A wrong
  username costs the same time as a wrong password.
- **Rate limiting** — 8 failures from one address locks it out for 15 minutes.
- **WebSockets** — proxied through the same gate, since the workbench reaches the
  extension host and terminals over them.
- **Redirects** — `?next=` only accepts same-origin paths, so it can't be aimed elsewhere.
- **Cookie hygiene** — the session cookie is stripped before proxying upstream.

## Before putting this on the open internet

The gateway speaks plain HTTP, so passwords and your editing traffic cross the
network unencrypted. Terminate TLS in front of it (Caddy, nginx, or a tunnel),
point it at `127.0.0.1:8080`, and set `VELA_SECURE_COOKIE=true` and
`VELA_TRUST_PROXY=true`. Also keep the public port closed in your cloud
firewall to everything except what you actually need.

Remember that a browser-based editor with a terminal is shell access to this
machine for whoever holds the password.
