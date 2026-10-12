Specbook CLI
============

Run behavior contracts locally, explore a browser, and ask your installed Claude Code or Codex agent to create or verify Specs. No Specbook server or Specbook model configuration is required.

Connect to a hosted Specbook to pull team coverage and publish locally passing Specs. Pipelines use `specbook ci` with a project CI token to run remote acceptance checks and save HTML evidence and JUnit results.

This package exposes the `specbook` executable. It requires Node.js 22 or newer and downloads Chromium on the first browser command. Run `specbook --help` for the command list. The package includes full command, credential, agent-restriction and packaging documentation in [dist/README.md](dist/README.md), copied from the repository's `docs/cli/README.md` during the build.
