<p align="center">
  <img src="apps/frontend/public/specbook-chat-icon.svg" alt="Specbook logo" width="72" height="72">
</p>

# Specbook

Specbook is a self-hosted QA agent for web applications. Describe a flow in chat, and it writes readable Specs with Playwright tests, runs them, and investigates failures in a browser you can watch.

Each Spec keeps its behavior contract, run history, and evidence together. Projects store their files in Git; your coding agent can request QA over MCP, while CI pipelines and schedules run saved checks.

## Get started

With Docker and Docker Compose installed, run this command from the repository root:

```sh
docker compose up -d
```

Open [localhost:4001](http://localhost:4001). The setup wizard walks you through creating the admin account, connecting a model provider, and adding your first project. You can use the included Sauce Demo project to try the workflow.

The Compose file runs the published container image and keeps data in the `specbook-storage` volume. It binds the app ports to localhost. For a public deployment, route your reverse proxy to port 4001 and set `FRONTEND_ORIGIN` to the public URL, such as `https://specbook.example.com`. Add any extra hostnames to the comma-separated `SPECBOOK_ALLOWED_HOSTS` setting.

## Work with Specs

1. Create a project with your application's base URL, then describe the behavior you want to check in chat.
2. Review the proposed Specs and select the ones you want to create. Add login details through the secure credential form when the agent requests access.
3. Open a Spec to read its steps, run it, and inspect screenshots or failure diagnostics. The agent can investigate a failing run and propose a repair without changing the intended behavior.
4. Configure **Settings → Automation** for scheduled checks, or connect a pipeline through **Settings → CI/CD**.

A Spec pairs a readable `spec.yml` with an executable `spec.ts`. For example:

```yaml
title: Open the application
description: The home page shows its heading.
preconditions: []
steps:
  - Open the home page
expectedResult: The application heading is visible.
postconditions: []
```

```ts
import { test, expect } from "specbook";

test("Open the application", async ({ page, step }) => {
    await step("Open the home page", async () => {
        await page.goto("/");
        await expect(page.getByRole("heading")).toBeVisible();
    });
});
```

The step titles must match in both files. Browser and API tests use the supported `specbook` methods, which Specbook validates before execution.

## Connect your coding agent

Open the project's **Settings → Agent access**, create an agent token, and copy the connection command. For Claude Code, the command has this form; replace the project ID and token:

```sh
claude mcp add --transport http specbook \
  "http://localhost:4001/api/mcp/projects/YOUR_PROJECT_ID" \
  --header "Authorization: Bearer YOUR_AGENT_TOKEN"
```

Other MCP clients can use the same HTTP endpoint and authorization header. Specbook acts as the coding agent's QA subagent, and its conversations appear in the project's Chats.

| Tool | Purpose |
| --- | --- |
| `send_message` | Describe a change or continue an existing QA conversation. |
| `wait_for_reply` | Wait for progress, a reply, or an action that needs a response. |
| `respond_to_action` | Provide secure access, select Specs, approve a contract change, or hand an action to the human. |
| `list_conversations` | Find recent MCP conversations for the project. |
| `run_specs` | Run saved Specs without a model conversation. |
| `get_run_results` | Read a batch's results, failed steps, and flaky status. |

Agent access settings control whether declared behavior changes can update existing contracts or require approval. They also control whether an external agent may provide credentials. Credential actions keep secret values outside chat messages and model context.

## Run checks from CI

Create a separate project CI token in **Settings → CI/CD** and copy the generated snippet for your pipeline provider. The bundled client starts a batch, waits for its result, and writes JUnit and Markdown reports. It can also update GitHub pull request comments or GitLab merge request notes.

For a pipeline that checks out this repository:

```sh
SPECBOOK_API_URL="https://specbook.example.com/api" \
SPECBOOK_PROJECT_ID="YOUR_PROJECT_ID" \
SPECBOOK_CI_TOKEN="YOUR_CI_TOKEN" \
node apps/backend/scripts/specbook-ci.mjs
```

Use `--environment Staging` to select a configured environment. Preview URLs must belong to that environment's allowed origins, and credentials for another environment require explicit overrides. Quality gates can fail on flaky results or known bugs; the settings page includes these options in its generated snippets.

## Storage and configuration

The Docker volume holds the SQLite database, project repositories, conversations, run artifacts, and encryption key. Native development uses `apps/backend/storage` unless you set `SPECBOOK_STORAGE_DIR`.

| Setting | Purpose |
| --- | --- |
| `FRONTEND_ORIGIN` | Public frontend URL; defaults to `http://localhost:4001` in the backend. |
| `SPECBOOK_ALLOWED_HOSTS` | Additional hostnames accepted by the frontend and backend. |
| `SPECBOOK_STORAGE_DIR` | Backend storage directory. |
| `SPECBOOK_BACKEND_URL` | Backend URL used by the frontend's `/api` proxy; defaults to `http://127.0.0.1:4000`. |
| `SPECBOOK_ENCRYPTION_KEY` / `SPECBOOK_ENCRYPTION_KEY_FILE` | Optional external encryption key; configure one source. |
| `LOG_LEVEL` | Server logging level. |

> [!IMPORTANT]
> Back up the storage together with its encryption key. Specbook creates `encryption.key` inside storage by default; if you supply an external key, keep a separate private backup of it. Losing the matching key prevents recovery of encrypted credentials.

Retention settings in global Settings control saved runs, videos, metrics, and browser profiles. The backend also provides backup, restore, and key rotation commands through its [operations CLI](apps/backend/src/operations-cli.ts); these require exclusive access to storage while Specbook is stopped.

## Develop locally

Native development requires Linux, Node.js 26, pnpm 10.30.1, Git, Xvfb, x11vnc, and `flock` from util-linux. Install the system packages on Debian or Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y git xvfb x11vnc util-linux
```

Then install dependencies and both Chromium builds used by the agent and test runner:

```sh
npm install --global pnpm@10.30.1
pnpm install --frozen-lockfile
pnpm --filter backend browser:install:docker
pnpm dev
```

The `browser:install:docker` script includes Chromium's system dependencies on Linux.

The frontend runs on port 4001 and the backend on port 4000. The backend applies generated database migrations on startup. After editing the database schema, generate its migration with `pnpm --filter backend db:generate` before continuing development.

Run type checks and tests with:

```sh
pnpm typecheck
pnpm test
```

`pnpm check` runs both. Browser tests need installed Chromium; the optional VNC tests also need `SPECBOOK_TEST_VNC=1` and the display programs above.

## Repository layout

| Path | Contents |
| --- | --- |
| [`apps/backend`](apps/backend) | Hono API, QA agent, Playwright runner, MCP server, SQLite storage, and generated migrations. |
| [`apps/frontend`](apps/frontend) | Next.js interface and backend proxy. |
| [`shared`](shared) | HTTP host and origin validation shared by both apps. |

Read [PRODUCT.md](PRODUCT.md) for the product direction and [DESIGN.md](DESIGN.md) for the interface's design system.
