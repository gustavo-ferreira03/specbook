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
    exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- env HOME="/home/$app_user" "$0" "$@"
fi

exec specbook serve --ui /app/ui --port "${FRONTEND_PORT:-4001}" --host "${HOST:-0.0.0.0}" --data "$storage" "$@"
