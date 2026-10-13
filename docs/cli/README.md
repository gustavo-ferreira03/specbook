Specbook CLI: local verification and team publishing
===================================================

Specbook keeps readable behavior contracts beside restricted Playwright tests. Start a `chat` with the behavior you want covered; Specbook uses your installed, authenticated Claude Code or Codex as its brain, asks for missing details, and creates or runs Specs. The local CLI needs no Specbook server and no model configured in Specbook.

Install the latest release with Node.js 22 or newer:

```sh
npm install -g https://github.com/gustavo-ferreira03/specbook/releases/latest/download/specbook.tgz
specbook init --base-url http://localhost:3000 --agent codex
```

A team that runs a Specbook server can install the CLI that matches it from `https://specbook.example.com/api/cli/specbook.tgz` instead. Releases attach `specbook.tgz` with a `.sha256` checksum.

The server serves its own CLI tarball without authentication at `/api/cli/specbook.tgz` through the frontend, or `/cli/specbook.tgz` on the backend. The package bundles the shared runtime, its test fixtures, report fonts, writing rules, this document at `dist/README.md` and the Kubernetes examples at `dist/examples`; it doesn't need the monorepo after installation.

To build this checkout and run the CLI directly:

```sh
pnpm install
pnpm -r build
node apps/cli/dist/index.js --help
# From another directory:
node /absolute/path/to/specbook/apps/cli/dist/index.js --help
```

Docker builds and packs the CLI into `apps/backend/dist/specbook.tgz`. A development server returns 404 from the download route until that file exists. Generate it from the repository root, then install the same tarball for local use:

```sh
pnpm --filter @specbook/runtime build
mkdir -p apps/backend/dist
pnpm --dir apps/cli pack --out ../backend/dist/specbook.tgz
npm install -g ./apps/backend/dist/specbook.tgz
cd /path/to/your/app
specbook init --base-url http://localhost:3000 --agent codex
```

Packing runs the CLI build through its `prepack` script. You can also run the downloaded package without installing it globally with `npx --yes --package="https://specbook.example.com/api/cli/specbook.tgz" specbook --help`. The executable is named `specbook`; the tarball URL selects this project's package.

Chromium downloads on the first browser command if it isn't installed. On Linux, missing platform libraries may require `npx playwright install-deps chromium`. By default each command prints a colored summary with the next commands to run (built on commander, @clack/prompts and picocolors; `NO_COLOR` disables color). Spinners and prompts go to stderr. `--json` emits one JSON result on stdout, including errors, and never prompts. Failed checks, runs, or conversation turns return a nonzero exit status.

Each command
------------

| Command | Behavior |
| --- | --- |
| `init --base-url <url> [--agent claude\|codex]` | Create the workspace, detect installed agents, and install coding-agent instructions. Without `--base-url`, prompt on a terminal. Existing config and agent skill files aren't overwritten. |
| `login <server-url> [--stdin]` | Verify a personal access token and save this server login outside the workspace. Use a hidden terminal prompt or stdin. The most recent login becomes the default. |
| `logout [url]` | Remove a saved login; default to the most recent server. This doesn't revoke the token on the server. |
| `connect [project] [--server <url>] [--environment <name>]` | Link the workspace to a visible project by id, name or interactive selection. Default to the latest server login and the project's Production environment. |
| `pull` | Download remote features and Specs with their revisions. Preserve unpublished local edits and report conflicts with exit status 1. |
| `publish [spec\|feature] [--run] [--environment <name>]` | Publish selected Specs after a passing local run of their exact current files. Check their base revisions and start changed Specs as awaiting deployment in one environment. |
| `ci [--environment <name>] [--base-url <url>]` | Trigger remote acceptance checks with a project CI token, wait for results and write HTML, JUnit and Markdown artifacts. |
| `runner --allow-origin <origin> [--url <server>] [--concurrency <count>] [--once | --drain-after <count>] [--secrets-command <command>]` | Claim queued Specs over outbound HTTPS, execute them with runner-side secrets, and upload scrubbed results and evidence. Repeat `--allow-origin`, or set `SPECBOOK_RUNNER_ALLOWED_ORIGINS`. |
| `tunnel --allow-origin <origin> [--url <server>] --project <id> [--environment <name-or-id>]` | Connect server browsers to an environment’s allowed private origins through an outbound WebSocket tunnel. Repeat `--allow-origin`, or set `SPECBOOK_TUNNEL_ALLOWED_ORIGINS`. |
| `serve [--port <number>] [--host <address>] [--data <dir>] [--ui <dir>]` | Start the API, job worker, steward, schedules and standalone web UI. |
| `spec new "<title>" --feature <name>` | Scaffold a readable contract and a valid one-step Playwright test, creating `feature.yml` when needed. Existing Specs aren't overwritten. |
| `spec check [path]` | Validate source and YAML step titles with the same runtime as the server. With an open exploration session, count every locator on the current page and report missing or ambiguous matches. |
| `run [spec\|feature]` | Run selected Specs in fresh browser contexts, then save results, per-step evidence and an HTML report. With no selector, run every Spec. |
| `report [run-id]` | Generate the shared self-contained HTML report for a saved run; default to the latest run. |
| `credentials add <profile> [--stdin-json] [--origin <url>]` | Save fields outside the repository. Interactive field entry doesn't echo values. Noninteractive input comes from stdin. Repeat `--origin` to scope a profile. |
| `credentials list` | List profile names, field names and origins; never values. |
| `credentials remove <profile>` | Remove a profile from the local store. |
| `browse open [url] [--headed]` | Start or navigate a separate exploration browser. Defaults to the configured base URL. |
| `browse snapshot` | Return the accessibility tree with `eN` element refs in the server's browser snapshot format. |
| `browse click <ref>` | Click a ref from the latest snapshot and return the resulting snapshot. |
| `browse fill <ref> <text>` | Fill a ref and return a snapshot. |
| `browse fill <ref> --secret profile.field` | Fill a credential value without returning it. |
| `browse inspect <ref-or-selector>` | Read element HTML, ancestors and computed colors with field values removed. |
| `browse close` | Close the browser and remove its socket. |
| `chat "<message>" [--agent claude\|codex] [--timeout <seconds>] [--no-wait]` | Start a conversation to explore, propose, create or run coverage. Print its reply, id and status. |
| `chat <id> "<reply>"` | Answer a question or request changes in the same brain session. |
| `chat <id> --select 1,2` | Select numbered proposals; create, check and run each selected Spec, correcting it within a three-run limit per Spec for this turn. |
| `chat <id> --wait [--timeout <seconds>]` | Wait for a background turn and print its reply. |
| `chats` | List conversations with status, last update and Specs created. |

Every command supports `--json`. Selectors accept `feature/slug`, `specs/feature/slug`, `.specbook/specs/feature/slug/spec.ts`, an absolute Spec path, a unique slug, or a feature slug. The run command validates source before starting Playwright; a live locator check describes the exploration page's current state, so a locator used after navigation may correctly match nothing now.

