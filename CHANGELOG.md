# Changelog

All notable changes to Specbook appear in this file. Future entries are generated from Conventional Commits by Release Please.

## Unreleased

### Breaking changes

- Executable checks now require TypeScript (`spec.ts`); Robot Framework execution has been removed.
- The GitHub repository mirror has been removed. Unpushed changes stop syncing, and the mirror's remote URL and credentials are dropped during migration. Project files remain available. Specbook's own Git remote and the GitHub Copilot LLM provider remain supported.

## [0.1.0] - 2026-07-18

### Added

- Git-backed project repositories with YAML Specs and Robot Framework execution.
- Visible browser-assisted authoring, guided project discovery, run evidence, and manual file editing.
- A public Docker image at `ghcr.io/gustavo-ferreira03/specbook`.
