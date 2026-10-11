Specbook CLI: standalone local mode
==================================

Specbook keeps readable behavior contracts beside restricted Playwright tests. The local CLI needs no Specbook server and no model configured in Specbook. `create` and `verify` use your installed, authenticated Claude Code or Codex session.

Build this checkout with Node.js 22 or newer and pnpm:

```sh
pnpm install
pnpm -r build
node packages/cli/dist/index.js --help
# From another directory:
node /absolute/path/to/specbook/packages/cli/dist/index.js --help
```

For another project, pack the CLI and install its tarball. The package bundles the shared runtime, its test fixtures, report fonts, writing rules and this document at `dist/README.md`; it doesn't need the monorepo after installation.

```sh
pnpm --filter specbook pack --pack-destination /tmp
cd /path/to/your/app
npm install -g /tmp/specbook-0.1.0.tgz
specbook init --base-url http://localhost:3000 --agent codex
```

The package name and bin are both `specbook`; after an npm release, `npx specbook` runs the same program. This branch doesn't publish a release. Chromium downloads on the first browser command if it isn't installed. On Linux, missing platform libraries may require `npx playwright install-deps chromium`. Progress goes to stderr; `--json` emits one JSON result on stdout, including errors. Failed checks, runs, or agent sessions return a nonzero exit status.

Each command
------------

| Command | Behavior |
| --- | --- |
| `init --base-url <url> [--agent claude\|codex]` | Create the workspace, detect installed agents, and install coding-agent instructions. Without `--base-url`, prompt on a terminal. Existing config and agent skill files aren't overwritten. |
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
| `create "<behavior>" [--agent claude\|codex] [--timeout <seconds>]` | Ask the local agent to explore, write, check and run a Spec, correcting it within a three-run limit. |
| `verify "<behavior>" [--agent claude\|codex] [--timeout <seconds>]` | Ask the local agent to select and run existing coverage; create a Spec when coverage is missing. |

Every command supports `--json`. Selectors accept `feature/slug`, `specs/feature/slug`, `.specbook/specs/feature/slug/spec.ts`, an absolute Spec path, a unique slug, or a feature slug. The run command validates source before starting Playwright; a live locator check describes the exploration page's current state, so a locator used after navigation may correctly match nothing now.

Workspace files
---------------

```text
.specbook/
  config.yml                 # version, baseUrl, agent
  .gitignore                 # excludes runs/
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
```

`init` also installs `.agents/skills/specbook/SKILL.md` and `.claude/skills/specbook/SKILL.md`. The CLI copies the writing rules from `@specbook/runtime`; the backend includes that same source in its system prompt. The contract format remains `title`, `description`, `preconditions`, `steps`, `expectedResult`, and `postconditions`. Tests import `test` and `expect` from `"specbook"`; they use named `step()` blocks whose titles match the YAML steps in order. The shared validator rejects arbitrary JavaScript, imports, filesystem access and browser evaluation.

Run evidence includes screenshots after each browser step, API request evidence where applicable, failure context and diagnostics. Failure video is available for runs without secrets. Runs with secret environment values disable video and traces; screenshots mask fields and visible DOM text containing known credential values. Temporary Playwright files disappear after execution. Reports embed their fonts, screenshots and eligible videos, so they can be opened offline.

Exploration runs in a detached process with a private local socket (a named pipe on Windows). Sessions persist across CLI commands and expire after 30 idle minutes. Refs come from the latest accessibility snapshot; navigation invalidates them. Exploration state never becomes a run's storage state. Each run starts signed out.

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

`create` and `verify` start a fresh noninteractive agent session in a temporary directory outside the app. The CLI starts a stdio MCP server for that session. Tool schemas come from Zod via `.toJSONSchema()`; the agent receives only exploration commands, credential metadata, restricted Spec file reads/writes, static and live checks, and single-Spec runs. The MCP server enforces at most three attempts per Spec across the session, including failed runs; restarting the MCP connection doesn't reset the saved counter. The agent selects behavioral coverage from readable contracts rather than a keyword heuristic.

