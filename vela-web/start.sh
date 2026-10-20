#!/usr/bin/env bash
# Starts the Vela web server on loopback and the authenticating gateway on the public port.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

# shellcheck disable=SC1090
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && nvm use --silent >/dev/null 2>&1 || true

# Read one key out of .env. Never source that file: the scrypt hash is full of
# '$' and the shell would try to expand it.
env_value() {
	[ -f "$here/.env" ] || return 0
	sed -n "s/^$1=//p" "$here/.env" | tail -1
}

UPSTREAM_PORT="${VELA_UPSTREAM_PORT:-$(env_value VELA_UPSTREAM_PORT)}"
UPSTREAM_PORT="${UPSTREAM_PORT:-8081}"
SERVER_DIR="${VELA_SERVER_DIR:-$(env_value VELA_SERVER_DIR)}"
SERVER_DIR="${SERVER_DIR:-$repo/../vscode-reh-web-linux-x64}"
WORKSPACE="${VELA_WORKSPACE:-$(env_value VELA_WORKSPACE)}"
WORKSPACE="${WORKSPACE:-$HOME}"

cleanup() {
	[ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null || true
	[ -n "${gateway_pid:-}" ] && kill "$gateway_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ -x "$SERVER_DIR/bin/vela-server" ]; then
	echo "[vela-web] starting built server from $SERVER_DIR"
	"$SERVER_DIR/bin/vela-server" \
		--host 127.0.0.1 \
		--port "$UPSTREAM_PORT" \
		--without-connection-token \
		--accept-server-license-terms \
		--server-data-dir "$HOME/.vela-server" \
		--default-folder "$WORKSPACE" &
else
	echo "[vela-web] no production build found, falling back to the source tree"
	VSCODE_SERVER_PORT="$UPSTREAM_PORT" "$repo/scripts/code-server.sh" \
		--host 127.0.0.1 \
		--port "$UPSTREAM_PORT" \
		--without-connection-token &
fi
server_pid=$!

node "$here/gateway.mjs" &
gateway_pid=$!

wait -n "$server_pid" "$gateway_pid"
