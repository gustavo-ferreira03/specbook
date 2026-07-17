# Specbook

Specbook documents and tests web applications through an AI agent. Describe a flow in chat while the agent operates a real Chromium window; once the behavior is clear, the agent saves a readable Spec with preconditions, execution steps, an expected result, and postconditions.

Each Spec keeps its verification status, immutable versions, Robot Framework run history, and evidence such as logs or screenshots. The test code stays behind the interface. Specbook is self-hosted and aimed at independent developers or small teams that want durable behavior documentation.

## Docker Quick Start

You need Docker Compose.

1. Build and start Specbook:

   ```bash
   docker compose up --build
   ```

2. Open `http://localhost:4001`, then open **Settings** to connect an LLM provider and choose a model.

The API listens on `http://localhost:4000`. Compose stores provider credentials, the database, conversations, Specs, and run artifacts in the `specbook-storage` volume.

> [!WARNING]
> Credentials entered in chat are stored as plaintext in the persistent volume and sent to your configured LLM provider. Use staging credentials with the narrowest permissions possible.

> [!WARNING]
> Compose publishes the frontend, API, and OAuth callback ports on every host interface. Specbook does not provide application-level authentication. Restrict access with a firewall, VPN, authenticated reverse proxy, or strict IP allowlist. Set `NEXT_PUBLIC_API_URL` before building and set `FRONTEND_ORIGIN` to the public frontend origin.

## Local Development

Specbook requires Node.js 22.19 or newer and pnpm 10.30.1. Install the JavaScript dependencies and the Chromium revision used by Playwright MCP:

```bash
pnpm install
pnpm --filter backend browser:install
```

On Debian or Ubuntu, install the virtual display and VNC processes:

```bash
sudo apt-get install xvfb x11vnc
```

Use a Python virtual environment for Robot Framework and Browser Library:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
rfbrowser init chromium
```

Apply the committed migrations before the first local run:

```bash
pnpm --filter backend db:migrate
```

After changing `apps/backend/src/db/schema.ts`, generate and apply a new migration yourself:

```bash
pnpm --filter backend db:generate
pnpm --filter backend db:migrate
```

Start the backend on port 4000 and the frontend on port 4001:

```bash
pnpm dev
```

Open **Settings** in the sidebar to add an API key or connect a supported subscription, then select the provider and model used by the agent.

Static verification uses the two project builds:

```bash
pnpm --filter backend exec tsc --noEmit
pnpm --filter frontend build
```

## v0 Flow

Configure the agent in **Settings**, then create a project with the application name and base URL. Start a conversation, describe one behavior, and watch the agent explore the application in the live browser panel. It will ask for missing business rules or credentials in chat.

Once the flow is settled, the agent creates a Spec and runs its Robot Framework executable. Open the Spec from the sidebar to read the behavior, rerun it, inspect status changes, or open the saved run evidence. Editing starts another conversation with the current Spec already identified.