Connecting and publishing
-------------------------

Create a named personal token under **Settings → Access tokens** in the hosted web app, with an optional expiry. Copy it when shown; the server stores its hash and shows creation, expiry and last-use times. Revoking it stops future requests immediately. Personal tokens support workspace operations; account, instance, CI-token and runner-token management requires a browser session. Signing out or revoking a user's sessions also revokes their personal tokens, including when their role changes or their account is disabled.

```sh
specbook init --base-url http://localhost:3000
specbook login https://specbook.example.com
# For automation, pass the personal token through stdin:
password-manager-command | specbook login https://specbook.example.com --stdin
specbook connect "Shop" --environment Staging
specbook pull
specbook run login/sign-in
specbook publish login/sign-in
# Or verify and publish in one command:
specbook publish login --run
```

`login` accepts the web app's URL, an explicit `/api` URL or a direct backend URL. It saves the resolved API URL and token in `$SPECBOOK_HOME/servers.json` with mode 0600 on Unix. New configuration directories use mode 0700. Log in to several servers and use `connect --server <url>` to choose one; logging in again makes that server the default. `logout [url]` removes only the local login. Revoke a lost token in the web app.

The connection lives in `.specbook/config.yml` as `remote: { url, projectId, environment }`. It doesn't change the local `baseUrl`; local runs can keep targeting localhost while publishing to Staging or Production. Credentials remain separate: a local `secret("shop", "password")` resolves from the local profile, and server runs resolve the project's vault and environment overrides. This phase doesn't synchronize vault values.

`pull` downloads `feature.yml`, `spec.yml` and `spec.ts`, including nested features. `.specbook/remote.json` records each Spec's base revision and downloaded file hashes. If a local file changed or disappeared since that baseline, pull reports `local_changes` and leaves it alone. An existing untracked Spec also conflicts unless its files already match the remote copy. New local Specs remain in place.

`publish` uses the latest saved run for each selected Spec. That run must pass, and its SHA-256 hashes for both `spec.ts` and `spec.yml` must match the current files; edits to either file require another run. Older run records without hashes require a fresh run too. Use `--run` to verify before sending. Publication sends the base revision recorded by pull or a previous publish; new Specs send no base revision. The server checks every selected Spec before writing, validates the shared Spec format and commits through the app's repository writer, attributed to the token's user. Existing feature metadata stays as saved on the server; a new feature uses the local `feature.yml`.

A stale base produces `revision_conflict` and asks for `specbook pull`. Pull never discards your unpublished work to resolve that conflict. Save a copy of your edits, restore the last pulled/published files, pull the current remote revision, then reapply your changes and run again. A successful publish records the returned revisions locally.

Awaiting deployment
-------------------

A changed Spec published through the CLI starts as `awaiting_deploy` in the chosen environment. The app and run reports display a clock icon and **Waiting for deploy**. Failed runs retain screenshots and failure details without starting retries, failure triage or Inbox items, and they don't count as failing health or fail CI's quality gate. JUnit marks these failures as skipped with `Waiting for deploy`.

The first passing run in that environment promotes the Spec to regular passing status. Later failures follow the usual acceptance-check workflow. A passing run in another environment doesn't promote it. Publishing changed files resets the chosen environment to awaiting deployment; publishing identical files doesn't reset an already promoted Spec. Historical runs retain their original classification. Local CLI runs skip model-based evidence review; existing server evidence review still applies where configured.

Remote CI
---------

Create a project CI token in **Project settings → Automation → CI access**. Personal tokens are for connecting, pulling and publishing; pipelines use the project CI token.

Use an HTTPS Specbook URL for CI. An HTTP server URL makes the generated `npx` snippet download and execute the CLI archive without transport authentication, and sends the CI token over an unencrypted connection. Configure HTTPS before using that snippet outside a trusted local test.

```sh
export SPECBOOK_URL=https://specbook.example.com/api
export SPECBOOK_PROJECT=YOUR_PROJECT_ID
# Supply SPECBOOK_TOKEN from your pipeline's secret store.
npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci --environment Staging
npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci --environment Preview --base-url https://preview.example.com
```

Set `SPECBOOK_URL` to the API root, including `/api` when using the frontend, so the package URL and CLI requests use the same server. `npx` downloads that server's CLI tarball; the public package route doesn't need the project token.

CI needs no `.specbook` workspace or saved personal login. `--url`, `--project` and `--token` override the corresponding variables; prefer the environment for the token so it doesn't enter shell history. Select a feature with `--feature-id <remote-id>` or Specs with `--spec-ids <id,id>`; omit both to run all Specs. The environment defaults to Production. Preview origins must be allowed by that environment.

The command writes `specbook-report.html`, `specbook-junit.xml` and `specbook-summary.md`, including on a failed quality gate. The HTML report embeds its fonts and evidence for offline use. Override their paths with `--report`, `--junit`, `--summary` or `SPECBOOK_REPORT_PATH`, `SPECBOOK_JUNIT_PATH`, `SPECBOOK_SUMMARY_PATH`. Exit status is 0 when the quality gate passes, 1 for a failed gate or request/report error. Awaiting-deploy failures appear separately and don't fail the gate.

`--timeout <seconds>` or `SPECBOOK_TIMEOUT_SECONDS` limits waiting (default 3600). GET requests retry transient server/connection errors; a run trigger isn't retried. `--commit-sha`, `--ref` and `--build-url` accept pipeline metadata, also available as `SPECBOOK_COMMIT_SHA`, `SPECBOOK_REF`, `SPECBOOK_BUILD_URL`. `SPECBOOK_ENVIRONMENT`, `SPECBOOK_BASE_URL`, `SPECBOOK_FEATURE_ID` and `SPECBOOK_SPEC_IDS` provide the corresponding defaults. Set `--fail-on-flaky` / `SPECBOOK_FAIL_ON_FLAKY=true` or `--fail-on-known-bugs` / `SPECBOOK_FAIL_ON_KNOWN_BUGS=true` for stricter gates; awaiting-deploy failures remain excluded.

Optional `--comment github|gitlab|none` (or `SPECBOOK_COMMENT_PROVIDER`) updates a single pipeline summary comment per project. GitHub uses `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and the pull-request event or `SPECBOOK_PR_NUMBER`. GitLab uses `SPECBOOK_GITLAB_TOKEN` with API scope and the merge-request job variables; `CI_JOB_TOKEN` cannot publish notes. Provider tokens go only to their provider, and missing PR/MR context skips commenting. Report files remain available if commenting fails. The server's run, result and deploy HTTP APIs remain available; the downloaded `client.mjs` has been removed.

Remote JSON results
-------------------

Each new command emits one JSON object with `--json`, never the token or credential values. These are the stable fields:

```text
login:   { url, user: { id, name, email, role }, default: true }
logout:  { url: string|null, removed, defaultUrl: string|null }
connect: { url, project: { id, name }, environment, workspace }
pull:    { url, projectId, pulled: [{ path, revision }],
           conflicts: [{ path, reason: "local_changes" }] }
