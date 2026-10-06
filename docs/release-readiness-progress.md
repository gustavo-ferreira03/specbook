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

Completed on `feat/accounts-sso` and merged locally into `main` (`dca50b8`). Accounts, sessions, declared route roles, OIDC, invites, attribution/audit, encrypted secrets, retention and operational commands are implemented. The interface uses the existing Settings layout and role-aware controls.

Browser safety now reads the actual MCP snapshot reference before a discovery/autonomous click, including interactive ancestors. Interactive chat shares the project/credential origin policy. A Chromium document-request guard blocks external destinations before navigation, including redirects. The real MCP test passed with no request reaching the forbidden server. Administrators control automatic selector approval (off by default) and whether screenshots reach the model; the image policy also applies to restored conversation images and active sessions.

Verification: typecheck, backend/operations bundles and the isolated frontend production build passed. `SPECBOOK_TEST_VNC=1 pnpm test` passed all 279 tests without skips. The only new test file is the authorized default-deny route coverage guard; existing test files cover the remaining regressions.

A real Dex v2.45.1 login verified authorization code, PKCE, nonce, signed ID tokens, explicit administrator linking, password-free sign-in and just-in-time Viewer creation. Integration checks reject invalid signatures, nonce mismatches, replay, unverified email, unexpected domains and implicit linking. The last usable administrator remains protected. Session revocation closes SSE and VNC. LAN WebSocket checks denied anonymous/missing-Origin upgrades and accepted the authenticated path.

Live UI checks on a fresh instance at `192.168.0.165:4301` cover administrator setup, invitations, Viewer denial, Editor controls, sign-out, safe login return paths, SSO settings, screenshot policy, retention and audit. Captures at 1440 and 390 pixels show no horizontal overflow. A real SauceDemo check passed, with history and evidence; the temporary project was deleted through the API. Evidence: `/tmp/specbook-phase2-qa` and `/tmp/specbook-phase2-oidc`.

Backup/restore was verified through the compiled CLI and a fresh backend boot. Tests cover external-key migration, rotation recovery, wrong-key rejection, occupied destinations, malicious archive paths and preserving the operations lock. Retention keeps pending evidence and batch outcomes coherent; expired videos remove their metadata/report links. A volume built from the v0.1.0 migrations upgraded successfully: project IDs, repository HEAD and YAML/TypeScript bytes stayed identical, model credentials became encrypted, and first visit requests an administrator. Evidence: `/tmp/specbook-v010-before.json` and `/tmp/specbook-v010-upgrade-real`.

Docker Desktop is still unavailable. Dex ran as the official local binary, and storage/upgrade checks used the production Node bundle. Container execution is not claimed.

## Phase 3: landing and release preparation

Completed on `docs/landing` and merged locally into `main` after verification. The static landing uses the existing Specbook visual language, real SauceDemo screenshots and a short captured run video. It builds without dependencies and works under the GitHub Pages repository prefix. Desktop (1440 px) and mobile (390 px) checks passed: no horizontal overflow, body text 14 px, minimum text 12 px, working anchors/assets, video and clipboard fallback. Evidence: `/tmp/specbook-phase3-qa`.

The concise README links to configuration, deployment with Caddy/TLS, SSO, CI examples, Spec format, security, backups/upgrades, troubleshooting, FAQ, architecture and development guides. Trust files document reporting, conduct and product priorities. Pages and release-please are prepared; native amd64/arm64 builds must pass Trivy, fresh-volume/browser verification, SBOM/provenance checks and cosign signing before install tags move. Gus performs push and publication.

A local Trivy 0.75.0 scan initially found 34 HIGH/CRITICAL advisories. Next.js, simple-git and affected transitive packages were updated; the unused shadcn CLI was removed. The new simple-git environment guard explicitly permits the existing non-interactive setting. The repeat scan returned zero HIGH/CRITICAL findings across 651 packages, without exclusions. Typecheck, both production builds and 71 focused Git/repository tests passed. Versions, scan scope and reproduction command: [dependency verification](dependency-verification.md).

Workflows passed actionlint and ShellCheck. Simulated workflow source checks cover ordinary previews, lightweight/annotated release tags, missing CI, draft releases, invalid input and tag cycles. The shared image workflow checks CI on the exact source SHA independently of its caller. Publication recovery can rebuild a published release, and the guide explains the possibility of partial tag promotion. These checks did not publish anything. The container and OS scan still require Docker and remain unverified locally.

Final verification: `pnpm typecheck`, backend/operations bundles, the isolated Next.js 16.3.8 production build, and all 279 tests passed with no skips. The first test attempt encountered a sandbox-only write restriction in the installed Playwright cache; repeating with cache access passed the complete suite. Final log: `/tmp/specbook-phase3-tests-verified.log`.

A fresh production instance at the LAN address verified administrator creation, session cookies, Git authorship, a real SauceDemo check, authenticated PNG evidence through `/api`, and a settled Overview with no active work. Spec and Overview captures passed at 1440 and 390 px. Both temporary projects were deleted through the API; temporary services, browsers and production build directories were removed. Evidence: `/tmp/specbook-phase3-production-qa/result.json`. The original development instance was restarted on the patched dependencies and passes `/health` and `/ready`.

Remaining external verification: the Docker quick start on a clean machine, native multi-architecture image execution, OS/browser vulnerability scan and actual registry signing/publication. Docker is unavailable here; those checks are encoded in the workflows and must succeed after Gus pushes. No push, tag, release or Pages deployment was performed. Follow [the release commands](releases.md#publish-the-prepared-release) and enable GitHub Pages with the Actions source.

## Follow-up: PI update

Gus requested updating the project's PI after the release phases. Both `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` move from 0.80.10 to the published stable 1.0.4, with the lockfile updated. Credential changes now call the canonical `ModelRuntime.refresh()` API. Session persistence remains compatible with existing JSONL files; the private flush wrapper was checked against the new implementation. Cache warming is disabled to preserve request accounting and avoid additional model calls during tools.

Typecheck, the backend/operations build and all 279 tests passed with no skips. The 47 repository/security integration checks also passed after the cache warming adjustment; a separate runtime check confirms it is off. A temporary production backend verified encrypted credential saving/removal, refreshed provider availability and reopening an empty chat; its projects were deleted through the API and the temporary service stopped. Trivy reports zero HIGH/CRITICAL findings across 664 locked packages. Evidence: `/tmp/specbook-pi-update-tests.log`, `/tmp/specbook-pi-update-qa-result.json` and `/tmp/specbook-pi-update-vulnerabilities.json`.

The original backend was restarted on PI 1.0.4; frontend-proxied `/health` and `/ready` pass. Azure is now named `azure` in PI's model catalog; deployments selecting that provider must follow the upstream naming change. OpenAI Codex and Anthropic credential formats remain compatible. No push or publication was performed.

## Environment and evidence

- Development services currently use backend :4000 and frontend :4001; LAN address is `192.168.0.165`.
- Docker's installed WSL shim reports that Docker Desktop integration is disabled. Image execution, clean-machine Docker quick start and multi-architecture publication are not claimed as verified.
- The controlling tmux session `specbook-codex` exists.
- The original instance was stopped cleanly, backed up to private `/tmp/specbook-before-accounts-20261006.tar.gz`, and restarted with the production backend bundle. All 9 existing projects and 1,010 repository files were preserved (hash comparison against the backup). Model credentials migrated to encrypted storage. First access asks Gus to create the administrator; no account was created on his behalf. Automatic retention is disabled in this development session.
