# Release readiness progress

Owner: Gus. Scope: approved release plan, phases 1–3, after the completed phase 0. Local merges are authorized. Do not push, create tags or publish releases.

## Decisions and workflow

- Self-hosted, instance-wide admin/editor/viewer accounts and generic OIDC SSO. No cloud, billing, tenancy or per-project permissions.
- English interface, existing Specbook components and typography. Remove the language filter on agent text.
- First run: administrator, tested model connection, first project or SauceDemo. Model and system configuration are global.
- Each phase has its own branch, conventional commits, verification and a local merge into main. Pre-existing `.gitignore` and `apps/frontend/next-env.d.ts` changes stay outside the commits.
- Existing storage is preserved. Live checks use isolated storage or temporary projects deleted through the API. Frontend production builds use a separate output directory.

## Phase 0

Done. The 12 corrections passed typecheck, 263 tests and both builds; live Overview and Settings checks passed. `feat/autonomous-agent` was merged locally into `main` with `--no-ff` before opening `feat/first-run`.

## Phase 1: first hour

Implemented on `feat/first-run`; final live evidence and local merge in progress.

- Runtime API address for REST, evidence, SSE and VNC.
- First-run wizard, model connection test, global Settings, demo credentials and discovery prerequisites. The administrator step is a phase-2 integration hook until accounts are implemented.
- Human errors, clean turn timeout, generic server error identifiers and sanitized execution errors.
- Readiness checks and System status.
- Recover/reindex project files before execution, or present an actionable recovery control.
- Invalid/incomplete checks use the ordinary repair-in-chat flow. The grouped regeneration decision is removed; phase 1 item 6 is superseded by Gus’s correction.
- Remove the language filter.
- Visible-tab polling and project batch indexing/cache.

Verification: `pnpm typecheck` passed and `SPECBOOK_TEST_VNC=1 pnpm test` passed all 269 tests, no failures or skips. Backend bundle and isolated frontend production build passed. Production served from `192.168.0.165:4101` with fresh storage: REST, SSE (36 ms first event), WebSocket upgrade, CI against SauceDemo, browser artifacts/report, Git clone and an 11 MiB push passed. A real model connection test and agent-created SauceDemo check passed in the existing configured runtime; credentials stayed there. Temporary projects are removed through the API.

Rendered QA at 1440 and 390 pixels covers setup, invalid-key feedback, global Settings, file recovery diffs, incomplete checks and repair chat. Evidence is in `/tmp/specbook-phase1-qa`; runtime screenshot is `/tmp/specbook-runtime-lan.png`. Recovery kept YAML bytes, rejected stale previews and required explicit saving. Missing implementations create no grouped decisions or agent work.

Two additional production defects were found and fixed: top-level database initialization deadlocked the bundled import graph, and compression buffered chat SSE. Batch history now indexes project membership and discovers newly added directories without rereading every project's batch JSON on each poll.

Limits: Docker Desktop is unavailable, so the published container itself has not been exercised. The fresh wizard uses a fictitious key for failure checks; the successful provider call and browser authoring run use the original configured runtime, not copied secrets.

## Phase 2: company accounts and operations

Pending on `feat/accounts-sso`: accounts, sessions, default-deny roles and route coverage guard; OIDC and invites; attribution/audit; encrypted LLM secrets and key rotation; browser safety and screenshot policy; retention; verified backup/restore and upgrade/rollback documentation.

## Phase 3: landing and release preparation

Pending on `docs/landing`: static landing with real demo assets, concise README and reference docs, trust files, Pages workflow, multi-architecture image builds, vulnerability scan, SBOM and signing. Prepare release-please for v0.2.0; Gus performs push and publication.

## Environment and evidence

- Development services currently use backend :4000 and frontend :4001; LAN address is `192.168.0.165`.
- Docker's installed WSL shim reports that Docker Desktop integration is disabled. Checking available alternatives; this must not be reported as a successful image/container verification.
- The controlling tmux session `specbook-codex` exists.