publish: { url, projectId, environment, commitSha,
           specs: [{ id, path, revision, status }], verified: [{ path, runId }] }
ci:      { batchId, status, environment: string|null, durationMs: number|null,
           qualityGate: { passed, failures, flaky, knownBugs, awaitingDeploy },
           results: [{ specId, runId, title, status, failReason?, durationMs?,
                       flaky, knownBug, failsGate, awaitingDeploy, url }],
           report, junit, summary, url }
```

The CI result preserves raw execution status (`failed` or `error`) alongside `awaitingDeploy`; use `failsGate` for a pipeline decision. `qualityGate.awaitingDeploy` counts waiting failures. Local `run` results now include `hashes: { specTs, specYaml }` on each Spec result. Most errors return `{ ok: false, error }` and exit 1; a stale publish adds `{ code: "revision_conflict", conflicts: [{ path, revision: string|null }], command: "specbook pull" }`. Pull conflicts return the normal pull result with exit 1.

Private-network runners
-----------------------

An admin creates a token under **Settings → Runners**. Choose **Runner** as its purpose, a group to restrict it to that group's work and, when needed, the projects it can access; the default is all projects. Tunnel connections require a separate token with **Tunnel** purpose and a group. Copy the secret once. **Rotate token** displays a replacement once, revokes the previous secret immediately and returns its unfinished work to the queue. Revoking a tunnel token also closes its tunnels. Token management requires an admin web session.

An admin chooses **Runner** in **Project settings → Environments**, then enters the matching group. Grouped environments use runners in that group; ungrouped environments use only ungrouped runners. Manual runs, Run all, CI, schedules and deployment signals share this queue. The runner needs outbound HTTPS access to Specbook and browser access to the application's allowed origins.

```sh
export SPECBOOK_HOME=/var/lib/specbook-runner
export SPECBOOK_URL=https://specbook.example.com/api
# Supply SPECBOOK_RUNNER_TOKEN through your secret store.
specbook credentials add shop --origin https://private-app.example.com
specbook runner --concurrency 1 --allow-origin https://private-app.example.com
```

`--url` or `--server` overrides `SPECBOOK_URL`; a missing token prompts without echoing it on a terminal. `--json` never prompts. Set concurrency with `--concurrency` or `SPECBOOK_RUNNER_CONCURRENCY` (1–32, default 1). Each process has its own capacity even when several replicas share a token. Settings shows their CLI and protocol versions and flags older clients. Claims and heartbeats report both versions; an incompatible protocol gets an upgrade message pointing to the server's CLI tarball.

Configure the runner's own origin allowlist before starting it. Repeat `--allow-origin https://app.example.com` for each permitted HTTP(S) origin, or set `SPECBOOK_RUNNER_ALLOWED_ORIGINS` to a comma- or whitespace-separated list. The CLI refuses to start without it. Production runners must use an explicit allowlist controlled by the runner operator; never derive it from a server response. Before resolving secrets or opening Chromium, the runner refuses and releases a job whose base URL or environment allowed origins fall outside this list.

**Settings → Runners → Run queue** shows waiting Spec counts, oldest wait, available runners and the reason for each environment/group. Waiting Spec pages and Run all results show the same information. The admin API is `GET /runners/queue`, returning `{ queues: [{ projectId, projectName, environmentId, environmentName, group, executor, queued, oldestQueuedAt, oldestWaitMs, onlineRunners, busyRunners, reason }] }`. Counts cover waiting Specs, including every Spec in a queued batch; leased Specs leave the queue. Reasons distinguish an offline group from runners with occupied capacity.

Claims use a renewable lease. A crashed process returns unfinished batches to the queue; a late upload cannot overwrite a replacement lease. SIGINT and SIGTERM abort browser work, release unfinished leases and disconnect the instance. The server lease defaults to 60 seconds; `SPECBOOK_RUNNER_LEASE_SECONDS` accepts 5–300 seconds.

Ephemeral processes and containers
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

```sh
specbook runner --once
specbook runner --drain-after 10 --concurrency 2
```

`--once` completes one claimed batch, then exits. `--drain-after <n>` completes at most n claimed batches, including all their Specs, then exits after the active slots finish. These flags are mutually exclusive. A batch's failed Spec still counts as completed work; no matching work means the runner keeps polling. Container defaults can use `SPECBOOK_RUNNER_ONCE=true` or `SPECBOOK_RUNNER_DRAIN_AFTER=10`.

Work can wait in the queue for up to 30 minutes. Its execution deadline starts when a runner claims it and allows the full run timeout plus a 60-second grace. After three expired leases or hard failures, the batch fails with a process failure instead of requeuing indefinitely. Graceful SIGINT/SIGTERM releases and scale-down do not consume attempts. The waiting run retains the failure reason. A runner's origin refusal terminates that work immediately with its refusal reason.

Set `SPECBOOK_RUNNER_QUEUE_TIMEOUT_SECONDS` on the server to change the queue timeout. Tunnel waiting has the same default and its own `SPECBOOK_TUNNEL_QUEUE_TIMEOUT_SECONDS` setting.

Build the runner image from this checkout without publishing it:

```sh
docker build -f Dockerfile.runner -t specbook-runner:local .
docker run --rm --shm-size=512m \
  -e SPECBOOK_URL -e SPECBOOK_RUNNER_TOKEN -e SPECBOOK_RUNNER_ALLOWED_ORIGINS \
  specbook-runner:local --once
```

The image includes the CLI and Chromium, runs as the `node` user and starts `specbook runner` under tini. `SPECBOOK_HOME` defaults to `/home/node/.config/specbook`. Mount that directory for local profiles, or inject secret environment variables. Use a versioned image built by your team in production. The [ephemeral Job](examples/runner-job.yaml) and [Deployment](examples/runner-deployment.yaml) examples read a pre-existing Kubernetes Secret named `specbook-runner`, key `token`, and allocate memory-backed `/dev/shm`. Replace the image tag and server URL before applying them.

Autoscaling and metrics
~~~~~~~~~~~~~~~~~~~~~~~

`GET /runner/metrics` accepts a runner token or an admin personal token in the Authorization bearer header. Runner tokens see only their group and project scope; metrics requests do not make a worker appear online. `?group=lab` selects one group, and `?group=` selects ungrouped work. Configured groups remain present with zero depth after the queue drains.

```text
JSON: { groups: [{ group: "lab", queued: 4, oldestWaitSeconds: 12.5 }] }
GET /runner/metrics?group=lab&format=prometheus:
# HELP specbook_runner_queue_depth Number of Specs waiting for a runner.
# TYPE specbook_runner_queue_depth gauge
specbook_runner_queue_depth{runner_group="lab"} 4
# HELP specbook_runner_oldest_wait_seconds Age of the oldest queued run in seconds.
# TYPE specbook_runner_oldest_wait_seconds gauge
specbook_runner_oldest_wait_seconds{runner_group="lab"} 12.5
```

