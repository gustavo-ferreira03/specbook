# <img src="apps/frontend/public/specbook-chat-icon.svg" width="32" height="32" align="absmiddle" alt=""> Specbook

[![Container build](https://github.com/gustavo-ferreira03/specbook/actions/workflows/publish-image.yml/badge.svg)](https://github.com/gustavo-ferreira03/specbook/actions/workflows/publish-image.yml)
[![Docker image](https://img.shields.io/badge/GHCR-specbook-2496ed?style=flat&logo=docker&logoColor=white)](https://github.com/gustavo-ferreira03/specbook/pkgs/container/specbook)
[![MIT License](https://img.shields.io/github/license/gustavo-ferreira03/specbook?style=flat)](LICENSE)
![Node.js 26](https://img.shields.io/badge/Node.js-26-3c873a?style=flat&logo=nodedotjs&logoColor=white)

## **Describe web behavior. Keep it in Git. Run it again.**

Specbook turns a conversation about a web application into a readable, executable Spec. You describe a flow in chat, watch the agent inspect the application in a visible browser, then review the YAML and Robot Framework files it writes.

Every project gets its own Git repository. Specs, Features, and confirmed project context remain ordinary files that a team can inspect and edit; SQLite only indexes them for the application.

## Why use Specbook?

- **Keep behavior near the code.** Each project has a Git repository with a real commit history rather than opaque test records in a database.
- **Watch the agent work.** Chromium runs headed and appears in the interface while the agent investigates the application.
- **Read the check before running it.** `spec.yml` holds the behavior in plain language and `spec.robot` holds its executable counterpart.
- **Leave with evidence.** Runs retain status, duration, logs, Robot reports, screenshots, and failure video where available.
- **Start with the product you have.** Guided discovery maps areas, terms, roles, rules, and unknowns before a Spec chat begins.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). The image includes Chromium, Playwright MCP, Robot Framework, Browser Library, Xvfb, and x11vnc.

```bash
docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 4000:4000 \
  -p 4001:4001 \
  -p 53692:53692 \
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

> [!TIP]
> `specbook-storage` is a named Docker volume. You can remove and recreate the container without deleting projects, provider credentials, chat sessions, or run evidence.

> [!WARNING]
> Specbook has no application-level authentication. The command above exposes the frontend, API, and OAuth callback ports on every host interface. Run it on a trusted network, or use a firewall, VPN, IP allowlist, or authenticated reverse proxy.

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
- Direct editing of YAML and Robot files with syntax highlighting
- SSE updates for live chat activity without polling
</details>

<details>
<summary><strong>Git-backed project files</strong></summary>

- One repository per project under `storage/repos/<project-id>`
- Path and slug identify a Spec; YAML files contain no database IDs
- Standard Git history for generated and manual changes
- SQLite reindexing keeps the UI in sync with files and external Git updates
</details>

<details>
<summary><strong>Verification and evidence</strong></summary>

- Run one Spec, a Feature subtree, or an entire project
- Robot Framework execution through Browser Library
- Status, timing, logs, reports, screenshots, and failure video retained with each run
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
└── runs/             # Reports, logs, screenshots, video, and batch state
```

A project repository looks like this:

```text
context.yml
features/<feature>/feature.yml
specs/<feature>/<spec>/spec.yml
specs/<feature>/<spec>/spec.robot
```

`spec.yml` holds the human-facing behavior and `spec.robot` executes it.

<details>
<summary><strong>Configuration and public deployments</strong></summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Public API URL embedded in the frontend at image build time |
| `FRONTEND_ORIGIN` | `http://localhost:4001` | Frontend origin accepted by CORS and VNC WebSocket checks |
| `HOST` | `127.0.0.1` | Backend bind address; the Docker command sets `0.0.0.0` |
| `PORT` | `4000` | Backend HTTP and WebSocket port |
| `SPECBOOK_STORAGE_DIR` | `apps/backend/storage` | Data, credentials, project repositories, and run artifacts |

For separate public frontend and API URLs, build the image with the public API URL, then set the frontend origin at runtime:

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://specbook-api.example.com \
  -t specbook:public .

docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 4000:4000 \
  -p 4001:4001 \
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

Local development targets Linux because browser sessions need Xvfb and x11vnc. Install Node.js 26, pnpm 10.30.1, Python 3 with virtual environments, Xvfb, and x11vnc.

```bash
pnpm install
pnpm --filter backend browser:install

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
rfbrowser init chromium

pnpm --filter backend db:migrate
pnpm dev
```

The backend listens on `4000` and the frontend on `4001`. Keep the Python environment active so the backend can find the `robot` executable.

| Task | Command |
| --- | --- |
| Type-check the backend | `pnpm --filter backend exec tsc --noEmit` |
| Build the backend | `pnpm --filter backend build` |
| Build the frontend | `pnpm --filter frontend build` |
| Install the MCP browser | `pnpm --filter backend browser:install` |
| Create a database migration | `pnpm --filter backend db:generate` |
| Apply database migrations | `pnpm --filter backend db:migrate` |
</details>

Questions, ideas, and bug reports belong in [GitHub Discussions](https://github.com/gustavo-ferreira03/specbook/discussions) and [Issues](https://github.com/gustavo-ferreira03/specbook/issues).
