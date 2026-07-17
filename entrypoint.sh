#!/usr/bin/env bash
set -euo pipefail

backend=""
frontend=""

stop_processes() {
    trap - EXIT TERM INT
    if [[ -n "$backend" ]]; then kill "$backend" 2>/dev/null || true; fi
    if [[ -n "$frontend" ]]; then kill "$frontend" 2>/dev/null || true; fi
    if [[ -n "$backend" ]]; then wait "$backend" 2>/dev/null || true; fi
    if [[ -n "$frontend" ]]; then wait "$frontend" 2>/dev/null || true; fi
}

trap stop_processes EXIT TERM INT

cd /app/apps/backend
pnpm exec drizzle-kit migrate
node dist/index.js &
backend=$!

cd /app/apps/frontend
pnpm exec next start -p 4001 -H 0.0.0.0 &
frontend=$!

set +e
wait -n "$backend" "$frontend"
status=$?
set -e
exit "$status"