The [KEDA metrics-api example](examples/runner-keda.yaml) scales the Deployment from `groups.0.queued`, using a bearer token from the Kubernetes Secret. Create the `lab` runner environment before enabling the scaler so the filtered response always contains its numeric zero. The sample starts at zero replicas, targets one queued Spec per replica and caps replicas at ten. One lease can contain several Specs, so choose a target that fits your batches and browser memory budget. The sample delays scale-down for 30 minutes and scale-to-zero for 35 minutes because claiming a batch removes it from the queue before its browser work finishes. Set those windows above your longest batch duration. KEDA scale-down sends SIGTERM; unfinished work returns to the queue. See [KEDA's metrics-api scaler documentation](https://keda.sh/docs/2.22/scalers/metrics-api/) for authentication and target configuration.

To scrape Prometheus, set `metrics_path: /api/runner/metrics`, `params: { format: [prometheus], group: [lab] }`, `scheme: https`, and an `authorization.credentials_file` mounted from a Secret. Never put a token in scrape URLs or labels. Prometheus's [configuration reference](https://prometheus.io/docs/prometheus/latest/configuration/configuration/) describes that file-based authorization.

Corporate HTTP proxies
~~~~~~~~~~~~~~~~~~~~~~

`login`, `connect`, `pull`, `publish`, `ci`, `runner` and `tunnel` honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, including lowercase forms. HTTPS and secure WebSockets prefer `HTTPS_PROXY`, falling back to `HTTP_PROXY`; HTTP uses `HTTP_PROXY`. `NO_PROXY` accepts comma-separated hosts, domain suffixes, optional ports and `*`.

Inject proxy URLs, including any credentials, through your secret store. The CLI scrubs full proxy URLs, username/password variants and basic-auth values from errors and output. These proxy variables configure the outbound control connection to Specbook; application traffic still follows the runner or tunnel's environment network policy. Install your organization's CA and set `NODE_EXTRA_CA_CERTS` when it signs the server or proxy certificate.

Runner secret sources
~~~~~~~~~~~~~~~~~~~~~

For `secret("shop", "password")`, the runner checks these sources in order:

1. A nonempty `SPECBOOK_SECRET_SHOP_PASSWORD` in the process environment. `secretEnvName` uppercases profile and field and converts punctuation to underscores. An empty value falls through to the next source.
2. The JSON object returned by `--secrets-command` or `SPECBOOK_SECRETS_COMMAND` for the `shop` profile.
3. The local `shop` profile under `SPECBOOK_HOME`.

```sh
# Inject SPECBOOK_SECRET_SHOP_PASSWORD from your orchestration secret store.
export SPECBOOK_SECRET_SHOP_ORIGINS=https://private-app.example.com
export SPECBOOK_RUNNER_ALLOWED_ORIGINS=https://private-app.example.com
specbook runner --once
# Or call a wrapper around Vault, 1Password or another secret manager:
specbook runner --secrets-command /opt/specbook/read-profile
```

The runner invokes the provider command with the profile as its final argument, once per needed profile per batch. A wrapper receives `shop` as `$1` and prints an object with nonempty string fields and explicit profile origins:

```json
{"fields":{"password":"<value from your secret store>"},"origins":["https://private-app.example.com"]}
```

The wrapper can obtain fields with a Vault or 1Password CLI. A flat fields object is also accepted when `SPECBOOK_SECRET_SHOP_ORIGINS` supplies its origins. If environment variables supply every needed field, the runner doesn't call the provider. Missing provider fields fall back to local profiles; provider failures stop that batch with a credentials error. Keep credentials out of the command string because process arguments are visible to local users.

Provider execution has a 30-second limit and a 1 MiB stdout limit. The runner discards stderr and describes failures without its content. Environment secrets require `SPECBOOK_SECRET_<PROFILE>_ORIGINS`, a comma- or whitespace-separated list. Provider secrets require their `origins` array or the same profile environment variable. Local profiles declare origins with `credentials add <profile> --origin <origin>`. Runner mode refuses any source without explicit profile origins matching the job and the runner's allowlist. Values never enter JSON events or uploads. The runtime scrubs text evidence, masks secrets in screenshots and disables video for secret runs. Runner environments never fetch server-vault credentials or use server credential overrides.

Runner JSON output uses newline-delimited events:

```text
{ event: "connected", url, runner: { id, name, group }, concurrency }
{ event: "claimed", jobId, batchId, specs }
{ event: "completed", jobId, batchId, results: [{ runId, status, failReason }] }
{ event: "retrying", reason, retryInMs }
{ event: "stopped", url, completedJobs, failedJobs }
```

Rejected jobs emit `{ event: "rejected", jobId, batchId, reason }`; the runner releases them and continues claiming work. If evidence exceeds the server upload limit, it retries once without video. Authentication failures use `{ ok: false, error }` and exit 1. Completed Spec failures remain in the uploaded results; a normally drained runner exits 0. Saved evidence, triage and candidate verification work for runner environments; live chat exploration requires server browsers.

Server browsers through a tunnel
--------------------------------

Choose **Server through a tunnel** in the environment settings and set a runner group. Create a token with **Tunnel** purpose restricted to that group and, preferably, the project. Runner-purpose tokens cannot open tunnels, and tunnel-purpose tokens cannot claim runner jobs. Open the outbound tunnel from a machine that can resolve and reach the private application:

```sh
export SPECBOOK_URL=https://specbook.example.com/api
export SPECBOOK_PROJECT=YOUR_PROJECT_ID
# Inject SPECBOOK_RUNNER_TOKEN; do not pass it as an argument.
specbook tunnel --environment Staging --allow-origin https://private-app.example.com
```

`--project` overrides `SPECBOOK_PROJECT`; `--environment` accepts a name or id and defaults to `SPECBOOK_ENVIRONMENT` or Production. Only one tunnel connects to an environment at a time. Use an HTTPS server URL in production and configure your reverse proxy to forward WebSocket upgrades for `/api/runner/tunnel` (direct backend: `/runner/tunnel`). `specbook serve` forwards these upgrades too.

Configure the tunnel's local allowlist with repeated `--allow-origin` values or `SPECBOOK_TUNNEL_ALLOWED_ORIGINS` (comma- or whitespace-separated). The CLI refuses to start without it and refuses server configuration outside it. Each connection must belong to both the environment's origins and this local allowlist. Tunnel mode also blocks public origins outside the environment's allowed origins: add any required CDNs and identity providers to both lists.

The server authenticates the WebSocket with a bearer header, then multiplexes browser HTTP, HTTPS and WebSocket connections. Private DNS lookup happens in the tunnel process. Both ends check each target against the environment's exact base and allowed origins; an unrelated host never gets a connection. HTTPS keeps application TLS end to end, and the existing browser/API network guard still applies.

Server browsers execute Specs and explore the app in chat while credentials remain in the server vault, including environment overrides. When the tunnel disconnects, new runs wait with a **No tunnel connected** reason and chat gives the command to start it. Queued tunnel runs retain their immutable Spec files and resume waiting after a server restart; they fail clearly if no tunnel connects within 30 minutes. Start the tunnel before retrying the chat message. SIGINT/SIGTERM closes the tunnel. Disconnections and an occupied tunnel slot retry with backoff from three to 30 seconds; ping/pong timeouts detect half-open connections. Revoked tokens, incompatible protocols and origin changes require restarting with the correct settings. Renaming an environment preserves its connection.

Tunnel JSON output is newline-delimited:

```text
{ event: "connected", url, environment: { id, projectId, name, group }, origins }
{ event: "retrying", reason, retryInMs }
{ event: "stopped", url }
```

It never contains credentials or tokens. Errors use `{ ok: false, error }`. Use **Runner** when browsers and logins must stay inside your network; use **Server through a tunnel** when server-side chat exploration needs access to a private app.

Hosting with the CLI
--------------------

`specbook serve` starts the full hosted product. The CLI package includes the API runtime and server dependencies; local commands load neither the server nor the web UI. Install the CLI tarball as described above, then start it with a persistent data directory:

```sh
specbook serve --host 127.0.0.1 --port 4201 --data /var/lib/specbook
```

`--port` selects the web UI port. An explicit port chooses the preceding port for the API unless `PORT` overrides it, so this example uses API port 4200. Without `--port`, `FRONTEND_PORT` defaults to 4001 and `PORT` defaults to 4000. `--host` overrides `HOST`, defaulting to `127.0.0.1`. `--data` maps to `SPECBOOK_STORAGE_DIR`; without either, data lives in `$SPECBOOK_HOME/server`. The backend keeps its storage lock, migrations and recovery checks. If either child process exits, serve stops the other; SIGINT and SIGTERM shut down both.

For a native Linux installation, install Git and `flock` (`util-linux`), Chromium's platform libraries, and Xvfb/x11vnc if you use live chat browsers. Docker includes these tools. Chromium itself downloads on the first browser run if absent.

The web UI ships separately as a Next.js standalone artifact matching the CLI version. Resolution follows this order:

1. An extracted directory passed with `--ui`, containing `server.js`.
2. A UI next to the installed CLI, in `dist/ui` or `ui`. Docker bundles it at `/app/ui` and passes that directory explicitly.
3. `$SPECBOOK_HOME/ui/<version>`, populated by a checksum-verified release download.

The default artifact URL is `https://github.com/gustavo-ferreira03/specbook/releases/download/v<version>/specbook-ui-<version>.tar.gz`. The release workflow packages the UI first and embeds its SHA-256 in the CLI package; serve verifies downloads against that trusted checksum before extracting and rejects escaping paths and unsafe archive entries. Source builds without an embedded checksum require an extracted UI through `--ui`. A missing release produces instructions to download, verify and extract the matching UI, then use `specbook serve --ui <directory>`. `SPECBOOK_UI_RELEASE_URL` overrides the complete HTTPS artifact URL, with `{version}` substitution, for a release mirror. A mirror cannot change the expected checksum. The CLI doesn't download UI files for local commands.

Build an explicit UI from this checkout:

```sh
pnpm -r build
node apps/frontend/scripts/package-ui.mjs /tmp/specbook-ui
mkdir -p /tmp/specbook-ui/extracted
tar -xzf /tmp/specbook-ui/specbook-ui-<version>.tar.gz -C /tmp/specbook-ui/extracted
specbook serve --ui /tmp/specbook-ui/extracted --port 4201 --data /tmp/specbook-data
```

Version tags trigger `.github/workflows/release.yml`, which checks the CLI version, builds and attaches the CLI tarball, standalone UI archive and checksums to the matching GitHub release. Writing the workflow doesn't publish anything from a local checkout.

The Docker image runs `specbook serve` with its bundled UI. Existing `/data` volumes, port 4001, `FRONTEND_ORIGIN`, `SPECBOOK_ALLOWED_HOSTS`, backend `PORT`, `FRONTEND_PORT` and OAuth callback variables keep their existing meanings. Set `FRONTEND_ORIGIN` to the public origin behind a reverse proxy; direct browser traffic uses the web UI's `/api` proxy. Both Docker and packed installs expose `/api/cli/specbook.tgz`. A packed install builds an installable archive from its own packaged files under the data directory; `SPECBOOK_CLI_PACKAGE_FILE` can select a prebuilt archive.

Serve uses the normal human summary and puts child-process logs on stderr. With `--json`, stdout contains newline-delimited events:

```text
{ event: "downloading_ui", version }
{ event: "ready", url, apiUrl, port, host, data, ui,
  uiSource: "explicit" | "bundled" | "cache" | "download" }
{ event: "stopped", url }
```

`pnpm dev` still starts the development API and Next.js dev server independently.

Conversations
-------------

Use the same conversation id for answers, selection and changes:

```sh
specbook chat "Cover login and cart behavior; ask me if the expected result is unclear" --agent codex --json
specbook chat c-7f3a91b2 "Use the normal customer's successful login and add one item" --json
specbook chat c-7f3a91b2 --select 1,2 --json
specbook chats --json
```

These commands illustrate the flow; use the id and proposal numbers returned by your own chat. Specbook asks only when blocked or when expected behavior is ambiguous. Requests covering more than one behavior produce a short list of proposals, each with a number, title, why and feature. You can reply in text instead of selecting to change the plan. For existing coverage, ask the conversation to run the relevant Specs.

Every reply has exactly one status:

| Status | Meaning and next step |
| --- | --- |
| `working` | A turn still runs. Use `specbook chat <id> --wait`. |
| `waiting_for_reply` | Specbook asked a question. Continue with `specbook chat <id> "<answer>"`. |
| `waiting_for_selection` | Specbook proposed numbered Specs. Select with `specbook chat <id> --select 1,2`, or reply in text to request changes. |
| `needs_credentials` | A login profile or required field is missing. The reply names the profile and fields and gives `specbook credentials add <profile>` for the human. After adding it, continue with `specbook chat <id> "done"`. |
| `done` | The request finished. Read the Specs' statuses and evidence/report paths; a finished request can include a failing Spec. |
| `failed` | The turn couldn't complete. Read the reason, fix the cause and retry in the same conversation. |

With `--json`, a chat reply has this shape; absent optional fields stay absent:

```text
{ id, status, message, proposals?, pendingAction?, specs?, evidencePaths?, error? }
```

The reply schema and MCP input schemas come from Zod via `.toJSONSchema()` in `apps/cli/src/chat-model.ts`. Read the generated reply schema with `specbook chat --help --json`. Status comes from a typed outcome tool, never from the brain's free-text reply. `proposals` holds numbered coverage choices, and `pendingAction.type` is `question`, `spec_selection` or `credentials`. A credential action includes `profile`, `fields` and the exact `command` for the human. Each entry in `specs` has `path`, `title`, `created` and `status`, with optional `evidencePath`, `report` and `failReason`; `evidencePaths` includes both evidence directories and report paths. The CLI derives these results from actual writes and runs rather than accepting invented results from the brain. `chats --json` returns `{ conversations: [...] }`, whose entries contain `id`, `status`, `updatedAt`, `agent` and accumulated `specs`.

All turns run in a detached worker. By default, `chat` waits up to 600 seconds; `--timeout` accepts 1–3600 seconds and limits the caller's wait. When that time expires, the worker keeps running and the reply is `working`. `--no-wait` returns `working` immediately. Retrieve the outcome with `specbook chat <id> --wait --json`; if its timeout also expires, wait again. Interrupting the waiting command leaves the worker running. A message or selection sent while a turn is working returns its current `working` reply and doesn't start a second turn or queue the input. The worker has a separate one-hour limit; reaching it produces `failed` while preserving completed Specs and evidence. A dead worker also becomes `failed` when a later command reads the conversation.

`--agent claude|codex` chooses the brain for a new conversation, defaulting to the workspace configuration. An existing conversation keeps its agent, and an explicit `--agent` must match it. `create` and `verify` have been removed; use `chat` for both new Specs and existing coverage.

Workspace files
---------------

```text
.specbook/
  config.yml                 # version, baseUrl, agent, optional remote connection
  remote.json                # remote revisions and file hashes; no credentials
  .gitignore                 # excludes runs/ and chats/
  SKILL.md
  spec-writing-rules.md
  specs/
    login/
      feature.yml
      sign-in/
        spec.yml
        spec.ts
  runs/
    <timestamp-and-id>/
      run.json
      results.json
      report.html
      specs/login/sign-in/
        spec.yml
        spec.ts
        evidence.json
        evidence/step-01.png
        evidence/replay.json.gz
        evidence/execution.webm  # failures without credentials
  chats/
    c-7f3a91b2/
      conversation.json      # history, status, proposals, Specs, brain session id
      brain/                 # isolated agent home, session and tool state
```

`init` also installs `.agents/skills/specbook/SKILL.md` and `.claude/skills/specbook/SKILL.md`. These instructions teach the user's coding agent to start a chat, answer or select according to its status, hand credential entry to the human and stop at `done`. Existing agent skill files aren't overwritten; copy `.specbook/SKILL.md` over them when upgrading an existing workspace. The CLI copies the writing rules from `@specbook/runtime`; the backend includes that same source in its system prompt. The contract format is `title`, `description`, `preconditions` (the starting state), `steps`, `expectedResult` (the final state the user sees) and `postconditions` (side effects checked afterwards, usually none). Tests import `test` and `expect` from `"specbook"` and have one named `step()` per precondition, per step, for the expected result and per postcondition, in that order, so every run records a screenshot of the expected result. An optional leading `cleanup()` block removes data the Spec creates; it runs after the test, even on failure, and stays out of the contract and evidence. The shared validator rejects arbitrary JavaScript, imports, filesystem access and browser evaluation.

Run evidence includes screenshots after each browser step, a DOM session replay, API request evidence where applicable, failure context and diagnostics. Screenshots use WebP at quality 80, with masked PNG capture as a fallback; older PNG evidence remains readable. Specbook records snapshots and mutations with rrweb 2.1.1 and embeds rrweb-player 2.1.1, including runs that use credentials. Recording survives page navigation and reloads. The runtime masks input values and password fields, protects targets filled through `secret()`, and scrubs recorded events with the same credential scrubber as other evidence. It excludes cross-origin iframe contents and canvas drawing operations. Failure video remains available for runs without secrets, including canvas Specs; runs with secret environment values disable video and traces. Screenshots mask fields and visible DOM text containing known credential values.

Each browser run stores compressed events in `evidence/replay.json.gz` and references that file in `evidence.json`. The recorder scales inlined page images to their displayed size times device pixel ratio, capped at 2x, without upscaling. The recording stores repeated images once in an asset table and restores them for playback. The replay limits per Spec are 15 MiB for the stored compressed file, 64 MiB for uncompressed and restored events, and 250,000 events. A run that exceeds a limit keeps its screenshots and reports why replay is unavailable. Runner uploads include replay within the existing artifact and request limits; if a completion exceeds the server limit, the runner retries without video, then without replay and records the omission. Runner protocol 3 requires a matching server and CLI. Replay follows the run's existing artifact retention policy. Temporary Playwright files disappear after execution.

Open `report.html` from disk to play a replay above a horizontal screenshot strip. The report embeds its fonts, compressed player code, styles and compressed events, so playback needs no server or network. It skips the blank tab and opens paused at the first drawn frame, at 00:00. Use play/pause, playback speed, the draggable scrubber and skip inactivity to review a run. Timeline markers identify preconditions, numbered Spec steps, the expected result and postconditions, with their outcomes. Click a step to seek to its start; click a screenshot to seek and enlarge it. Close the enlarged screenshot with Escape or a click to keep your scroll position. Failed element-count assertions show a plain-language wait summary and shade the waiting span on the timeline. Older runs without recordings and API-only Specs omit the player. The Spec page's **View report** link opens the same replay in server reports.

Exploration runs in a detached process with a private local socket (a named pipe on Windows). Sessions persist across CLI commands and expire after 30 idle minutes. Each conversation has its own brain exploration session, separate from other conversations and from manual `browse` commands. Refs come from the latest accessibility snapshot; navigation invalidates them. Exploration state never becomes a run's storage state. Each run starts signed out.

Network policy matches the server runtime: navigation stays within the configured origin, and a DNS-pinning proxy blocks private targets unless the configured base URL is localhost or a private IP. Private access then applies only to the configured origin. Public subresources can load; a public app can't use the browser to reach localhost. Symlinks and paths escaping `.specbook` are rejected for Spec writes.

Credentials
-----------

Credentials live in `$SPECBOOK_HOME/credentials.json`, defaulting to `$XDG_CONFIG_HOME/specbook/credentials.json` or `~/.config/specbook/credentials.json`. The file has mode 0600 on Unix; new configuration directories have mode 0700. Windows uses normal user filesystem permissions. The store contains profile fields and optional allowed origins, without encryption or an OS keychain.

Supply noninteractive values through stdin, preferably from your existing password manager. Don't put values in shell arguments or Specs:

```sh
password-manager-command | specbook credentials add shop --stdin-json --origin https://www.saucedemo.com
specbook credentials list --json
specbook browse fill e2 --secret shop.username --json
```

The stdin JSON shape is `{"fields":{"username":"...","password":"..."},"origins":["https://www.saucedemo.com"]}`; a plain mapping of string fields also works. If origins are omitted, credentials can be used only at the selected workspace's base origin. Profile names match remote vault names. Tests resolve `secret("shop", "password")` at execution time. Agent tools expose only profile metadata, redact known values from text, and reject Spec writes that contain a stored credential value.

Use `SPECBOOK_HOME=/tmp/my-specbook-home` to keep disposable verification credentials out of your real user configuration.

Local agent sessions
--------------------

The first turn starts a fresh noninteractive agent session; later turns resume its saved brain session id. Each conversation keeps an isolated working directory and agent home below `.specbook/chats/<id>/brain/`, outside the app's source tree. User and Specbook messages, current status, pending action, proposals and Specs stay in `conversation.json`. Conversation ids are unique within the workspace.

The CLI starts a stdio MCP server for each turn. Tool schemas come from Zod via `.toJSONSchema()`; the brain receives exploration commands, credential metadata, restricted Spec file reads/writes, static and live checks, single-Spec runs and typed outcome tools. It ends a turn by asking a question, proposing Specs, requesting credentials or reporting completion/failure. Before requesting credentials, it checks available profiles and field names. Never put secret values in chat; the CLI rejects messages containing stored credential values and redacts known values from reply prose and saved human-facing text. Structural ids, statuses and session ids stay intact so state validation and resumption still work if a credential happens to match a structural string.

Persisted brain transcripts are redacted before resuming and after each turn, including values that became known when a profile was added after initial exploration.

The MCP server enforces at most three attempts per Spec in a turn, including failed runs; reconnecting MCP doesn't reset the saved counter. A later user request starts a new turn with fresh attempt limits, so existing Specs can be verified again. After a correction, the brain must run the final files again. A passing result whose files changed after the run reports `changed_after_run`. Selection asks the brain to create and check each selected Spec and report the confirmed run results; the CLI retains evidence even when a Spec fails. `run_spec` accepts `path` and an optional `proposalNumber`; during a selection turn, that number is required and must identify a selected proposal. Each proposal maps to a distinct Spec path, and `done` requires an actual run for every selection. Pending selections survive a credential request and resume when the caller replies after adding the profile.

Every MCP call checks the persisted turn id, so a server from a replaced turn can't write Specs, runs or outcomes into the current turn. Once an outcome tool succeeds, further tool calls for that turn fail. If a worker dies after saving a typed outcome, later commands recover that reply with its recorded Specs and evidence; without a recoverable outcome, they return `failed` and retain completed files.

Claude Code receives the user's turn on stdin with this command (angle-bracket values identify conversation-specific paths or instruction text):

```sh
claude -p --output-format stream-json --verbose \
  --tools '' --restricted --strict-mcp-config \
  --mcp-config '<chat>/brain/mcp.json' --setting-sources '' \
  --settings '{"disableAllHooks":true}' \
  --allowedTools 'mcp__specbook__*' --permission-mode dontAsk \
  --disable-slash-commands --no-chrome \
  --system-prompt '<shared rules and conversation workflow>'
```

Later turns insert `--resume '<saved-session-id>'` immediately after `-p`, keeping every other flag:

```sh
claude -p --resume '<saved-session-id>' --output-format stream-json --verbose \
  --tools '' --restricted --strict-mcp-config \
  --mcp-config '<chat>/brain/mcp.json' --setting-sources '' \
  --settings '{"disableAllHooks":true}' \
  --allowedTools 'mcp__specbook__*' --permission-mode dontAsk \
  --disable-slash-commands --no-chrome \
  --system-prompt '<shared rules and conversation workflow>'
```

The session sets `CLAUDE_CONFIG_DIR=<chat>/brain/claude-home` and runs from `<chat>/brain/work`. Each turn copies the user's file-backed OAuth login with mode 0600, then removes that authentication copy when it finishes; saved session history remains. API-key authentication also works. Empty `--tools` disables built-in file and shell tools, strict MCP configuration admits only the Specbook server, and hooks, user settings, slash commands and Chrome integration stay disabled. Versions without these flags fail before starting the agent. macOS keychain-only logins need an API key or a file-backed login. Session persistence stays enabled so `--resume` can retain earlier exploration and replies.

Codex receives the user's turn on stdin through `codex exec`:

```sh
codex --no-daemon exec --ignore-user-config --ignore-rules \
  --skip-git-repo-check --sandbox read-only --strict-config \
  --json --color never --cd '<isolated-cwd>' \
  -c 'approval_policy="never"' -c 'web_search="disabled"' \
  -c 'project_doc_max_bytes=0' \
  -c 'model_catalog_json="<restricted-bundled-catalog>"' \
  -c 'developer_instructions="<shared rules and conversation workflow>"' \
  -c 'tools.update_plan.enabled=false' \
  -c 'tools.experimental_request_user_input.enabled=false' \
  -c 'mcp_servers={specbook={command="<node>",args=["<cli>","--mcp","<workspace>","<session>"],env={SPECBOOK_HOME="<home>"},required=true,startup_timeout_sec=30,tool_timeout_sec=300,default_tools_approval_mode="approve"}}' \
  <one -c features.NAME=false argument for each supported disabled feature> -
```

On later turns, replace the final `-` with `resume '<saved-thread-id>' -`. All flags and `-c` overrides remain on the parent `exec` command, before `resume`; the installed `resume` subcommand doesn't accept `--sandbox`, `--cd` or `--color` itself:

```sh
codex --no-daemon exec --ignore-user-config --ignore-rules \
  --skip-git-repo-check --sandbox read-only --strict-config \
  --json --color never --cd '<chat>/brain/work' \
  -c 'approval_policy="never"' -c 'web_search="disabled"' \
  -c 'project_doc_max_bytes=0' \
  -c 'model_catalog_json="<restricted-bundled-catalog>"' \
  -c 'developer_instructions="<shared rules and conversation workflow>"' \
  -c 'tools.update_plan.enabled=false' \
  -c 'tools.experimental_request_user_input.enabled=false' \
  -c 'mcp_servers={specbook={command="<node>",args=["<cli>","--mcp","<workspace>","<session>"],env={SPECBOOK_HOME="<home>"},required=true,startup_timeout_sec=30,tool_timeout_sec=300,default_tools_approval_mode="approve"}}' \
  <one -c features.NAME=false argument for each supported disabled feature> \
  resume '<saved-thread-id>' -
```

The session sets `CODEX_HOME=<chat>/brain/codex-home`, uses the persistent `<chat>/brain/work` directory and keeps session history. Each turn copies the user's `auth.json` with mode 0600, then removes that authentication copy when it finishes; an API-key login also works. It reads the installed agent's bundled catalog through `codex debug models --bundled`, then disables each model's patch tool, shell, experimental tools, code execution, Node REPL, Responses Lite tool mode, multi-agent mode and search. It rewrites the restricted catalog at `<chat>/brain/models.json` each turn. The exported `disabledCodexFeatures` list in `apps/cli/src/agent.ts` supplies the last command arguments; it contains `shell_tool, apps, hooks, plugins, remote_plugin, multi_agent, multi_agent_v2, image_generation, view_image, browser_use, browser_use_external, computer_use, code_mode, code_mode_host, code_mode_only, code_mode_tool_search, goals, memories, skill_search, skill_mcp_dependency_install, sleep_tool, shell_snapshot, request_permissions_tool, send_message_to_user_async, token_budget, tool_suggest` and emits an override only when the installed Codex reports that feature. User configuration, project rules, plugins, hooks, web search and native planning/input tools stay disabled. Unsupported catalog layouts or required flags fail before an unrestricted agent can start.

Installed Codex also advertises its built-in `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` wrappers whenever MCP is enabled. They address only the isolated Specbook server, which advertises no resources or templates; they can't read app files or run commands. Claude exposes only the Specbook tools.

Both agents launch the same stdio server through `node <cli> --mcp <workspace> <session>`. Its browser and Spec tools are `browse_open`, `browse_snapshot`, `browse_click`, `browse_fill`, `browse_inspect`, `browse_close`, `credentials_list`, `spec_list`, `spec_read`, `spec_write`, `spec_check`, and `run_spec`; the outcome tools are `ask_question`, `propose_specs`, `request_credentials`, `report_done`, and `report_failed`. Reads and writes accept only the existing Spec layout beneath `.specbook/specs`; there is no app-file tool or arbitrary command tool. The brain receives the shared writing rules directly, with conversation guidance. The installed skill teaches the user's coding agent how to drive that conversation.

Single-executable investigation
-------------------------------

The executable probe used Bun 1.3.14 and the repository's Playwright 1.62.0. A direct `bun build --compile` failed on optional `chromium-bidi` imports; excluding those imports produced a binary that successfully launched Chromium and read a page. That wasn't enough for the Spec runtime: it resolves `@playwright/test/cli` from disk, writes test modules and fixtures to disk, and starts Playwright with `process.execPath`. In a Bun-compiled program, that path is the compiled application; the runner probe invoked itself recursively instead of the Playwright CLI. The probe processes were stopped.

Node SEA also requires bundling or extracting runtime modules and assets. The current Playwright child-process protocol needs a dedicated embedded-runner entry mode plus filesystem extraction before either option can support the shared runner reliably. Specbook distributes an installable tarball served by its backend. Windows and macOS binary packaging remain unverified. References: [Bun executable documentation](https://bun.sh/docs/bundler/executables) and [Node SEA documentation](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html).

Gaps and scope
--------------

The CLI supports local verification, remote publishing, CI and private-network runners. Conversations still use the installed local coding agent in connected workspaces. Live agent exploration inside runner environments remains outside this phase.

Conversation cancellation, deletion and queued follow-ups aren't implemented. A working turn rejects new input with `working`; send it again after the turn finishes. Conversation histories stay on disk under the ignored `chats/` directory, and credential metadata stays in history after a request. Authentication copies disappear after each turn, while agent session files remain for resumption. The CLI rejects known stored secrets in messages and redacts reply prose, while preserving structural ids and statuses. It can't identify a secret that was never saved in the credential store; never paste one into chat.

Remote vault synchronization, encrypted credential storage and additional browsers remain outside this task. Agent availability, authentication, subscription limits and supported CLI flags depend on the installed coding-agent versions; unsupported restricted-mode configurations fail without granting broader tools. Windows and macOS conversation behavior remains untested.

Private-network runner verification
-----------------------------------

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

Serve verification
-------------------

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

Server package verification
---------------------------

The 2026-10-12 follow-up verified the public CLI download with a separate backend on `127.0.0.1:4100`, frontend on `127.0.0.2:4101` and storage under `/tmp/specbook-cli-delivery-storage`. Without the tarball, both backend `/cli/specbook.tgz` and frontend `/api/cli/specbook.tgz` returned 404 with the exact build command. After `pnpm --dir apps/cli pack --out ../backend/dist/specbook.tgz`, both anonymous downloads returned 200 and matched the local archive's SHA-256 hash.

`docker build -t specbook-connect-cli:verification .` passed. The runtime image contained the same tarball bytes, and its bundled backend served them with 200 and `application/gzip` before creating any admin account. The build context includes the CLI documentation needed by `prepack` while excluding the other documentation files.

This exact command ran from a disposable workspace with a new npm cache at `/tmp/specbook-cli-url-cache-KqKLge` and `SPECBOOK_URL=http://127.0.0.2:4101/api`:

```sh
npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci --environment Production --spec-ids "$SPECBOOK_SPEC_IDS" --json
```

It exited 0, reported a passing remote browser run and wrote the self-contained HTML report, JUnit and Markdown summary. The npm lockfile recorded `http://127.0.0.2:4101/api/cli/specbook.tgz` as the package source. The project token stayed in the environment; the download needed no token. Logs and the command transcript are under `/tmp/specbook-cli-delivery-verification/`.

`pnpm -r build` and backend, frontend and CLI `npx tsc --noEmit` passed. The existing backend tests finished with 333 of 334 passing; only the allowed OpenAI sign-in test failed because callback port 1455 was occupied. Download tests cover public access, binary content, missing-package guidance and rejection of uploads. All five pipeline snippets select the server package, and a repository scan found no instructions that select the CLI by its registry name.

Remote phase verification
-------------------------

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

Conversation verification
-------------------------

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

Earlier phase verification
--------------------------

`pnpm -r build` and each package's `tsc --noEmit` passed. Existing backend tests finished with 326 of 327 passing; the only failure was the documented OpenAI subscription sign-in test because callback port 1455 was occupied.

The built CLI and an independently installed package tarball ran the handwritten login Specs against SauceDemo and a localhost page. Checks covered initialization, scaffolding, credentials add/list/remove with a 0600 store, static validation, fresh signed-out runs, evidence, and self-contained reports. A deliberate nonsecret failure produced its per-step screenshot, failed-step context and failure video; secret runs disabled video and masked inputs, reflected text and shadow-root text. Text artifacts contained none of the configured credential values.

Browser checks on both targets covered persistent sessions, snapshot refs, secret filling, inspection, clicks, origin blocking, cleanup, and locator counts of zero, one and several matches. Credentials containing quotes and backslashes also stayed out of valid JSON responses.

Real authenticated Codex created a Cart Spec in one run. The final restricted Codex and Claude adapters each verified that existing Spec in one run with no writes. The loopback request-inventory script confirmed their available tools and checked credential redaction, forbidden writes, path traversal, symlinks and the three-run limit after an MCP restart. Timeout and cancellation checks returned the expected statuses and killed descendants that ignored SIGTERM. Run that unbilled adapter probe with `pnpm --dir apps/cli exec tsx scripts/check-agent-wiring.mjs`; it needs the supported agents installed and a local login or API key so the adapters can initialize authentication, while all model requests go to its loopback stub.

All disposable workspaces and credential stores used `/tmp`, and the checks left the developer servers on ports 4000 and 4001 alone. Docker wiring was updated for the shared runtime; this environment did not build a container image. The CLI tarball was packed and installed locally, and `npx --package <local-tarball> specbook --version --json` passed. The installed tarball also verified the existing Cart Spec through Codex in one run with no writes. Nothing was published. Windows and macOS behavior remains untested.
