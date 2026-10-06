#!/usr/bin/env bash
set -euo pipefail

storage="${SPECBOOK_STORAGE_DIR:-/app/apps/backend/storage}"
app_user="node"

# Started as root (the image default): make the storage volume writable for the
# unprivileged user, then re-run this script as that user. Volumes created by
# earlier root-only images are owned by root, so ownership is fixed once here.
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
    # A requested stop is a clean exit, not a failure.
    exit 0
}

trap stop_processes EXIT
trap on_signal TERM INT

# The backend applies database migrations itself before it starts listening.
cd /app/apps/backend
node dist/index.js &
backend=$!

cd /app/apps/frontend
node_modules/.bin/next start -p 4001 -H 0.0.0.0 &
frontend=$!

set +e
wait -n "$backend" "$frontend"
status=$?
set -e
exit "$status"
