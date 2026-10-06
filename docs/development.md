# Development

Local development targets Linux because visible agent browsers use Xvfb and x11vnc. The repository currently uses Node.js 26 and pnpm 10.30.1, pinned through `package.json`; Git is also required. Install Xvfb and x11vnc with your system package manager before starting the backend.

```sh
pnpm install --frozen-lockfile
pnpm --filter backend browser:install
pnpm dev
```

Install the pinned pnpm version directly or through Corepack before running these commands. The browser command installs the Chromium revisions required by both Playwright MCP and Playwright Test. On a Linux machine missing Chromium system libraries, `pnpm --filter backend browser:install:docker` also invokes Playwright's system-dependency installer and may require elevated privileges.

Open `http://localhost:4001`; the backend listens on `4000`. Complete setup to create the administrator, connect a model and create a project. Migrations apply when the backend starts. Use `pnpm --filter backend db:migrate` only when you need to apply them without starting the server.

## Working with the repository

| Path | Purpose |
| --- | --- |
| `apps/backend/src/core/` | Chat, browsers, repositories, run execution, investigations and policies |
| `apps/backend/src/infra/` | HTTP routes, database access and persistence |
| `apps/backend/drizzle/` | Generated database migrations |
| `apps/backend/test/` | Unit, integration and browser execution tests |
| `apps/frontend/src/` | App Router pages, existing UI components and API helpers |
| `shared/` | Rules shared by frontend and backend, including origin validation |

Read [PRODUCT.md](../PRODUCT.md) and the applicable `AGENTS.md` before changing the interface. Preserve the existing components, visual language and English UI. Body text uses 14px; do not go below 12px. Inspect changed screens at desktop and mobile widths, including empty, loading and error states.

The backend watcher can miss relevant changes. Restart it before verifying a backend fix in the running app. Never run a production build into the `.next` directory used by a live development server; choose a separate output directory:

```sh
pnpm --filter backend build
NEXT_DIST_DIR=.next-check pnpm --filter frontend build
```

If you need to serve that build, pass the same `NEXT_DIST_DIR` to the frontend start command. Stop an existing frontend using port 4001 first, or choose another port with the Next CLI.

## Changes and checks

Zod schemas define the request and tool contracts. Derive agent tool JSON schemas with `.toJSONSchema()` rather than maintaining a second schema by hand. For database changes, edit `apps/backend/src/infra/db/schema.ts`, then generate and inspect the migration:

```sh
pnpm --filter backend db:generate
pnpm typecheck
pnpm test
```

`pnpm check` combines typecheck and tests. Run focused tests while working, then the complete checks before handing off. For example:

```sh
pnpm --filter backend exec node --import tsx --test test/unit/route-coverage.test.ts
```

Every API endpoint must declare its access policy; the default-deny test checks the real application router. Verify permission changes through that application, because isolated route fixtures do not exercise the global authorization gate. Keep tests in `apps/backend/test`; add a test when it covers a meaningful regression, not simply to mirror an implementation detail.

The Spec validator accepts a constrained `spec.ts` shape: a `specbook` import, one test and ordered `step` blocks matching `spec.yml`. Browser actions and assertions must meet its allowlist. Changes to the behavior contract need human approval in autonomous workflows, even if the implementation change looks small.

## Test data and API requests

Use disposable projects or a separate storage directory for manual checks. Never delete another person's projects or modify their storage files to make a test pass.

```sh
SPECBOOK_STORAGE_DIR=/tmp/specbook-dev-check pnpm --filter backend dev
```

The example still uses backend port 4000, so stop another backend on that port first. A separate storage directory needs its own setup. Clean up temporary projects through `DELETE /projects/:id`, using an authenticated session and `X-Specbook-Request: 1`; direct filesystem deletion bypasses cleanup.

The frontend's `api()` helper adds the request header and sends session cookies. Direct state-changing API requests also need it. Git and CI clients authenticate with project-scoped tokens through their own routes. Do not commit storage, provider credentials, browser profiles, generated reports or private screenshots.

For release conventions and pull request scope, see [Contributing](../CONTRIBUTING.md). See [operations](operations.md) for backup, restore and key rotation commands.
