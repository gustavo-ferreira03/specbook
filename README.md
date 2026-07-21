# Specbook

Specbook turns a conversation about a web application into an executable Spec.
You describe a behavior in chat.
The agent inspects the application in a visible browser.
Specbook writes the YAML files and the Robot Framework files.

Each project has its own Git repository.
Specs, features, and project context are files.
The team can inspect and edit these files.
SQLite indexes the files for the application.

## Quick start

You must have Docker.
The image includes these tools:

- Chromium
- Playwright MCP
- Robot Framework
- Browser Library
- Xvfb
- x11vnc

Run this command:

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

Open [http://localhost:4001](http://localhost:4001).
Select an LLM provider and a model in **Settings**.
Specbook accepts API keys and OAuth connections for Anthropic, OpenAI Codex, and GitHub Copilot.

```bash
curl http://localhost:4000/health
docker logs -f specbook
```

> [!TIP]
> `specbook-storage` is a named Docker volume.
> You can remove the container and create a new container.
> The projects, credentials, chat sessions, and run evidence stay in the volume.

> [!WARNING]
> Specbook does not have application-level authentication.
> The command connects the frontend, API, and OAuth ports to all host interfaces.
> Use the application on a trusted network.
> Use a firewall, VPN, IP allowlist, or authenticated reverse proxy.

## Why use Specbook

- **Behavior near the code.** Each project has a Git repository with commit history.
- **Watch the agent work.** You can see the Chromium session while the agent inspects the application.
- **Read the Spec.** `spec.yml` has the behavior in plain language. `spec.robot` has the executable test.
- **Evidence.** Each run has status, duration, logs, Robot reports, screenshots, and video.
- **Guided discovery.** The system maps areas, terms, roles, rules, and unknowns before you start a Spec chat.

## Your first Spec

1. Create a project with the application URL.
2. Run guided discovery. You can also start a Spec chat immediately.
3. Describe a behavior. The agent uses the browser and asks for missing information.
4. Review the files and the Git history.
5. Run the Spec when the application changes.

> [!NOTE]
> The discovery tool stays on the project origin.
> It uses read-oriented browser actions.
> The discovery tool is not a network sandbox.
> Use a staging or disposable application.
> Do not paste passwords, private keys, one-time codes, or production tokens into chat.

## Features

### Authoring and project context

- A visible Chromium session for agent exploration
- Guided discovery that creates project context
- Direct editing of YAML and Robot files with syntax highlighting
- SSE updates for live chat activity

### Git-backed project files

- One repository per project at `storage/repos/<project-id>`
- The path and slug identify a Spec
- YAML files do not contain database IDs
- Standard Git history for all changes
- SQLite keeps the UI in sync with files and external Git updates

### Verification and evidence

- Run one Spec, a feature subtree, or the entire project
- Robot Framework execution through Browser Library
- Each run has status, timing, logs, reports, screenshots, and video
- Single runs stop after 120 seconds
- Batch runs stop after 30 minutes

## Project layout

Specbook stores data at `apps/backend/storage`.
Inside the container, the path is `/app/apps/backend/storage`.

```text
storage/
├── specbook.db       # SQLite index and application state
├── pi-auth.json      # LLM provider credentials
├── chat/             # Chat sessions and browser profiles
├── repos/            # One Git repository per project
└── runs/             # Reports, logs, screenshots, video, and batch state
```

A project repository has this structure:

```text
context.yml
features/<feature>/feature.yml
specs/<feature>/<spec>/spec.yml
specs/<feature>/<spec>/spec.robot
```

`spec.yml` has the behavior in plain language.
`spec.robot` runs the behavior.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Public API URL. Set this value at image build time. |
| `FRONTEND_ORIGIN` | `http://localhost:4001` | Frontend origin. CORS and VNC use this value. |
| `HOST` | `127.0.0.1` | Backend bind address. The Docker command sets `0.0.0.0`. |
| `PORT` | `4000` | Backend HTTP and WebSocket port. |
| `SPECBOOK_STORAGE_DIR` | `apps/backend/storage` | Data, credentials, project repositories, and run artifacts. |

To use separate URLs for the frontend and API:

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

### Development

Development runs on Linux.
Browser sessions need Xvfb and x11vnc.
You must have Node.js 26, pnpm 10.30.1, Python 3 with virtual environments, Xvfb, and x11vnc.

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

The backend uses port 4000.
The frontend uses port 4001.
Keep the Python environment active.
The backend must find the `robot` executable.

| Task | Command |
| --- | --- |
| Type-check the backend | `pnpm --filter backend exec tsc --noEmit` |
| Build the backend | `pnpm --filter backend build` |
| Build the frontend | `pnpm --filter frontend build` |
| Install the MCP browser | `pnpm --filter backend browser:install` |
| Create a database migration | `pnpm --filter backend db:generate` |
| Apply database migrations | `pnpm --filter backend db:migrate` |

Questions, ideas, and bug reports go to [GitHub Discussions](https://github.com/gustavo-ferreira03/specbook/discussions) and [Issues](https://github.com/gustavo-ferreira03/specbook/issues).
