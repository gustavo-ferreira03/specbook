Specbook CLI
============

Run behavior contracts locally, explore a browser, and ask your installed Claude Code or Codex agent to create or verify Specs. No Specbook server or Specbook model configuration is required.

Connect to a hosted Specbook to pull team coverage and publish locally passing Specs. Pipelines use `specbook ci` with a project CI token to run remote acceptance checks and save HTML evidence and JUnit results.

Use `specbook runner` inside a private network to claim hosted checks over outbound HTTP, execute them with local credential profiles, and upload results and browser evidence. Create its token in **Settings → Runners**, then choose the Runner executor in the project's environment settings.

`specbook serve --port 4201 --data /var/lib/specbook` starts the API, job worker, steward, schedules and web UI. Use an extracted standalone UI with `--ui`, the Docker image's bundled UI, or the matching checksum-verified release download. Local commands don't load server modules or require the UI.

Install the CLI tarball from your Specbook server:

```sh
npm install -g https://specbook.example.com/api/cli/specbook.tgz
specbook --help
```

For CI, use that server's package directly:

```sh
export SPECBOOK_URL=https://specbook.example.com/api
export SPECBOOK_PROJECT=YOUR_PROJECT_ID
# Supply SPECBOOK_TOKEN from your pipeline's secret store.
npx --yes --package="$SPECBOOK_URL/cli/specbook.tgz" specbook ci --environment Staging
```

The public download route needs no token. Docker builds include the tarball; a development server returns 404 until you generate it from the repository root:

```sh
pnpm --filter @specbook/runtime build
mkdir -p apps/backend/dist
pnpm --dir apps/cli pack --out ../backend/dist/specbook.tgz
```

This package exposes the `specbook` executable. It requires Node.js 22 or newer and downloads Chromium on the first browser command. Run `specbook --help` for the command list. The package includes full command, credential, agent-restriction and packaging documentation in [dist/README.md](dist/README.md), copied from the repository's `docs/cli/README.md` during the build.
