# Specbook CLI

Specbook keeps readable behavior contracts beside restricted Playwright tests. Start a `chat` with the behavior you want covered; Specbook uses your installed, authenticated Claude Code or Codex as its brain, asks for missing details, and creates or runs Specs. The local CLI needs no Specbook server and no model configured in Specbook.

## Install

Install the latest release with Node.js 22.19.0 or newer:

```sh
npm install -g https://github.com/gustavo-ferreira03/specbook/releases/latest/download/specbook.tgz
specbook init --base-url http://localhost:3000 --agent codex
```

A team that runs a Specbook server can install the CLI that matches it from `https://specbook.example.com/api/cli/specbook.tgz` instead. Releases attach `specbook.tgz` with a `.sha256` checksum.

A server also serves its own CLI tarball without authentication at `/api/cli/specbook.tgz` through the frontend, or `/cli/specbook.tgz` on the backend. The package bundles the shared runtime, its test fixtures, report fonts, writing rules, this document at `dist/README.md` and the Kubernetes examples at `dist/examples`; it doesn't need the monorepo after installation.

Chromium downloads on the first browser command if it isn't installed. On Linux, missing platform libraries may require `npx playwright install-deps chromium`. By default each command prints a colored summary with the next commands to run (built on commander, @clack/prompts and picocolors; `NO_COLOR` disables color). Spinners and prompts go to stderr. `--json` emits one JSON result on stdout, including errors, and never prompts. Failed checks, runs, or conversation turns return a nonzero exit status.

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
node apps/cli/scripts/package.mjs apps/backend/dist/specbook.tgz
npm install -g ./apps/backend/dist/specbook.tgz
cd /path/to/your/app
specbook init --base-url http://localhost:3000 --agent codex
```

The packaging helper builds the CLI and bundles its tested model-provider dependencies using the repository's production lockfile. Use this helper to produce installable archives. You can also run the downloaded package without installing it globally with `npx --yes --package="https://specbook.example.com/api/cli/specbook.tgz" specbook --help`. The executable is named `specbook`; the tarball URL selects this project's package.

## Write and run Specs

Start with `specbook chat` and keep using the conversation id it returns for answers, selection and changes:

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

Conversation cancellation, deletion and queued follow-ups aren't implemented. A working turn rejects new input with `working`; send it again after the turn finishes. Conversation histories stay on disk under the ignored `chats/` directory, and credential metadata stays in history after a request. Authentication copies disappear after each turn, while agent session files remain for resumption. The CLI rejects known stored secrets in messages and redacts reply prose, while preserving structural ids and statuses. It can't identify a secret that was never saved in the credential store; never paste one into chat.

The workspace keeps Specs, runs and conversations side by side:

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

Credentials live in `$SPECBOOK_HOME/credentials.json`, defaulting to `$XDG_CONFIG_HOME/specbook/credentials.json` or `~/.config/specbook/credentials.json`. The file has mode 0600 on Unix; new configuration directories have mode 0700. Windows uses normal user filesystem permissions. The store contains profile fields and optional allowed origins, without encryption or an OS keychain.

Supply noninteractive values through stdin, preferably from your existing password manager. Don't put values in shell arguments or Specs:

```sh
password-manager-command | specbook credentials add shop --stdin-json --origin https://www.saucedemo.com
specbook credentials list --json
specbook browse fill e2 --secret shop.username --json
```

The stdin JSON shape is `{"fields":{"username":"...","password":"..."},"origins":["https://www.saucedemo.com"]}`; a plain mapping of string fields also works. If origins are omitted, credentials can be used only at the selected workspace's base origin. Profile names match remote vault names. Tests resolve `secret("shop", "password")` at execution time. Agent tools expose only profile metadata, redact known values from text, and reject Spec writes that contain a stored credential value.

Use `SPECBOOK_HOME=/tmp/my-specbook-home` to keep disposable verification credentials out of your real user configuration.

## Run in CI

Without `SPECBOOK_URL` or `--url`, `specbook ci` runs the Specs in the current directory's `.specbook/` like `run`, with no login or token. Select a Spec or feature by path, as with `run`. `--base-url` or `SPECBOOK_BASE_URL` points the run at the app the pipeline started, or at a preview deploy, instead of the workspace's base URL.

Each `secret("profile", "field")` reads `SPECBOOK_SECRET_<PROFILE>_<FIELD>` first, then the local profiles; `run` follows the same order. An environment value reaches only the base URL's origin unless `SPECBOOK_SECRET_<PROFILE>_ORIGINS` lists others. Fields set only in the environment are masked in evidence, except `username`, `user`, `email`, `login` and `identifier`.

The command writes `specbook-report.html`, `specbook-junit.xml` and `specbook-summary.md` with the same path options and comment providers as the server mode below, and exits 1 when any Spec fails or errors. JUnit failures start with the failed step. Retries, flaky and known-bug handling, environments and awaiting deploy belong to the server, so `--environment`, `--feature-id`, `--spec-ids`, `--fail-on-flaky` and `--fail-on-known-bugs` are rejected here. A `SPECBOOK_TOKEN` or `SPECBOOK_PROJECT` without `SPECBOOK_URL` stops the job instead of running the repository's Specs. `--timeout` limits the whole run.

With a Specbook server, `specbook ci` runs the server's Specs instead. Create a project CI token in **Project settings → Automation → CI access**. Personal tokens are for connecting, pulling and publishing; pipelines use the project CI token.

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

Optional `--comment github|gitlab|none` (or `SPECBOOK_COMMENT_PROVIDER`) updates a single pipeline summary comment per project. GitHub uses `GITHUB_TOKEN`, `GITHUB_REPOSITORY` and the pull-request event or `SPECBOOK_PR_NUMBER`; give the job `pull-requests: write` permission. GitLab uses `SPECBOOK_GITLAB_TOKEN` with API scope and the merge-request job variables; `CI_JOB_TOKEN` cannot publish notes. Provider tokens go only to their provider, and missing PR/MR context skips commenting. Report files remain available if commenting fails. The server's run, result and deploy HTTP APIs remain available; the downloaded `client.mjs` has been removed.

## Share Specs through a server

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

A changed Spec published through the CLI starts as `awaiting_deploy` in the chosen environment. The app and run reports display a clock icon and **Waiting for deploy**. Failed runs retain screenshots and failure details without starting retries, failure triage or Inbox items, and they don't count as failing health or fail CI's quality gate. JUnit marks these failures as skipped with `Waiting for deploy`.

The first passing run in that environment promotes the Spec to regular passing status. Later failures follow the usual acceptance-check workflow. A passing run in another environment doesn't promote it. Publishing changed files resets the chosen environment to awaiting deployment; publishing identical files doesn't reset an already promoted Spec. Historical runs retain their original classification. Local CLI runs skip model-based evidence review; existing server evidence review still applies where configured.

## Reach private networks

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

For ephemeral processes and containers:

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

For autoscaling, `GET /runner/metrics` accepts a runner token or an admin personal token in the Authorization bearer header. Runner tokens see only their group and project scope; metrics requests do not make a worker appear online. `?group=lab` selects one group, and `?group=` selects ungrouped work. Configured groups remain present with zero depth after the queue drains.

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

`login`, `connect`, `pull`, `publish`, `ci`, `runner` and `tunnel` honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, including lowercase forms. HTTPS and secure WebSockets prefer `HTTPS_PROXY`, falling back to `HTTP_PROXY`; HTTP uses `HTTP_PROXY`. `NO_PROXY` accepts comma-separated hosts, domain suffixes, optional ports and `*`.

Inject proxy URLs, including any credentials, through your secret store. The CLI scrubs full proxy URLs, username/password variants and basic-auth values from errors and output. These proxy variables configure the outbound control connection to Specbook; application traffic still follows the runner or tunnel's environment network policy. Install your organization's CA and set `NODE_EXTRA_CA_CERTS` when it signs the server or proxy certificate.

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
{
  "fields": { "password": "<value from your secret store>" },
  "origins": ["https://private-app.example.com"]
}
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

Instead of a runner, an environment can use **Server through a tunnel**: the server's own browsers reach the private app through an outbound connection. Choose **Server through a tunnel** in the environment settings and set a runner group. Create a token with **Tunnel** purpose restricted to that group and, preferably, the project. Runner-purpose tokens cannot open tunnels, and tunnel-purpose tokens cannot claim runner jobs. Open the outbound tunnel from a machine that can resolve and reach the private application:

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

## Host the server with the CLI

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

## How a conversation runs

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

## Command reference

| Command | Behavior |
| --- | --- |
| `init --base-url <url> [--agent claude\|codex]` | Create the workspace, detect installed agents, and install coding-agent instructions. Without `--base-url`, prompt on a terminal. Existing config and agent skill files aren't overwritten. |
| `login <server-url> [--stdin]` | Verify a personal access token and save this server login outside the workspace. Use a hidden terminal prompt or stdin. The most recent login becomes the default. |
| `logout [url]` | Remove a saved login; default to the most recent server. This doesn't revoke the token on the server. |
| `connect [project] [--server <url>] [--environment <name>]` | Link the workspace to a visible project by id, name or interactive selection. Default to the latest server login and the project's Production environment. |
| `pull` | Download remote features and Specs with their revisions. Preserve unpublished local edits and report conflicts with exit status 1. |
| `publish [spec\|feature] [--run] [--environment <name>]` | Publish selected Specs after a passing local run of their exact current files. Check their base revisions and start changed Specs as awaiting deployment in one environment. |
| `ci [spec\|feature] [--base-url <url>] [--comment github\|gitlab]` | Without a server URL, run this repository's Specs and write HTML, JUnit and Markdown artifacts for the pipeline. With `SPECBOOK_URL`, trigger the server's acceptance checks with a project CI token instead. |
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

Each server command emits one JSON object with `--json`, never the token or credential values. These are the stable fields:

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

Without a server, `specId` is the Spec path, `runId` the local run and `url` is absent. The CI result preserves raw execution status (`failed` or `error`) alongside `awaitingDeploy`; use `failsGate` for a pipeline decision. `qualityGate.awaitingDeploy` counts waiting failures. Local `run` results now include `hashes: { specTs, specYaml }` on each Spec result. Most errors return `{ ok: false, error }` and exit 1; a stale publish adds `{ code: "revision_conflict", conflicts: [{ path, revision: string|null }], command: "specbook pull" }`. Pull conflicts return the normal pull result with exit 1.

Development notes from earlier phases, including verification transcripts and the single-executable investigation, are in [development-notes.md](development-notes.md).
