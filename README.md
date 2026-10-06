# <img src="apps/frontend/public/specbook-chat-icon.svg" width="32" height="32" align="absmiddle" alt=""> Specbook

Specbook turns a conversation about a web application into a readable, executable Spec. You describe a flow in chat, watch the agent inspect the application in a visible browser, then review the YAML and Playwright Test files it writes.

Every project gets its own Git repository. Specs, Features, and confirmed project context remain ordinary files that a team can inspect and edit; SQLite only indexes them for the application.

## Why use Specbook?

- **Keep behavior near the code.** Each project has a Git repository with a real commit history rather than opaque test records in a database.
- **Watch the agent work.** Chromium runs headed and appears in the interface while the agent investigates the application.
- **Read the check before running it.** `spec.yml` holds the behavior in plain language and `spec.ts` holds its executable counterpart, a restricted Playwright Test file with one named step per Spec step.
- **Leave with evidence.** Runs retain status, duration, the failed step, a screenshot per step, failure video, and a Playwright HTML report where available.
- **Start with the product you have.** Guided discovery maps areas, terms, roles, rules, and unknowns before a Spec chat begins.
- **Use a normal Git remote.** Each project can issue a scoped access token for standard clone, fetch, and push over Smart HTTP.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). The image includes Chromium, Playwright MCP, Playwright Test, Xvfb, and x11vnc.

```bash
docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --shm-size=1g \
  -p 127.0.0.1:4000:4000 \
  -p 127.0.0.1:4001:4001 \
  -p 127.0.0.1:1455:1455 \
  -p 127.0.0.1:53692:53692 \
  -e HOST=0.0.0.0 \
  -e FRONTEND_ORIGIN=http://localhost:4001 \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v specbook-storage:/app/apps/backend/storage \
  ghcr.io/gustavo-ferreira03/specbook:latest
```

