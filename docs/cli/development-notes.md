# Specbook CLI development notes

Investigations and verification records from building the CLI. The user guide is [README.md](README.md).

## Single-executable investigation

The executable probe used Bun 1.3.14 and the repository's Playwright 1.62.0. A direct `bun build --compile` failed on optional `chromium-bidi` imports; excluding those imports produced a binary that successfully launched Chromium and read a page. That wasn't enough for the Spec runtime: it resolves `@playwright/test/cli` from disk, writes test modules and fixtures to disk, and starts Playwright with `process.execPath`. In a Bun-compiled program, that path is the compiled application; the runner probe invoked itself recursively instead of the Playwright CLI. The probe processes were stopped.

Node SEA also requires bundling or extracting runtime modules and assets. The current Playwright child-process protocol needs a dedicated embedded-runner entry mode plus filesystem extraction before either option can support the shared runner reliably. Specbook distributes an installable tarball served by its backend. Windows and macOS binary packaging remain unverified. References: [Bun executable documentation](https://bun.sh/docs/bundler/executables) and [Node SEA documentation](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html).

## Scope

The CLI supports local verification, remote publishing, CI and private-network runners. Conversations still use the installed local coding agent in connected workspaces. Live agent exploration inside runner environments remains outside this phase.

Remote vault synchronization, encrypted credential storage and additional browsers remain outside this task. Agent availability, authentication, subscription limits and supported CLI flags depend on the installed coding-agent versions; unsupported restricted-mode configurations fail without granting broader tools. Windows and macOS conversation behavior remains untested.

## Private-network runner verification

The 2026-10-12 checks used the worktree API on port 4200, temporary UI instances on ports above 4200, and a private static application on port 4210. Storage and local credential profiles stayed under `/tmp/specbook-runner-verification`. Ports 4000/4001 and the main checkout's storage stayed untouched.

```text
manual SauceDemo run → passed; 3 step screenshots; waiting Spec promoted
specbook ci --environment Production → exit 0; quality gate passed
deploy signal --environment Production → runner run passed
kill runner during private-page run → lease expired → restarted runner passed same batch
missing-local.password → credentials error naming profile and field
server credential profiles → 0; storage/output secret scan → 261 files, 0 findings
```

The independent CLI runner check exercised concurrency 2, 38 heartbeats, graceful SIGTERM, a passing private login, missing local credentials, and nonsecret failure video. A deliberate failure through the hosted runner also retained two step screenshots, a 20,851-byte failure video, the failed step, diagnostics and error context. The existing backend suites passed 339 of 340 tests; only the allowed OpenAI subscription callback-port test failed. Cases in those suites cover token scopes and revocation, group matching, stale upload rejection, restart recovery, cancellation, isolated proposed repairs, and an offline runner retry that leaves other projects' failure processing active. Live model-based evidence review wasn't exercised because these instances had no model configured.

Playwright screenshots under `/tmp/specbook-runner-shots/` cover runner tokens, environment executor selection, the exploration notice and runner evidence on the Spec page. Token creation showed the value once, reload hid it, and revocation returned 401. Desktop and 390px checks found no page overflow. A scan of the server database, repository, run artifacts and captured outputs found none of the configured runner/CI/personal tokens or local credential values.

## Serve verification

The CLI tarball installed under `/tmp/specbook-serve-installed` started the full product with `--ui` on ports 4280/4281. A simulated versioned release on port 4284 supplied the standalone archive and checksum to another instance on 4282/4283. The next launch reused the cache without another download; an incorrect checksum failed before server startup. Each successful instance served `/api/health` and `/api/cli/specbook.tgz` with HTTP 200 and shut down cleanly. The generated CLI download also installed independently and returned version 0.1.0.

```text
packed CLI + --ui → ready, uiSource=explicit, health 200
simulated release + checksum → ready, uiSource=download, health 200
same SPECBOOK_HOME → ready, uiSource=cache, one total download
wrong checksum → exit 1, checksum verification failed
browser /setup → administrator created
hosted private-page Spec → passed, 2 step screenshots
Docker process → specbook serve --ui /app/ui --port 4001 --host 0.0.0.0 --data /data
Docker /api/health → 200; container health → healthy
```

The browser signup and hosted Spec check used ports 4230/4231 and a private static page on 4232, with data under `/tmp/specbook-serve-product`. The Docker image built locally as `specbook-runner-serve:verification`, kept its existing internal ports, and exposed only host port 4241; its temporary volume stayed under `/tmp`. An early dereferenced standalone archive lost pnpm dependency resolution; packaging now copies the traced dependencies into normal Node lookup paths, and the corrected archive passed plain Node startup, CSS/font/logo delivery, packed serve and Docker checks. No release, package, branch or container image was published.

`pnpm -r build` and `npx tsc --noEmit` in backend, frontend, CLI and runtime passed. Transcripts live under `/tmp/specbook-runner-verification`, `/tmp/specbook-serve-packed-check-E05PFS` and `/tmp/specbook-serve-product`; UI screenshots include `serve-packed-spec.png`. Linux is verified here; native Windows/macOS hosting and actual GitHub release publication remain unverified.

## Server package verification

The 2026-10-12 follow-up verified the public CLI download with a separate backend on `127.0.0.1:4100`, frontend on `127.0.0.2:4101` and storage under `/tmp/specbook-cli-delivery-storage`. Without the tarball, both backend `/cli/specbook.tgz` and frontend `/api/cli/specbook.tgz` returned 404 with the exact build command. After `pnpm --dir apps/cli pack --out ../backend/dist/specbook.tgz`, both anonymous downloads returned 200 and matched the local archive's SHA-256 hash.

`docker build -t specbook-connect-cli:verification .` passed. The runtime image contained the same tarball bytes, and its bundled backend served them with 200 and `application/gzip` before creating any admin account. The build context includes the CLI documentation needed by `prepack` while excluding the other documentation files.

This exact command ran from a disposable workspace with a new npm cache at `/tmp/specbook-cli-url-cache-KqKLge` and `SPECBOOK_URL=http://127.0.0.2:4101/api`:

```sh
npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci --environment Production --spec-ids "$SPECBOOK_SPEC_IDS" --json
```

It exited 0, reported a passing remote browser run and wrote the self-contained HTML report, JUnit and Markdown summary. The npm lockfile recorded `http://127.0.0.2:4101/api/cli/specbook.tgz` as the package source. The project token stayed in the environment; the download needed no token. Logs and the command transcript are under `/tmp/specbook-cli-delivery-verification/`.

`pnpm -r build` and backend, frontend and CLI `npx tsc --noEmit` passed. The existing backend tests finished with 333 of 334 passing; only the allowed OpenAI sign-in test failed because callback port 1455 was occupied. Download tests cover public access, binary content, missing-package guidance and rejection of uploads. All five pipeline snippets select the server package, and a repository scan found no instructions that select the CLI by its registry name.

## Remote phase verification

The 2026-10-12 verification used this worktree's backend on `127.0.0.1:4100`, its production frontend on `127.0.0.2:4101`, storage at `/tmp/specbook-connect-storage`, and disposable CLI home/workspace directories under `/tmp`. An existing listener occupied `127.0.0.1:4101`; ports 4000/4001 and the main checkout's data stayed untouched. Setup created an admin, the SauceDemo project and its Production environment. Browser checks also created and revoked a separate personal token, confirmed its one-time display and last-use metadata, and received 401 after revocation.

| Check | Observed result |
| --- | --- |
| Login, connect and local run | Login resolved the frontend `/api` URL; `servers.json` had mode 0600. The sign-in Spec passed against a localhost fixture on port 4110. |
| Publish | A matching saved run allowed publication; Git recorded `Connect Admin <connect@example.test>` and `spec: publish 1 from CLI`. The API returned `awaiting_deploy`. Publication before running was rejected. |
| Waiting failure and promotion | Wrong remote credentials produced a failed run with `awaitingDeploy: true`, `automationPending: false`, zero triage jobs, zero Inbox items and zero failing checks. Restoring the credentials produced a passing run and a passing Spec. |
| Revision conflict and pull | A server edit made stale publication return `revision_conflict`. Pull downloaded the edit, then preserved a new unpublished local edit as `local_changes`. `publish --run` succeeded after verification. |
| CI | Waiting failure: exit 0, zero gate failures, one JUnit skip. Passing Spec: exit 0. Ordinary failing Spec: exit 1, one gate failure and one JUnit failure. Every case wrote HTML, JUnit and Markdown artifacts. |
| Package and UI | An independently installed tarball exposed all commands and ran CI through `npx`. Playwright screenshots cover access tokens, the Specs list, Spec page and overview, including the waiting status. |

`pnpm -r build` and `npx tsc --noEmit` in all four touched packages passed. The existing backend suites finished with 332 of 333 tests passing; only the allowed OpenAI subscription sign-in test failed because callback port 1455 was occupied. The CI suite separately passed all 14 tests, including provider comments, token separation, GET retries and historical waiting reports. A scan of the verification transcripts, reports and local run text artifacts found no configured token or credential values.

Transcripts, reports and check logs are under `/tmp/specbook-connect-verification/`; screenshots are under `/tmp/specbook-connect-shots/`. The development frontend's custom temporary output directory produced an invalid bundle during the first browser attempt; the production build completed the UI verification. No model was configured for these live runs, so model evidence review wasn't exercised. No package, branch or container image was published, and hosted pipeline execution remains unverified.

## Conversation verification

`pnpm -r build` and `npx tsc --noEmit` in all four packages passed. Existing backend tests again finished with 326 of 327 passing; the only failure was the allowed OpenAI subscription sign-in test involving callback port 1455.

The adapter probe used Claude Code 2.1.296 and Codex 0.162.1 with a disposable loopback model provider. First and resumed turns retained the same brain session id and a marker from earlier history. Both requests exposed the same seventeen Specbook tools; Codex also exposed its three inert MCP resource wrappers. No model requests in that probe left the loopback provider.

Initialization in `/tmp/specbook-chat-skill-cWyOgs` installed identical conversation instructions in `.specbook/SKILL.md`, `.agents/skills/specbook/SKILL.md` and `.claude/skills/specbook/SKILL.md`. The check confirmed all six status branches and the ignored `chats/` directory. It didn't access the real user configuration.

Real authenticated conversations ran against `https://www.saucedemo.com` from disposable workspaces and `SPECBOOK_HOME` directories under `/tmp/specbook-phase2b`. The short transcripts were:

| Brain and conversation | Conversation | Result |
| --- | --- | --- |
| Claude, `c-cdc5dc39` | Request successful sign-in and checkout with an undecided success condition → `waiting_for_reply`: overview or final order confirmation? → answer final confirmation → `waiting_for_selection`: sign-in and checkout Specs → select `1` → `working` after the 45-second wait → `--wait` → `done`. | `specs/authentication/sign-in-valid-credentials` passed on its first run, with evidence and an HTML report. |
| Claude, `c-423d61b2` | Request sign-in with no local `shop` profile and `--no-wait` → `working` → send another message while busy → `working`, without another turn → `--wait` → `needs_credentials` for `shop.username` and `shop.password`, with `specbook credentials add shop` → add through stdin → reply `done` → `done`. | `specs/authentication/sign-in-valid-user` passed on its first run. |
| Codex, `c-5bc343c7` | Request sign-in and checkout with an undecided success condition → `waiting_for_reply`: overview or order confirmation? → answer final confirmation with `--no-wait` → `working` → a second message while busy returns `working` → `--wait` → `waiting_for_selection`: sign-in and checkout Specs → select `1` → `done`. | `specs/sign-in/shop-sees-products` passed on its first run. |
| Codex, `c-49f883dc` | Request sign-in with no local `sauce` profile → `needs_credentials` for `sauce.username` and `sauce.password`, with `specbook credentials add sauce` → add through stdin → reply `done` → `done`. | `specs/sign-in/successful-sign-in` passed on its first run. |
| Claude, `c-d98553fc` | Request existing sign-in coverage plus a new Backpack cart Spec → `waiting_for_selection` → select `1,2` with `--no-wait` → `working` → a 45-second `--wait` returns `working` → another `--wait` → `done`. | Existing sign-in returned `created: false`; new `specs/cart/add-backpack-to-cart` returned `created: true`. Both passed on their first run, with separate paths mapped to proposals `1` and `2`. |

`chats --json` listed these conversations with their final status, update time, agent and created Specs. Both agents retained their brain sessions and removed copied authentication files after each turn. A final scan of 174 text artifacts found no configured credential values in Specs, replies, reports or brain transcripts. SauceDemo displays demo credentials before any local profile exists; that exposed the need to redact saved brain history once those values become known. Codex resumed successfully after that redaction and verified its existing Spec again, unchanged, with one run under a fresh turn budget. Full CLI replies and paths are in `/tmp/specbook-phase2b/claude-verification.jsonl`, `/tmp/specbook-phase2b/codex-verification.jsonl` and `/tmp/specbook-phase2b/claude-multi.jsonl`; reports and per-step evidence live below each workspace's `.specbook/runs/`.

The temporary `/tmp/specbook-phase2b/recovery-check.mts` check passed typed-outcome recovery after a worker crash, orphan brain termination, authentication cleanup and empty-lock recovery. It also confirmed that invalid messages leave no orphan chat, incomplete chat directories don't break listings, and a credential matching a status string doesn't corrupt the structural status. These checks didn't add a repository test suite.

An initial background check across separate sandbox tool calls lost its worker when this verification sandbox reaped descendants at the tool-call boundary. The repeated check kept a harness alive while each CLI command exited, then used `--wait` to retrieve the detached worker's result. This established that the worker continues after the CLI exits within the harness; the sandbox boundary affected the first verification attempt.

## Earlier phase verification

`pnpm -r build` and each package's `tsc --noEmit` passed. Existing backend tests finished with 326 of 327 passing; the only failure was the documented OpenAI subscription sign-in test because callback port 1455 was occupied.

The built CLI and an independently installed package tarball ran the handwritten login Specs against SauceDemo and a localhost page. Checks covered initialization, scaffolding, credentials add/list/remove with a 0600 store, static validation, fresh signed-out runs, evidence, and self-contained reports. A deliberate nonsecret failure produced its per-step screenshot, failed-step context and failure video; secret runs disabled video and masked inputs, reflected text and shadow-root text. Text artifacts contained none of the configured credential values.

Browser checks on both targets covered persistent sessions, snapshot refs, secret filling, inspection, clicks, origin blocking, cleanup, and locator counts of zero, one and several matches. Credentials containing quotes and backslashes also stayed out of valid JSON responses.

Real authenticated Codex created a Cart Spec in one run. The final restricted Codex and Claude adapters each verified that existing Spec in one run with no writes. The loopback request-inventory script confirmed their available tools and checked credential redaction, forbidden writes, path traversal, symlinks and the three-run limit after an MCP restart. Timeout and cancellation checks returned the expected statuses and killed descendants that ignored SIGTERM. Run that unbilled adapter probe with `pnpm --dir apps/cli exec tsx scripts/check-agent-wiring.mjs`; it needs the supported agents installed and a local login or API key so the adapters can initialize authentication, while all model requests go to its loopback stub.

All disposable workspaces and credential stores used `/tmp`, and the checks left the developer servers on ports 4000 and 4001 alone. Docker wiring was updated for the shared runtime; this environment did not build a container image. The CLI tarball was packed and installed locally, and `npx --package <local-tarball> specbook --version --json` passed. The installed tarball also verified the existing Cart Spec through Codex in one run with no writes. Nothing was published. Windows and macOS behavior remains untested.
