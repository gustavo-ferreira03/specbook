# Configuration

Model connections, accounts, SSO, agent safety and retention live in global **Settings**. Project settings hold the application URL, credentials, Git and CI tokens, schedules and automation choices. New projects need no credentials or discovery answers before you can open them; the agent asks when it lacks access.

Environment changes take effect after restarting Specbook. The frontend uses its own `/api` endpoint for REST, artifacts, SSE and browser streaming. Set the backend address at runtime; rebuilding the image for a different public hostname is unnecessary.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPECBOOK_STORAGE_DIR` | `apps/backend/storage` | Database, repositories, credentials and evidence; the image uses `/app/apps/backend/storage` |
| `SPECBOOK_BACKEND_URL` | `http://127.0.0.1:4000` | Backend destination for the bundled frontend proxy |
| `FRONTEND_ORIGIN` | unset (CORS defaults to `http://localhost:4001`) | Allowed frontend origin for direct API requests and browser streaming; also the fallback for public links and SSO. The bundled proxy supplies its validated request origin |
| `HOST` | `127.0.0.1` | Backend bind address; the image uses `0.0.0.0` |
| `PORT` | `4000` | Backend HTTP port |
| `FRONTEND_PORT` | `4001` | Frontend port in the image |
| `SPECBOOK_ALLOWED_HOSTS` | unset | Additional comma-separated hostnames; an entry without a port permits any port |
| `SPECBOOK_PUBLIC_API_URL` | request-derived | Explicit public API base for Git clone links, including `/api` when using the bundled frontend |
| `TRUST_PROXY` | `false` | Trust forwarding headers for direct API public URLs; only enable behind a proxy you control |
| `SPECBOOK_ENCRYPTION_KEY` | unset | A 32-byte encryption key encoded as hex or padded base64 |
| `SPECBOOK_ENCRYPTION_KEY_FILE` | unset | Mounted key file; use this or the key variable, never both |
| `SPECBOOK_MAX_CONCURRENT_RUNS` | `2` | Maximum simultaneous Playwright single runs or batches |
| `SPECBOOK_MAX_CONCURRENT_JOBS` | run concurrency | Maximum simultaneous agent investigations |
| `SPECBOOK_GIT_MAX_PUSH_BYTES` | `209715200` | Maximum Git push size in bytes |
| `SPECBOOK_RETENTION_ENABLED` | enabled | Set `false` to disable hourly cleanup; manual admin cleanup remains available |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Model-provider OAuth listener address; set `0.0.0.0` inside Docker |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |

Literal IP addresses and localhost pass the host guard. Other names must match the public configuration or `SPECBOOK_ALLOWED_HOSTS`. Keep the allowlist specific; `*` disables its protection. The frontend removes incoming forwarding headers before supplying its own validated origin to the backend.

Without an external encryption key, Specbook creates a private `encryption.key` in the data directory. See [key management and rotation](operations.md#encryption-keys-and-upgrades) before changing that configuration.

`NEXT_DIST_DIR` selects a separate frontend build directory during development. `SPECBOOK_MIGRATIONS_DIR` and `SPECBOOK_OIDC_ALLOW_HTTP=1` are verification aids, not ordinary deployment settings; the latter only permits loopback HTTP identity providers.

## Optional steering

Schedules accept cron expressions in UTC. Select all checks or a subset and choose whether persistent failures should trigger investigation. A generic webhook can receive status changes.

Project automation can observe, propose, or act within the configured policy. Automatic locator fixes require an administrator to enable them globally and opt in per project. They remain limited to eligible, verified implementation changes; a behavior change always returns for review.

The screenshot setting controls images sent to the model, including existing conversation images. Screenshots remain available as local evidence when that setting is disabled. Text from page snapshots still reaches the model.