Open [http://localhost:4001](http://localhost:4001), then select an LLM provider and model in **Settings**. Specbook accepts API keys from its model registry plus OAuth connections for Anthropic, OpenAI Codex, and GitHub Copilot.

```bash
curl http://localhost:4000/health
docker logs -f specbook
```

The same setup is available as `docker compose up -d` with the repository's `docker-compose.yml`. The image runs under `tini`, drops to the unprivileged `node` user after fixing ownership of the storage volume, and reports health through `/health`. `:latest` and version tags track releases; `:main` and `:sha-<commit>` are preview builds of every commit on `main` that passes CI.

> [!TIP]
> `specbook-storage` is a named Docker volume. You can remove and recreate the container without deleting projects, provider credentials, chat sessions, or run evidence.

> [!WARNING]
> Specbook has no application-level authentication. The command above publishes its ports on `127.0.0.1` only. To reach it from other machines, drop the `127.0.0.1:` prefixes, add the public host names to `SPECBOOK_ALLOWED_HOSTS`, and keep it on a trusted network or behind a firewall, VPN, IP allowlist, or authenticated reverse proxy.

### Clone a project repository

Open **Settings → GitHub** in a project and create a repository access token. The token is shown once. Use `specbook` as the username when Git prompts for credentials:

```bash
git clone https://your-specbook-host/git/<project-id>.git
# Username: specbook
# Password: the one-time project token
```

The repository accepts the `main` branch only. Generated files and edits made in Specbook are committed before the remote is advertised, and pushes are reindexed into the project after they complete. Rotating or revoking the token immediately prevents new Git requests; existing connections must authenticate again.

## Your first Spec

1. Create a project with the application's base URL.
2. Run guided discovery, or start a Spec chat immediately.
3. Describe one behavior while the agent uses the visible browser and asks for missing details.
4. Review the files and their Git history, then run the Spec whenever the application changes.

> [!NOTE]
> Discovery stays within the project origin and uses read-oriented browser actions. Its origin guard and safety rules are not a network sandbox, so use a disposable or staging application when possible. Never paste passwords, private keys, one-time codes, or production tokens into chat.

## Features

<details open>
<summary><strong>Authoring and project context</strong></summary>

- A visible, headed Chromium session for agent exploration and authoring
- Guided discovery that drafts project context for later chats
- Direct editing of YAML and TypeScript files with syntax highlighting
- SSE updates for live chat activity without polling
</details>

<details>
<summary><strong>Git-backed project files</strong></summary>

- One repository per project under `storage/repos/<project-id>`
- One canonical bare remote per project under `storage/git/<project-id>.git`
- Path and slug identify a Spec; YAML files contain no database IDs
- Standard Git history for generated and manual changes
- SQLite reindexing keeps the UI in sync with files and external Git updates
</details>

<details>
<summary><strong>Verification and evidence</strong></summary>

- Run one Spec, a Feature subtree, or an entire project
- Playwright Test execution in headless Chromium, one worker per run
- `spec.ts` is validated against an allowlist of Playwright calls before it is stored or run, and runs with a restricted `page`, origin-checked navigation and origin-checked secrets
- Status, timing, failed step, step screenshots, failure video, and the HTML report (for runs without secrets) retained with each run
- Single runs time out after 120 seconds; batch runs scale by Spec count and stop at 30 minutes
</details>

## Project layout

Specbook stores application data in `apps/backend/storage` locally, or `/app/apps/backend/storage` inside the container.

```text
storage/
├── specbook.db       # SQLite index and application state
├── pi-auth.json      # LLM provider credentials
├── chat/             # Chat sessions and browser profiles
├── repos/            # One Git repository per project
├── git/              # Canonical bare repositories served over Smart HTTP
├── metrics/          # chat-turns.jsonl evaluation metrics
└── runs/             # Results, reports, screenshots, video, and batch state
```

A project repository looks like this:

```text
context.yml
features/<feature>/feature.yml
specs/<feature>/<spec>/spec.yml
specs/<feature>/<spec>/spec.ts
```

`spec.yml` holds the human-facing behavior and `spec.ts` executes it:

```ts
import { test, expect } from "specbook";

test("Sign in with valid credentials", async ({ page, step, secret }) => {
    await step("Open the sign-in page", async () => {
        await page.goto("/login");
    });
    await step("Enter the account email and password", async () => {
        await page.getByLabel("Email").fill("ana@acme.test");
        await page.getByLabel("Password").fill(secret("shopper", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("See the dashboard", async () => {
        await expect(page.getByRole("heading")).toHaveText(/Welcome back/);
    });
});
```

The file may contain only this shape: one import from `specbook`, one `test`, and `step` blocks whose titles are the `steps` of `spec.yml`, in order. Inside a step, only awaited `page`/locator actions (`goto` with a path, `click`, `fill`, `getByRole`, ...) and `expect` assertions with literal arguments are accepted; anything else makes the Spec invalid. `secret(profile, field)` types a credential value at run time, only on the project origin or the profile's allowed origins.

<details>
<summary><strong>Configuration and public deployments</strong></summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Public API URL embedded in the frontend at image build time |
| `FRONTEND_ORIGIN` | `http://localhost:4001` | Frontend origin accepted by CORS and VNC WebSocket checks |
| `HOST` | `127.0.0.1` | Backend bind address; the Docker command sets `0.0.0.0` |
| `PORT` | `4000` | Backend HTTP and WebSocket port |
| `SPECBOOK_STORAGE_DIR` | `apps/backend/storage` | Data, credentials, project repositories, and run artifacts |
| `SPECBOOK_ALLOWED_HOSTS` | none | Extra comma-separated `Host` header values the API answers; an entry without a port matches any port, `*` disables the check |
| `SPECBOOK_PUBLIC_API_URL` | request host | Base URL shown for `git clone` |
| `TRUST_PROXY` | `false` | Set to `true` or `1` when a reverse proxy sets `X-Forwarded-Host`/`X-Forwarded-Proto`; only then are they used for clone URLs |
| `SPECBOOK_MAX_CONCURRENT_RUNS` | `2` | Playwright Test executions (single runs and batches) that may drive a browser at once |
| `SPECBOOK_GIT_MAX_PUSH_BYTES` | `209715200` (200 MiB) | Largest push accepted by the Smart HTTP remote |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Bind address of the OAuth callback listeners; the Docker command sets `0.0.0.0` |
| `LOG_LEVEL` | `info` | Backend JSON log threshold: `debug`, `info`, `warn`, `error`, or `silent` |

The API only answers requests whose `Host` header is `localhost`, `127.0.0.1`, or `[::1]` on `PORT`, the host of `FRONTEND_ORIGIN`, `NEXT_PUBLIC_API_URL`, or `SPECBOOK_PUBLIC_API_URL`, or an entry of `SPECBOOK_ALLOWED_HOSTS`; other hosts get `421`. This blocks DNS rebinding. State-changing requests must also carry `X-Specbook-Request: 1`, which the frontend sends and a cross-site form cannot. Git Smart HTTP under `/git/` is exempt from both checks because every request authenticates with a project token.

| Port | Purpose |
| --- | --- |
| `4000` | Backend API, VNC WebSocket, and Git Smart HTTP |
| `4001` | Web interface |
| `1455` | OAuth callback for OpenAI Codex (`http://localhost:1455/auth/callback`) |
| `53692` | OAuth callback for Anthropic |

The OAuth callbacks are only used while you connect a provider in **Settings**. The provider redirects your browser to `localhost` on those ports, so they must be reachable from the machine running the browser (for a remote host, publish them or forward them with `ssh -L`).

The live browser stream is served by x11vnc on loopback with a random per-session password. The backend authenticates to it and relays the stream over the `/vnc/<session-id>` WebSocket, so the password never leaves the server.

For separate public frontend and API URLs, build the image with the public API URL, then set the frontend origin at runtime:

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://specbook-api.example.com \
  -t specbook:public .

docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --shm-size=1g \
  -p 4000:4000 \
  -p 4001:4001 \
  -p 1455:1455 \
  -p 53692:53692 \
  -e HOST=0.0.0.0 \
  -e FRONTEND_ORIGIN=https://specbook.example.com \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v specbook-storage:/app/apps/backend/storage \
  specbook:public
```
</details>

<details>
<summary><strong>Development</strong></summary>

Local development targets Linux because browser sessions need Xvfb and x11vnc. Install Node.js 26, pnpm 10.30.1, Xvfb, and x11vnc.

```bash
pnpm install
pnpm --filter backend browser:install

pnpm --filter backend db:migrate
pnpm dev
```

The backend listens on `4000` and the frontend on `4001`. `browser:install` downloads the Chromium builds of Playwright MCP and Playwright Test.

| Task | Command |
| --- | --- |
| Type-check both apps | `pnpm typecheck` |
| Build both apps | `pnpm build` |
| Run the tests | `pnpm test` |
| Type-check and test | `pnpm check` |
| Install the MCP browser | `pnpm --filter backend browser:install` |
| Create a database migration | `pnpm --filter backend db:generate` |
| Apply database migrations | `pnpm --filter backend db:migrate` |
| Export chat metrics as CSV | `node apps/backend/scripts/export-metrics.mjs [--runs] [--out file.csv]` |

The backend applies pending migrations from `apps/backend/drizzle` at startup, so `db:migrate` is only needed to migrate without starting the server. Each chat turn appends evaluation metrics to `storage/metrics/chat-turns.jsonl`; `scripts/export-metrics.mjs` converts that file to CSV, one row per turn or, with `--runs`, one row per `run_spec` call.
</details>

Questions, ideas, and bug reports belong in [GitHub Discussions](https://github.com/gustavo-ferreira03/specbook/discussions) and [Issues](https://github.com/gustavo-ferreira03/specbook/issues).