The default time limit is 600 seconds. Set `--timeout` to 1–3600 seconds; Ctrl-C cancels the agent and its child processes. Progress goes to stderr, while the final result includes run and evidence paths. Spec files and completed evidence survive cancellation; session configuration and temporary authentication copies don't.

Claude Code receives the behavior on stdin with this command (angle-bracket values identify session-specific paths or instruction text):

```sh
claude -p --output-format stream-json --verbose \
  --tools '' --restricted --strict-mcp-config \
  --mcp-config '<temporary-mcp.json>' --setting-sources '' \
  --settings '{"disableAllHooks":true}' \
  --allowedTools 'mcp__specbook__*' --permission-mode dontAsk \
  --disable-slash-commands --no-session-persistence --no-chrome \
  --system-prompt '<shared rules and local workflow>'
```

The session sets `CLAUDE_CONFIG_DIR` to a temporary directory holding a 0600 copy of the user's file-backed OAuth login. API-key authentication also works. Empty `--tools` disables built-in file and shell tools, strict MCP configuration admits only the Specbook server, and hooks, user settings, slash commands and Chrome integration stay disabled. Versions without these flags fail before starting the agent. macOS keychain-only logins need an API key or a file-backed login.

Codex receives the behavior on stdin through `codex exec`:

```sh
codex --no-daemon exec --ignore-user-config --ignore-rules --ephemeral \
  --skip-git-repo-check --sandbox read-only --strict-config \
  --json --color never --cd '<isolated-cwd>' \
  -c 'approval_policy="never"' -c 'web_search="disabled"' \
  -c 'project_doc_max_bytes=0' \
  -c 'model_catalog_json="<restricted-bundled-catalog>"' \
  -c 'developer_instructions="<shared rules and local workflow>"' \
  -c 'tools.update_plan.enabled=false' \
  -c 'tools.experimental_request_user_input.enabled=false' \
  -c 'mcp_servers={specbook={command="<node>",args=["<cli>","--mcp","<workspace>","<session>"],env={SPECBOOK_HOME="<home>"},required=true,startup_timeout_sec=30,tool_timeout_sec=300,default_tools_approval_mode="approve"}}' \
  <one -c features.NAME=false argument for each supported disabled feature> -
```

The session sets `CODEX_HOME` to a temporary directory holding a 0600 copy of the user's `auth.json`; an API-key login also works. It reads the installed agent's bundled catalog through `codex debug models --bundled`, then disables each model's patch tool, shell, experimental tools, code execution, Node REPL, Responses Lite tool mode, multi-agent mode and search. The exported `disabledCodexFeatures` list in `packages/cli/src/agent.ts` supplies the last command arguments; it contains `shell_tool, apps, hooks, plugins, remote_plugin, multi_agent, multi_agent_v2, image_generation, view_image, browser_use, browser_use_external, computer_use, code_mode, code_mode_host, code_mode_only, code_mode_tool_search, goals, memories, skill_search, skill_mcp_dependency_install, sleep_tool, shell_snapshot, request_permissions_tool, send_message_to_user_async, token_budget, tool_suggest` and emits an override only when the installed Codex reports that feature. User configuration, project rules, plugins, hooks, web search and native planning/input tools stay disabled. Unsupported catalog layouts or required flags fail before an unrestricted agent can start.

Installed Codex also advertises its built-in `list_mcp_resources`, `list_mcp_resource_templates`, and `read_mcp_resource` wrappers whenever MCP is enabled. They address only the isolated Specbook server, which advertises no resources or templates; they cannot read app files or run commands. The request-inventory check records these inert wrappers separately. Claude exposes exactly the twelve Specbook tools.

