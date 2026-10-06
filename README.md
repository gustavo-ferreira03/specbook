# <img src="apps/frontend/public/specbook-chat-icon.svg" width="32" height="32" align="absmiddle" alt=""> Specbook

Write down how your web app should behave, then check that it still does. Specbook turns a conversation into readable Specs and executable TypeScript tests, runs them after deployments, and investigates failures in a real browser.

Review the evidence and proposed diffs in **Overview**. The agent can repair a test implementation; changes to the expected behavior always need your approval.

[Watch the demo](https://gustavo-ferreira03.github.io/specbook/) · [Start a pilot](https://github.com/gustavo-ferreira03/specbook/discussions/new?category=general) · [Documentation](docs/README.md)

![A Spec running against SauceDemo, with readable steps and captured evidence](site/assets/demo.gif)

Specbook is self-hosted. Your projects, Git history and run evidence stay on your server. The model provider you connect receives the context needed for agent requests; [review the data flow](docs/security.md) before connecting an application.

## Install

With Docker installed, run:

```sh
docker run -d --name specbook --restart unless-stopped --shm-size=1g \
  -p 127.0.0.1:4001:4001 \
  -p 127.0.0.1:1455:1455 -p 127.0.0.1:53692:53692 \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v specbook-storage:/app/apps/backend/storage \
  ghcr.io/gustavo-ferreira03/specbook:latest
```

Open [localhost:4001](http://localhost:4001). The setup wizard creates your administrator account, connects a model and helps you choose an application. The named volume keeps your data when you replace the container.

For a shared company instance, follow the [HTTPS deployment guide](docs/deployment.md). You can add local accounts by invitation or connect an OIDC identity provider; admin, editor and viewer roles apply across the instance.

## Your first Spec in five minutes

After the image download and model connection:

1. Choose **Try with a demo app** to create a project for SauceDemo. Its public test credentials come prefilled.
2. Open a Spec chat and ask: “Check that the sign-in page shows a username field, password field and Login button. Don't sign in.”
3. Watch the browser while the agent creates the check. Read its steps and expected result, then run it and open the screenshots.
4. Connect your own app when you're ready. Add private credentials through **Project settings → Credentials**.

A Spec pairs a human-readable `spec.yml` with a validated Playwright `spec.ts`. Both live in the project's Git repository. [See the file format and Git workflow](docs/specs.md).

## Run checks when the app changes

Schedules, CI requests, deployment events and changed Specs can start verification. A failed check runs once more; a pass on retry is marked flaky. Persistent failures trigger investigation, which produces a verified test fix, an application bug report or a question for you.

Autonomy is event-driven. Coverage review and exploratory bug hunting start when you request them in the interface or chat. You can pause automation for a project or the entire instance.

Use the dependency-free CI client with GitHub Actions, GitLab, Bitbucket, CircleCI or Jenkins. It waits for results and writes JUnit and Markdown reports. [CI setup and examples](docs/ci.md).

## Work on Specbook

Linux, Node.js 26, pnpm 10.30.1, Xvfb and x11vnc are required for local development.

```sh
pnpm install
pnpm --filter backend browser:install
pnpm dev
```

Open `http://localhost:4001`. The backend applies database migrations on startup. Run `pnpm typecheck` and `pnpm test` before submitting changes; [development details](docs/development.md) cover browser tests and isolated production builds.

[Configuration](docs/configuration.md) · [SSO](docs/sso.md) · [Backups and upgrades](docs/operations.md) · [Troubleshooting](docs/troubleshooting.md) · [FAQ](docs/faq.md)
