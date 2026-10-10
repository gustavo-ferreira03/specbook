#!/usr/bin/env bash
set -euo pipefail

storage="${SPECBOOK_STORAGE_DIR:-/data}"
app_user="node"

if [[ "$(id -u)" == "0" ]]; then
    mkdir -p "$storage"
    uid="$(id -u "$app_user")"
    gid="$(id -g "$app_user")"
    if [[ "$(stat -c %u "$storage")" != "$uid" ]] || find "$storage" \! -user "$uid" -print -quit | grep -q .; then
        echo "[specbook] fixing ownership of $storage for $app_user" >&2
        chown -R "$uid:$gid" "$storage"
    fi
    export HOME="/home/$app_user"
    exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$0" "$@"
fi

backend=""
frontend=""

stop_processes() {
    trap - EXIT TERM INT
    if [[ -n "$backend" ]]; then kill "$backend" 2>/dev/null || true; fi
    if [[ -n "$frontend" ]]; then kill "$frontend" 2>/dev/null || true; fi
    if [[ -n "$backend" ]]; then wait "$backend" 2>/dev/null || true; fi
    if [[ -n "$frontend" ]]; then wait "$frontend" 2>/dev/null || true; fi
}

on_signal() {
    stop_processes
    exit 0
}

trap stop_processes EXIT
trap on_signal TERM INT

export SPECBOOK_BACKEND_URL="${SPECBOOK_BACKEND_URL:-http://127.0.0.1:${PORT:-4000}}"

cd /app/apps/backend
node dist/index.js &
backend=$!

cd /app/apps/frontend
node_modules/.bin/next start -p "${FRONTEND_PORT:-4001}" -H 0.0.0.0 &
frontend=$!

set +e
wait -n "$backend" "$frontend"
status=$?
set -e
exit "$status"
