# Specbook

Self-hosted QA agent. It turns a conversation into readable Specs (`spec.yml`) and executable Playwright tests (`spec.ts`), runs them when your app changes and investigates failures in a real browser.

## Run

```sh
docker compose up -d
```

Open [localhost:4001](http://localhost:4001). The setup wizard creates the admin account and connects a model. Data lives in the `specbook-storage` volume.

To serve it on another address, set `FRONTEND_ORIGIN` (for example `https://specbook.example.com`) and, for extra hostnames, `SPECBOOK_ALLOWED_HOSTS` (comma-separated).

## Use it from your coding agent

Specbook exposes an MCP server, so the agent that builds your features can ask it for tests. In a project, open **Settings → Agent access**, create a token and run the command shown there:

```sh
claude mcp add --transport http specbook <origin>/api/mcp/projects/<project-id> --header "Authorization: Bearer <token>"
```

The agent describes what it changed with `send_message`, follows the conversation with `wait_for_reply` and answers login or approval requests with `respond_to_action`. `run_specs` runs a regression without an agent turn. Every conversation is a regular chat in Specbook.

## Develop

Requires Linux, Node.js 26, pnpm, Xvfb and x11vnc.

```sh
pnpm install
pnpm --filter backend browser:install
pnpm dev
```

`pnpm check` runs the type checks and tests.

## License

MIT
