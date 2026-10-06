# Changelog

All notable changes to Specbook appear in this file. Future entries are generated from Conventional Commits by Release Please.

## Unreleased

### Breaking changes

- Executable checks now require TypeScript (`spec.ts`); Robot Framework execution has been removed.
- The GitHub repository mirror has been removed. Unpushed changes stop syncing, and the mirror's remote URL and credentials are dropped during migration. Project files remain available. Specbook's own Git remote and the GitHub Copilot LLM provider remain supported.

- Access now requires an instance account. The first visit creates the administrator while preserving existing projects. CI and Git retain their project-token authentication.
- Model credentials are encrypted on upgrade. Back up the storage and matching key before updating; rollback requires restoring the matching pre-upgrade backup.
- The frontend now proxies API and browser requests at runtime through `/api`; configure `SPECBOOK_BACKEND_URL` instead of rebuilding for a public API address.

### Added

- Event-driven verification, failure triage, reviewed file diffs, schedules, retry/flaky history, requested coverage review and exploratory findings.
- A first-run wizard, demo application, model connection test, readiness checks, actionable errors and repository recovery.
- Local accounts, invitations, instance-wide roles, generic OIDC SSO, user-attributed commits and an administrator audit log.
- Browser origin and click-target checks, screenshot transmission settings, encrypted secret rotation, retention and verified backup/restore commands.
- CI clients and deployment signals, JUnit and Markdown reports, a static product site, deployment guides and release workflows for verified multi-architecture images.

## [0.1.0] - 2026-07-18

### Added

- Git-backed project repositories with YAML Specs and Robot Framework execution.
- Visible browser-assisted authoring, guided project discovery, run evidence, and manual file editing.
- A public Docker image at `ghcr.io/gustavo-ferreira03/specbook`.
