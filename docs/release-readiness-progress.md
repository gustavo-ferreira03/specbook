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

Completed on `feat/first-run` and merged locally into `main` (`66be65d`).

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

Completed on `feat/accounts-sso`; verified and ready for the local merge. Accounts, sessions, declared route roles, OIDC, invites, attribution/audit, encrypted secrets, retention and operational commands are implemented. The interface uses the existing Settings layout and role-aware controls.

Browser safety now reads the actual MCP snapshot reference before a discovery/autonomous click, including interactive ancestors. Interactive chat shares the project/credential origin policy. A Chromium document-request guard blocks external destinations before navigation, including redirects. The real MCP test passed with no request reaching the forbidden server. Administrators control automatic selector approval (off by default) and whether screenshots reach the model; the image policy also applies to restored conversation images and active sessions.

Verification: typecheck, backend/operations bundles and the isolated frontend production build passed. `SPECBOOK_TEST_VNC=1 pnpm test` passed all 279 tests without skips. The only new test file is the authorized default-deny route coverage guard; existing test files cover the remaining regressions.

A real Dex v2.45.1 login verified authorization code, PKCE, nonce, signed ID tokens, explicit administrator linking, password-free sign-in and just-in-time Viewer creation. Integration checks reject invalid signatures, nonce mismatches, replay, unverified email, unexpected domains and implicit linking. The last usable administrator remains protected. Session revocation closes SSE and VNC. LAN WebSocket checks denied anonymous/missing-Origin upgrades and accepted the authenticated path.

Live UI checks on a fresh instance at `192.168.0.165:4301` cover administrator setup, invitations, Viewer denial, Editor controls, sign-out, safe login return paths, SSO settings, screenshot policy, retention and audit. Captures at 1440 and 390 pixels show no horizontal overflow. A real SauceDemo check passed, with history and evidence; the temporary project was deleted through the API. Evidence: `/tmp/specbook-phase2-qa` and `/tmp/specbook-phase2-oidc`.

Backup/restore was verified through the compiled CLI and a fresh backend boot. Tests cover external-key migration, rotation recovery, wrong-key rejection, occupied destinations, malicious archive paths and preserving the operations lock. Retention keeps pending evidence and batch outcomes coherent; expired videos remove their metadata/report links. A volume built from the v0.1.0 migrations upgraded successfully: project IDs, repository HEAD and YAML/TypeScript bytes stayed identical, model credentials became encrypted, and first visit requests an administrator. Evidence: `/tmp/specbook-v010-before.json` and `/tmp/specbook-v010-upgrade-real`.

Docker Desktop is still unavailable. Dex ran as the official local binary, and storage/upgrade checks used the production Node bundle. Container execution is not claimed.

## Phase 3: landing and release preparation

Pending on `docs/landing`: static landing with real demo assets, concise README and reference docs, trust files, Pages workflow, multi-architecture image builds, vulnerability scan, SBOM and signing. Prepare release-please for v0.2.0; Gus performs push and publication.

## Environment and evidence

- Development services currently use backend :4000 and frontend :4001; LAN address is `192.168.0.165`.
- Docker's installed WSL shim reports that Docker Desktop integration is disabled. Checking available alternatives; this must not be reported as a successful image/container verification.
- The controlling tmux session `specbook-codex` exists.
