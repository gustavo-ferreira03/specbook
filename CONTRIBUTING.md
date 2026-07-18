# Contributing

Specbook is early software. Small fixes, clearer docs, and focused behavior changes are useful; please open an issue before starting a large feature so the work does not collide with the product direction.

## Local setup

Development runs on Linux because the agent uses headed Chromium through Xvfb and x11vnc. Install Node.js 22.19+, pnpm 10.30.1, Python 3 with virtual environments, Xvfb, and x11vnc. Then run:

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

Before opening a pull request, run the checks affected by your change:

```bash
pnpm --filter backend exec tsc --noEmit
pnpm --filter backend build
pnpm --filter frontend build
```

## Project files

Specbook stores each project's source in `apps/backend/storage/repos/<project-id>`. Treat it as Git-owned data: do not add sidecar metadata files and do not put database IDs into YAML. A Spec directory contains `spec.yml` and `spec.robot`; a Feature contains `feature.yml`; project context lives in `context.yml`.

Do not commit `apps/backend/storage`, provider credentials, browser profiles, or run artifacts. The repository's `.gitignore` and `.dockerignore` already exclude them.

## Pull requests

Keep a pull request narrow, explain the user-visible behavior it changes, and update the README when installation, configuration, or container behavior changes. Database schema changes need a generated migration under `apps/backend/drizzle`.
