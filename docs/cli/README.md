Specbook CLI: local verification and team publishing
===================================================

Specbook keeps readable behavior contracts beside restricted Playwright tests. Start a `chat` with the behavior you want covered; Specbook uses your installed, authenticated Claude Code or Codex as its brain, asks for missing details, and creates or runs Specs. The local CLI needs no Specbook server and no model configured in Specbook.

Install the CLI from your team's Specbook server with Node.js 22 or newer:

```sh
npm install -g https://specbook.example.com/api/cli/specbook.tgz
specbook init --base-url http://localhost:3000 --agent codex
```

The server serves its own CLI tarball without authentication at `/api/cli/specbook.tgz` through the frontend, or `/cli/specbook.tgz` on the backend. The package bundles the shared runtime, its test fixtures, report fonts, writing rules and this document at `dist/README.md`; it doesn't need the monorepo after installation.

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

Create a named personal token under **Settings → Access tokens** in the hosted web app. Copy it when shown; the server stores its hash and shows creation and last-use times. Revoking it stops future requests immediately. A token has the user's current permissions, including changes to their role or account access.

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
        evidence/execution.webm
  chats/
    c-7f3a91b2/
      conversation.json      # history, status, proposals, Specs, brain session id
      brain/                 # isolated agent home, session and tool state
```

`init` also installs `.agents/skills/specbook/SKILL.md` and `.claude/skills/specbook/SKILL.md`. These instructions teach the user's coding agent to start a chat, answer or select according to its status, hand credential entry to the human and stop at `done`. Existing agent skill files aren't overwritten; copy `.specbook/SKILL.md` over them when upgrading an existing workspace. The CLI copies the writing rules from `@specbook/runtime`; the backend includes that same source in its system prompt. The contract format is `title`, `description`, `preconditions` (the starting state), `steps`, `expectedResult` (the final state the user sees) and `postconditions` (side effects checked afterwards, usually none). Tests import `test` and `expect` from `"specbook"` and have one named `step()` per precondition, per step, for the expected result and per postcondition, in that order, so every run records a screenshot of the expected result. An optional leading `cleanup()` block removes data the Spec creates; it runs after the test, even on failure, and stays out of the contract and evidence. The shared validator rejects arbitrary JavaScript, imports, filesystem access and browser evaluation.

Run evidence includes screenshots after each browser step, API request evidence where applicable, failure context and diagnostics. Failure video is available for runs without secrets. Runs with secret environment values disable video and traces; screenshots mask fields and visible DOM text containing known credential values. Temporary Playwright files disappear after execution. Reports embed their fonts, screenshots and eligible videos, so they can be opened offline.

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

The CLI supports local verification, remote publishing and CI. Conversations still use the installed local coding agent in connected workspaces. Server-hosted conversations, a private-network runner and `serve` remain outside this phase.

Conversation cancellation, deletion and queued follow-ups aren't implemented. A working turn rejects new input with `working`; send it again after the turn finishes. Conversation histories stay on disk under the ignored `chats/` directory, and credential metadata stays in history after a request. Authentication copies disappear after each turn, while agent session files remain for resumption. The CLI rejects known stored secrets in messages and redacts reply prose, while preserving structural ids and statuses. It can't identify a secret that was never saved in the credential store; never paste one into chat.

Remote vault synchronization, encrypted credential storage and additional browsers remain outside this task. Agent availability, authentication, subscription limits and supported CLI flags depend on the installed coding-agent versions; unsupported restricted-mode configurations fail without granting broader tools. Windows and macOS conversation behavior remains untested.

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
