# <img src="apps/frontend/public/specbook-chat-icon.svg" width="32" height="32" align="absmiddle" alt=""> Specbook

Specbook checks web applications through readable, executable Specs. Describe a flow in chat or let the project agent investigate failures, application changes, and missing coverage. Review its findings and proposed changes in the project's Overview.

Every project gets its own Git repository. Specs, Features, and confirmed project context remain ordinary files that a team can inspect and edit; SQLite only indexes them for the application.

## Why use Specbook?

- **Keep behavior near the code.** Each project has a Git repository with a real commit history rather than opaque test records in a database.
- **Watch the agent work.** Chromium runs headed and appears in the interface while the agent investigates the application.
- **Read the check before running it.** `spec.yml` holds the behavior in plain language and `spec.ts` holds its executable counterpart, a restricted Playwright Test file with one named step per Spec step.
- **Leave with evidence.** Runs retain status, duration, the failed step, a screenshot per step, failure video, and a Playwright HTML report where available.
- **Start with the product you have.** Guided discovery maps areas, terms, roles, rules, and unknowns before a Spec chat begins.
- **Use a normal Git remote.** Each project can issue a scoped access token for standard clone, fetch, and push over Smart HTTP.

## Quick start

You need [Docker](https://docs.docker.com/get-docker/). The image includes Chromium, Playwright MCP, Playwright Test, Xvfb, and x11vnc.

```bash
docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --shm-size=1g \
  -p 127.0.0.1:4000:4000 \
  -p 127.0.0.1:4001:4001 \
  -p 127.0.0.1:1455:1455 \
  -p 127.0.0.1:53692:53692 \
  -e HOST=0.0.0.0 \
  -e FRONTEND_ORIGIN=http://localhost:4001 \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v specbook-storage:/app/apps/backend/storage \
  ghcr.io/gustavo-ferreira03/specbook:latest
```

Open [http://localhost:4001](http://localhost:4001), then select an LLM provider and model in **Settings**. Specbook accepts API keys from its model registry plus OAuth connections for Anthropic, OpenAI Codex, and GitHub Copilot.

```bash
curl http://localhost:4000/health
docker logs -f specbook
```

The same setup is available as `docker compose up -d` with the repository's `docker-compose.yml`. The image runs under `tini`, drops to the unprivileged `node` user after fixing ownership of the storage volume, and reports health through `/health`. `:latest` and version tags track releases; `:main` and `:sha-<commit>` are preview builds of every commit on `main` that passes CI.

> [!TIP]
> `specbook-storage` is a named Docker volume. You can remove and recreate the container without deleting projects, provider credentials, chat sessions, or run evidence.

> [!WARNING]
> Specbook has no application-level authentication. The command above publishes its ports on `127.0.0.1` only. To reach it from other machines, drop the `127.0.0.1:` prefixes, add the public host names to `SPECBOOK_ALLOWED_HOSTS`, and keep it on a trusted network or behind a firewall, VPN, IP allowlist, or authenticated reverse proxy.

### Clone a project repository

Open **Settings → Git** in a project and create a repository access token. The token is shown once. Use `specbook` as the username when Git prompts for credentials:

```bash
git clone https://your-specbook-host/git/<project-id>.git
# Username: specbook
# Password: the one-time project token
```

The repository accepts the `main` branch only. Generated files and edits made in Specbook are committed before the remote is advertised, and pushes are reindexed into the project after they complete. Rotating or revoking the token immediately prevents new Git requests; existing connections must authenticate again.

## Autonomous QA

Specbook observes failed runs, invalid or changed Specs, deployments, confirmed project context, new credentials, and requests from chat. **Overview** brings together decisions that need you, current work, application bugs, paused checks, and history by day. Each row opens a side panel with the evidence and next step. Work persists across backend restarts and uses the same agent and browser tools as chat.

**Needs you** contains questions and suggested changes. Review the behavior and before/after screenshots where available; file diffs with added and removed lines are under **Technical details**. Approving a suggestion commits it to the project's repository. Answering a question resumes the investigation; enter secrets in **Settings → Credentials**. The agent treats `spec.yml` as the behavior contract: changes to its steps or expected result always require human review. The Specs tree shows each check's health alongside its name.

**Settings → Automation** provides optional controls:

- **Propose** is the default: investigate and submit changes for review. **Observe** records signals without starting new work. **Act** may apply a verified selector-only fix after three approved examples, provided none were rejected.
- A five-field UTC cron schedule runs all Specs or a selected set. An optional webhook receives scheduled batch status changes; failure investigation can be disabled for scheduled runs.

A failed Spec runs once more before the healer investigates. Passing on retry marks it as flaky and keeps both attempts in its history. Persistent failures lead to a verified implementation patch, a bug report with evidence, or a question about the environment. Exploration can collect console and network failures, check safe links, and inspect accessibility with axe. Bug reports can be promoted to regression Spec proposals.

Pause or resume Specbook for a project from **Overview**, or for all projects from **Settings → Automation**. Pause is separate from Observe, Propose and Act. It stops new automatic work, lets agent turns stop cleanly and preserves their progress. There is no daily quota or token reservation. Internal safeguards stop investigations that fail to reach a result; retries use a different approach with backoff. Equivalent work and rejected suggestions are deduplicated. Schedules, webhooks, and steering fields are optional.

## CI/CD

Open **Settings → CI/CD** in a project and create a CI token. Store it in your CI provider's secret settings as `SPECBOOK_CI_TOKEN`. Tokens belong to one project, are hashed at rest, and are shown once. Rotation and revocation take effect immediately. Git remote tokens and CI tokens have separate scopes.

The dependency-free [Node client](apps/backend/scripts/specbook-ci.mjs) starts a batch, waits for the result, writes `specbook-junit.xml` and `specbook-summary.md`, and exits with status 1 when the quality gate fails or the request cannot complete. Your CI runner must be able to reach the Specbook API; Specbook must be able to reach the application under test. Run the check after your deployment is ready.

```bash
export SPECBOOK_API_URL="https://specbook-api.example.com"
export SPECBOOK_PROJECT_ID="<project-id>"
# SPECBOOK_CI_TOKEN comes from your CI secret settings.
curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
node specbook-ci.mjs
```

The client uses Node.js built-ins and installs no packages. Settings provides the same snippets below with the project's API URL and ID filled in. Replace the example URL and `<project-id>` when copying from this README.

| Optional client variable | Purpose |
| --- | --- |
| `SPECBOOK_BASE_URL` | Preview deployment URL for this batch; the project's saved URL stays unchanged |
| `SPECBOOK_FEATURE_ID` | Run one Feature subtree |
| `SPECBOOK_SPEC_IDS` | Comma-separated Spec IDs; use either this or `SPECBOOK_FEATURE_ID` |
| `SPECBOOK_COMMIT_SHA`, `SPECBOOK_REF`, `SPECBOOK_BUILD_URL` | Commit, branch/tag, and pipeline link retained with the batch |
| `SPECBOOK_FAIL_ON_FLAKY` | `true` to fail the gate when a Spec passes only on retry; default `false` |
| `SPECBOOK_FAIL_ON_KNOWN_BUGS` | `true` to fail the gate for Specs with an open bug report at batch creation; default `false` |
| `SPECBOOK_JUNIT_PATH`, `SPECBOOK_SUMMARY_PATH` | Output file paths; parent directories are created |
| `SPECBOOK_TIMEOUT_SECONDS` | Maximum client wait; default `3600` |

Preview URLs do not authorize access to stored credentials. To use a saved credential profile on a preview, add the preview's origin to that profile's allowed origins in **Settings → Credentials**.

By default, Specs that pass on retry and failures covered by an open bug report do not fail the pipeline. They remain visible in the Markdown summary and appear as skipped cases in JUnit. Other failures fail the gate. The batch's execution status and its quality gate result are shown separately in **Settings → CI/CD**, with links to each Spec's evidence.

<details>
<summary><strong>GitHub Actions</strong></summary>

Save the token as a repository secret. This workflow can be run manually; add its job after the deployment job in your existing workflow. It writes the [GitHub job summary](https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions#adding-a-job-summary) and uploads both reports as artifacts.

`.github/workflows/specbook.yml`:

```yaml
name: Specbook
on: [workflow_dispatch]
jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      SPECBOOK_API_URL: "https://specbook-api.example.com"
      SPECBOOK_PROJECT_ID: "<project-id>"
      SPECBOOK_FAIL_ON_FLAKY: "false"
      SPECBOOK_FAIL_ON_KNOWN_BUGS: "false"
      SPECBOOK_CI_TOKEN: ${{ secrets.SPECBOOK_CI_TOKEN }}
      SPECBOOK_COMMIT_SHA: ${{ github.sha }}
      SPECBOOK_REF: ${{ github.ref_name }}
      SPECBOOK_BUILD_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 26
      - name: Verify application
        run: |
          curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
          node specbook-ci.mjs
      - name: Publish summary
        if: always()
        run: test ! -f specbook-summary.md || cat specbook-summary.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: specbook-results
          path: |
            specbook-junit.xml
            specbook-summary.md
```
</details>

<details>
<summary><strong>GitLab CI</strong></summary>

Save the token as a masked CI/CD variable. Add this job after your deployment stage. GitLab reads the [JUnit report](https://docs.gitlab.com/ci/testing/unit_test_reports/) even when the job fails.

`.gitlab-ci.yml`:

```yaml
specbook:
  image: node:26
  variables:
    SPECBOOK_API_URL: "https://specbook-api.example.com"
    SPECBOOK_PROJECT_ID: "<project-id>"
    SPECBOOK_FAIL_ON_FLAKY: "false"
    SPECBOOK_FAIL_ON_KNOWN_BUGS: "false"
    SPECBOOK_COMMIT_SHA: "$CI_COMMIT_SHA"
    SPECBOOK_REF: "$CI_COMMIT_REF_NAME"
    SPECBOOK_BUILD_URL: "$CI_JOB_URL"
  script:
    - |
      curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
      node specbook-ci.mjs
  artifacts:
    when: always
    reports:
      junit: specbook-junit.xml
    paths:
      - specbook-summary.md
```
</details>

<details>
<summary><strong>Bitbucket Pipelines</strong></summary>

Save the token as a secured repository variable. Bitbucket [discovers JUnit reports in `test-results`](https://support.atlassian.com/bitbucket-cloud/docs/test-reporting-in-pipelines/) after the step completes.

`bitbucket-pipelines.yml`:

```yaml
image: node:26
pipelines:
  default:
    - step:
        name: Verify with Specbook
        script:
          - export SPECBOOK_API_URL='https://specbook-api.example.com'
          - export SPECBOOK_PROJECT_ID='<project-id>'
          - export SPECBOOK_FAIL_ON_FLAKY='false'
          - export SPECBOOK_FAIL_ON_KNOWN_BUGS='false'
          - export SPECBOOK_COMMIT_SHA="$BITBUCKET_COMMIT"
          - export SPECBOOK_REF="$BITBUCKET_BRANCH"
          - export SPECBOOK_BUILD_URL="https://bitbucket.org/$BITBUCKET_REPO_FULL_NAME/pipelines/results/$BITBUCKET_BUILD_NUMBER"
          - mkdir -p test-results
          - export SPECBOOK_JUNIT_PATH="test-results/specbook.xml"
          - |
            curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
            node specbook-ci.mjs
        artifacts:
          - test-results/specbook.xml
          - specbook-summary.md
```
</details>

<details>
<summary><strong>CircleCI</strong></summary>

Save the token as a project environment variable. CircleCI [stores the JUnit results](https://circleci.com/docs/guides/test/collect-test-data/) and the Markdown artifact after the run.

`.circleci/config.yml`:

```yaml
version: 2.1
jobs:
  specbook:
    docker:
      - image: node:26
    environment:
      SPECBOOK_API_URL: "https://specbook-api.example.com"
      SPECBOOK_PROJECT_ID: "<project-id>"
      SPECBOOK_FAIL_ON_FLAKY: "false"
      SPECBOOK_FAIL_ON_KNOWN_BUGS: "false"
      SPECBOOK_JUNIT_PATH: test-results/specbook.xml
    steps:
      - run:
          name: Verify with Specbook
          command: |
            export SPECBOOK_COMMIT_SHA="$CIRCLE_SHA1"
            export SPECBOOK_REF="$CIRCLE_BRANCH"
            export SPECBOOK_BUILD_URL="$CIRCLE_BUILD_URL"
            mkdir -p test-results
            curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
            node specbook-ci.mjs
      - store_test_results:
          path: test-results
      - store_artifacts:
          path: specbook-summary.md
workflows:
  verify:
    jobs:
      - specbook
```
</details>

<details>
<summary><strong>Jenkins</strong></summary>

Save the token as a secret text credential with ID `specbook-ci-token`. The agent needs Node.js 26 and curl. The [post block](https://www.jenkins.io/doc/book/pipeline/jenkinsfile/) retains reports when the verification step fails.

`Jenkinsfile`:

```groovy
pipeline {
  agent any // Node.js 26 and curl must be available.
  environment {
    SPECBOOK_API_URL = 'https://specbook-api.example.com'
    SPECBOOK_PROJECT_ID = '<project-id>'
    SPECBOOK_FAIL_ON_FLAKY = 'false'
    SPECBOOK_FAIL_ON_KNOWN_BUGS = 'false'
    SPECBOOK_CI_TOKEN = credentials('specbook-ci-token')
  }
  stages {
    stage('Verify with Specbook') {
      steps {
        sh '''
          set +x
          export SPECBOOK_COMMIT_SHA="$GIT_COMMIT"
          export SPECBOOK_REF="$BRANCH_NAME"
          export SPECBOOK_BUILD_URL="$BUILD_URL"
          curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
          node specbook-ci.mjs
        '''
      }
    }
  }
  post {
    always {
      junit testResults: 'specbook-junit.xml', allowEmptyResults: true
      archiveArtifacts artifacts: 'specbook-summary.md', allowEmptyArchive: true
    }
  }
}
```
</details>

### CI API

Authenticate every request below with `Authorization: Bearer <CI token>`. These routes do not require the browser's `X-Specbook-Request` header.

| Route | Result |
| --- | --- |
| `POST /ci/projects/:id/runs` | Starts a batch and returns its initial result with HTTP 202 |
| `GET /ci/runs/:batchId` | JSON status, quality gate counts, and per-Spec evidence links |
| `GET /ci/runs/:batchId?wait=true` | Waits up to 25 seconds for completion; repeat while `complete` is `false` |
| `GET /ci/runs/:batchId?format=junit` | JUnit XML report |
| `GET /ci/runs/:batchId?format=markdown` | Markdown summary for your CI job to publish |
| `GET /ci/projects/:id/client.mjs` | Downloads the dependency-free client |
| `POST /ci/projects/:id/deploy` | Records a deployment signal for the project steward |

Send `{}` to run all runnable Specs, `{ "featureId": "<feature-id>" }` for a Feature subtree, or `{ "specIds": ["<spec-id>"] }` for a selection. The run request also accepts `baseUrl`, `commitSha`, `ref`, `buildUrl`, and `qualityGate: { failOnFlaky: false, failOnKnownBugs: false }`. Invalid Specs are excluded from all/Feature batches; explicitly selecting an invalid Spec returns its validation failure.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  -H "Content-Type: application/json" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/runs" \
  -d '{"baseUrl":"https://preview.example.com","commitSha":"abc123","ref":"feature/login"}'
```

The JSON response contains `batch.id`, `complete`, `status`, `qualityGate`, and `results`. Use `complete` and `qualityGate.passed` for a pipeline gate; the raw `batch.status` still records execution failures that the gate may allow.

### Deploy notifications

Send a deploy event when the new application is ready. The steward uses it to choose verification work under the project's autonomy policy and budget. A deploy event acknowledges the signal; use the runs endpoint above when the pipeline must wait for a gate result.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  -H "Content-Type: application/json" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/deploy" \
  -d '{"environment":"preview","url":"https://preview.example.com","commitSha":"abc123","ref":"feature/login"}'
```

All payload fields are optional. A repeated event with the same commit and payload is deduplicated. Your pipeline or deploy webhook can send this generic payload without granting Specbook access to the application's source repository.

## Your first Spec

1. Create a project with the application's base URL.
2. Run guided discovery, or start a Spec chat immediately.
3. Describe one behavior while the agent uses the visible browser and asks for missing details.
4. Review the files and their Git history, then run the Spec whenever the application changes.

> [!NOTE]
> Discovery stays within the project origin and uses read-oriented browser actions. Its origin guard and safety rules are not a network sandbox, so use a disposable or staging application when possible. Never paste passwords, private keys, one-time codes, or production tokens into chat.

## Features

<details open>
<summary><strong>Authoring and project context</strong></summary>

- A visible, headed Chromium session for agent exploration and authoring
- Guided discovery that drafts project context for later chats
- Direct editing of YAML and TypeScript files with syntax highlighting
- SSE updates for live chat activity without polling
</details>

<details>
<summary><strong>Git-backed project files</strong></summary>

- One repository per project under `storage/repos/<project-id>`
- One canonical bare remote per project under `storage/git/<project-id>.git`
- Path and slug identify a Spec; YAML files contain no database IDs
- Standard Git history for generated and manual changes
- SQLite reindexing keeps the UI in sync with files and external Git updates
</details>

<details>
<summary><strong>Verification and evidence</strong></summary>

- Run one Spec, a Feature subtree, or an entire project
- Playwright Test execution in headless Chromium, one worker per run
- `spec.ts` is validated against an allowlist of Playwright calls before it is stored or run, and runs with a restricted `page`, origin-checked navigation and origin-checked secrets
- Status, timing, failed step, step screenshots, failure video, and the HTML report (for runs without secrets) retained with each run
- Single runs time out after 120 seconds; batch runs scale by Spec count and stop at 30 minutes
</details>

## Project layout

Specbook stores application data in `apps/backend/storage` locally, or `/app/apps/backend/storage` inside the container.

```text
storage/
├── specbook.db       # SQLite index and application state
├── pi-auth.json      # LLM provider credentials
├── chat/             # Chat sessions and browser profiles
├── repos/            # One Git repository per project
├── git/              # Canonical bare repositories served over Smart HTTP
├── metrics/          # chat-turns.jsonl evaluation metrics
└── runs/             # Results, reports, screenshots, video, and batch state
```

A project repository looks like this:

```text
context.yml
features/<feature>/feature.yml
specs/<feature>/<spec>/spec.yml
specs/<feature>/<spec>/spec.ts
```

`spec.yml` holds the human-facing behavior and `spec.ts` executes it:

```ts
import { test, expect } from "specbook";

test("Sign in with valid credentials", async ({ page, step, secret }) => {
    await step("Open the sign-in page", async () => {
        await page.goto("/login");
    });
    await step("Enter the account email and password", async () => {
        await page.getByLabel("Email").fill("ana@acme.test");
        await page.getByLabel("Password").fill(secret("shopper", "password"));
        await page.getByRole("button", { name: "Sign in" }).click();
    });
    await step("See the dashboard", async () => {
        await expect(page.getByRole("heading")).toHaveText(/Welcome back/);
    });
});
```

The file may contain only this shape: one import from `specbook`, one `test`, and `step` blocks whose titles are the `steps` of `spec.yml`, in order. Inside a step, only awaited `page`/locator actions (`goto` with a path, `click`, `fill`, `getByRole`, ...) and `expect` assertions with literal arguments are accepted; anything else makes the Spec invalid. `secret(profile, field)` types a credential value at run time, only on the project origin or the profile's allowed origins.

<details>
<summary><strong>Configuration and public deployments</strong></summary>

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Public API URL embedded in the frontend at image build time |
| `FRONTEND_ORIGIN` | `http://localhost:4001` | Frontend origin accepted by CORS and VNC WebSocket checks |
| `HOST` | `127.0.0.1` | Backend bind address; the Docker command sets `0.0.0.0` |
| `PORT` | `4000` | Backend HTTP and WebSocket port |
| `SPECBOOK_STORAGE_DIR` | `apps/backend/storage` | Data, credentials, project repositories, and run artifacts |
| `SPECBOOK_ALLOWED_HOSTS` | none | Extra comma-separated `Host` header values the API answers; an entry without a port matches any port, `*` disables the check |
| `SPECBOOK_PUBLIC_API_URL` | request host | Base URL shown for `git clone` |
| `TRUST_PROXY` | `false` | Set to `true` or `1` when a reverse proxy sets `X-Forwarded-Host`/`X-Forwarded-Proto`; only then are they used for clone URLs |
| `SPECBOOK_MAX_CONCURRENT_RUNS` | `2` | Playwright Test executions (single runs and batches) that may drive a browser at once |
| `SPECBOOK_MAX_CONCURRENT_JOBS` | run concurrency | Agent jobs that may run at once across projects |
| `SPECBOOK_GIT_MAX_PUSH_BYTES` | `209715200` (200 MiB) | Largest push accepted by the Smart HTTP remote |
| `PI_OAUTH_CALLBACK_HOST` | `127.0.0.1` | Bind address of the OAuth callback listeners; the Docker command sets `0.0.0.0` |
| `LOG_LEVEL` | `info` | Backend JSON log threshold: `debug`, `info`, `warn`, `error`, or `silent` |

The API only answers requests whose `Host` header is `localhost`, `127.0.0.1`, or `[::1]` on `PORT`, the host of `FRONTEND_ORIGIN`, `NEXT_PUBLIC_API_URL`, or `SPECBOOK_PUBLIC_API_URL`, or an entry of `SPECBOOK_ALLOWED_HOSTS`; other hosts get `421`. This blocks DNS rebinding. State-changing requests must also carry `X-Specbook-Request: 1`, which the frontend sends and a cross-site form cannot. Git Smart HTTP under `/git/` and CI requests under `/ci/` are exempt from both checks because every request authenticates with a project token.

| Port | Purpose |
| --- | --- |
| `4000` | Backend API, VNC WebSocket, and Git Smart HTTP |
| `4001` | Web interface |
| `1455` | OAuth callback for OpenAI Codex (`http://localhost:1455/auth/callback`) |
| `53692` | OAuth callback for Anthropic |

The OAuth callbacks are only used while you connect a provider in **Settings**. The provider redirects your browser to `localhost` on those ports, so they must be reachable from the machine running the browser (for a remote host, publish them or forward them with `ssh -L`).

The live browser stream is served by x11vnc on loopback with a random per-session password. The backend authenticates to it and relays the stream over the `/vnc/<session-id>` WebSocket, so the password never leaves the server.

For separate public frontend and API URLs, build the image with the public API URL, then set the frontend origin at runtime:

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://specbook-api.example.com \
  -t specbook:public .

docker run --detach \
  --name specbook \
  --restart unless-stopped \
  --shm-size=1g \
  -p 4000:4000 \
  -p 4001:4001 \
  -p 1455:1455 \
  -p 53692:53692 \
  -e HOST=0.0.0.0 \
  -e FRONTEND_ORIGIN=https://specbook.example.com \
  -e PI_OAUTH_CALLBACK_HOST=0.0.0.0 \
  -v specbook-storage:/app/apps/backend/storage \
  specbook:public
```
</details>

<details>
<summary><strong>Development</strong></summary>

Local development targets Linux because browser sessions need Xvfb and x11vnc. Install Node.js 26, pnpm 10.30.1, Xvfb, and x11vnc.

```bash
pnpm install
pnpm --filter backend browser:install

pnpm --filter backend db:migrate
pnpm dev
```

The backend listens on `4000` and the frontend on `4001`. `browser:install` downloads the Chromium builds of Playwright MCP and Playwright Test.

| Task | Command |
| --- | --- |
| Type-check both apps | `pnpm typecheck` |
| Build both apps | `pnpm build` |
| Run the tests | `pnpm test` |
| Type-check and test | `pnpm check` |
| Install the MCP browser | `pnpm --filter backend browser:install` |
| Create a database migration | `pnpm --filter backend db:generate` |
| Apply database migrations | `pnpm --filter backend db:migrate` |
| Export chat metrics as CSV | `node apps/backend/scripts/export-metrics.mjs [--runs] [--out file.csv]` |

The backend applies pending migrations from `apps/backend/drizzle` at startup, so `db:migrate` is only needed to migrate without starting the server. Each chat turn appends evaluation metrics to `storage/metrics/chat-turns.jsonl`; `scripts/export-metrics.mjs` converts that file to CSV, one row per turn or, with `--runs`, one row per `run_spec` call.
</details>

Questions, ideas, and bug reports belong in [GitHub Discussions](https://github.com/gustavo-ferreira03/specbook/discussions) and [Issues](https://github.com/gustavo-ferreira03/specbook/issues).
