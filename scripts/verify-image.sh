#!/usr/bin/env bash
set -euo pipefail

image="${1:?Usage: bash scripts/verify-image.sh <image-reference>}"
container="specbook-verify-$$"
cleanup() {
    status=$?
    trap - EXIT
    if [[ "$status" != 0 ]]; then docker logs "$container" >&2 || true; fi
    docker rm --force --volumes "$container" >/dev/null 2>&1 || true
    exit "$status"
}
trap cleanup EXIT

docker run --detach --name "$container" --shm-size=1g --mount type=volume,destination=/app/apps/backend/storage --publish 127.0.0.1::4001 "$image" >/dev/null
port="$(docker port "$container" 4001/tcp | head -n 1)"
origin="http://$port"
ready=false
for ((attempt = 0; attempt < 90; attempt++)); do
    if curl --fail --silent --connect-timeout 2 --max-time 10 "$origin/api/health" >/dev/null; then ready=true; break; fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then break; fi
    sleep 2
done
[[ "$ready" == true ]]
curl --fail --silent --connect-timeout 2 --max-time 10 "$origin/api/setup/status" | python3 -c 'import json,sys; assert json.load(sys.stdin)["needsAdmin"] is True'
curl --fail --silent --connect-timeout 2 --max-time 10 "$origin/api/ready" | python3 -c 'import json,sys; assert json.load(sys.stdin)["ok"] is True'
curl --fail --silent --connect-timeout 2 --max-time 10 "$origin/setup" >/dev/null

# Exercise each pinned Chromium, not just the presence of its executable.
docker exec --user node --workdir /app/apps/backend "$container" node --input-type=module -e '
    import { createRequire } from "node:module";
    import assert from "node:assert/strict";
    const require = createRequire(import.meta.url);
    const mcpRequire = createRequire(require.resolve("@playwright/mcp/package.json"));
    for (const browserType of [require("@playwright/test").chromium, mcpRequire("playwright").chromium]) {
        const browser = await browserType.launch({ headless: true });
        try {
            const page = await browser.newPage();
            await page.goto("http://127.0.0.1:4001/setup");
            await page.getByLabel("Name", { exact: true }).waitFor();
            assert.equal(await page.getByLabel("Email", { exact: true }).count(), 1);
            assert.equal(await page.getByLabel("Password", { exact: true }).count(), 1);
        } finally { await browser.close(); }
    }
'
echo "Fresh installation and both Chromium builds passed: $image"