Both agents launch the same stdio server through `node <cli> --mcp <workspace> <session>`. Its twelve tools are `browse_open`, `browse_snapshot`, `browse_click`, `browse_fill`, `browse_inspect`, `browse_close`, `credentials_list`, `spec_list`, `spec_read`, `spec_write`, `spec_check`, and `run_spec`. Reads and writes accept only the existing Spec layout beneath `.specbook/specs`; there is no app-file tool or arbitrary command tool. The installed agent skill covers the manual CLI workflow, while these restricted sessions receive the shared writing rules directly.

Single-executable investigation
-------------------------------

The executable probe used Bun 1.3.14 and the repository's Playwright 1.62.0. A direct `bun build --compile` failed on optional `chromium-bidi` imports; excluding those imports produced a binary that successfully launched Chromium and read a page. That wasn't enough for the Spec runtime: it resolves `@playwright/test/cli` from disk, writes test modules and fixtures to disk, and starts Playwright with `process.execPath`. In a Bun-compiled program, that path is the compiled application; the runner probe invoked itself recursively instead of the Playwright CLI. The probe processes were stopped.

Node SEA also requires bundling or extracting runtime modules and assets. The current Playwright child-process protocol needs a dedicated embedded-runner entry mode plus filesystem extraction before either option can support the shared runner reliably. This task ships an npm package instead of claiming a portable binary. Windows and macOS binary packaging remain unverified. References: [Bun executable documentation](https://bun.sh/docs/bundler/executables) and [Node SEA documentation](https://nodejs.org/download/release/latest-jod/docs/api/single-executable-applications.html).

Gaps and scope
--------------

This work implements the local modes. It doesn't connect to a remote server or implement `publish`, `ci`, a private-network runner, or `serve`. The backend now imports the same runtime package, leaving server mode open for a later phase. Remote vault synchronization, encrypted credential storage, and additional browsers also remain outside this task. Agent availability, authentication, subscription limits, and supported CLI flags depend on the installed coding-agent versions; unsupported restricted-mode configurations fail without granting broader tools.

Verification in this worktree
----------------------------

`pnpm -r build` and each package's `tsc --noEmit` passed. Existing backend tests finished with 326 of 327 passing; the only failure was the documented OpenAI subscription sign-in test because callback port 1455 was occupied.

The built CLI and an independently installed npm tarball ran the handwritten login Specs against SauceDemo and a localhost page. Checks covered initialization, scaffolding, credentials add/list/remove with a 0600 store, static validation, fresh signed-out runs, evidence, and self-contained reports. A deliberate nonsecret failure produced its per-step screenshot, failed-step context and failure video; secret runs disabled video and masked inputs, reflected text and shadow-root text. Text artifacts contained none of the configured credential values.

Browser checks on both targets covered persistent sessions, snapshot refs, secret filling, inspection, clicks, origin blocking, cleanup, and locator counts of zero, one and several matches. Credentials containing quotes and backslashes also stayed out of valid JSON responses.

Real authenticated Codex created a Cart Spec in one run. The final restricted Codex and Claude adapters each verified that existing Spec in one run with no writes. The loopback request-inventory script confirmed their available tools and checked credential redaction, forbidden writes, path traversal, symlinks and the three-run limit after an MCP restart. Timeout and cancellation checks returned the expected statuses and killed descendants that ignored SIGTERM. Run that unbilled adapter probe with `pnpm --filter specbook exec tsx scripts/check-agent-wiring.mjs`; it needs the supported agents installed and a local login or API key so the adapters can initialize authentication, while all model requests go to its loopback stub.

All disposable workspaces and credential stores used `/tmp`, and the checks left the developer servers on ports 4000 and 4001 alone. Docker wiring was updated for the shared runtime; this environment did not build a container image. The npm package was packed and installed locally, and `npx --package <local-tarball> specbook --version --json` passed. The installed tarball also verified the existing Cart Spec through Codex in one run with no writes. Nothing was published. Windows and macOS behavior remains untested.
