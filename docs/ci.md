# CI/CD integration

Open **Settings → CI/CD** in a project and create a CI token. Store it in your CI provider's secret settings as `SPECBOOK_CI_TOKEN`. Tokens belong to one project, are hashed at rest, and are shown once. Rotation and revocation take effect immediately. Git remote tokens and CI tokens have separate scopes.

The dependency-free [Node client](../apps/backend/scripts/specbook-ci.mjs) starts a batch, waits for the result, writes `specbook-junit.xml` and `specbook-summary.md`, and exits with status 1 when the quality gate fails or the request cannot complete. Your CI runner must be able to reach the Specbook API; Specbook must be able to reach the application under test. Run the check after your deployment is ready.

```bash
export SPECBOOK_API_URL="https://specbook.example.com/api"
export SPECBOOK_PROJECT_ID="<project-id>"
# SPECBOOK_CI_TOKEN comes from your CI secret settings.
curl -fsS -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/client.mjs" -o specbook-ci.mjs
node specbook-ci.mjs
```

The client uses Node.js built-ins and installs no packages. Settings provides the same snippets below with the project's API URL and ID filled in. Replace the example URL and `<project-id>` when copying from this guide.

| Optional client variable | Purpose |
| --- | --- |
| `SPECBOOK_ENVIRONMENT` | Saved environment name; default `production`. `--environment <name>` overrides this variable |
| `SPECBOOK_BASE_URL` | Preview deployment URL for this batch; the environment's saved URL stays unchanged |
| `SPECBOOK_FEATURE_ID` | Run one Feature subtree |
| `SPECBOOK_SPEC_IDS` | Comma-separated Spec IDs; use either this or `SPECBOOK_FEATURE_ID` |
| `SPECBOOK_COMMIT_SHA`, `SPECBOOK_REF`, `SPECBOOK_BUILD_URL` | Commit, branch/tag, and pipeline link retained with the batch |
| `SPECBOOK_FAIL_ON_FLAKY` | `true` to fail the gate when a Spec passes only on retry; default `false` |
| `SPECBOOK_FAIL_ON_KNOWN_BUGS` | `true` to fail the gate for Specs with an open bug report at batch creation; default `false` |
| `SPECBOOK_JUNIT_PATH`, `SPECBOOK_SUMMARY_PATH` | Output file paths; parent directories are created |
| `SPECBOOK_TIMEOUT_SECONDS` | Maximum wait for Specbook results; default `3600`. Comment publishing has a separate 60-second timeout |
| `SPECBOOK_COMMENT_PROVIDER` | `github` or `gitlab` to publish a PR/MR summary from the CI job; default `none`. Also accepts `--comment github` or `--comment gitlab` |

Preview and deployment URLs must use the chosen environment's origin or an exact origin listed under **Settings → Environments**. Private, loopback and link-local targets are rejected unless the environment's saved URL explicitly uses a private IP or localhost. Internal DNS names alone do not enable that exception. Run navigation follows the same origin policy, including redirects; HTTP(S) run connections use validated, pinned DNS addresses. CI tokens accept at most 30 run/deploy requests per minute.

Preview URLs do not authorize access to stored credentials. To use a saved credential profile on a preview, add the preview's origin to that profile's allowed origins in **Settings → Credentials**.

By default, Specs that pass on retry and failures covered by an open bug report do not fail the pipeline. They remain visible in the Markdown summary and appear as skipped cases in JUnit. Other failures fail the gate. The batch's execution status and its quality gate result are shown separately in **Settings → CI/CD**, with links to each Spec's evidence.

Draft Specs never run in CI or deployment batches and don't affect the quality gate. Activate a Draft after reviewing its manual run.

### Pull request feedback

With `SPECBOOK_COMMENT_PROVIDER=github`, the client reads the PR number from `GITHUB_EVENT_PATH` and uses the job's `GITHUB_TOKEN` to create or update one comment per Specbook project. Set `SPECBOOK_PR_NUMBER` explicitly when a trusted workflow already knows the PR number. `GITHUB_REPOSITORY` and `GITHUB_API_URL` come from GitHub Actions, including GitHub Enterprise. The workflow below grants only the [pull-request permission](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions) needed to publish the summary.

For GitLab, set `SPECBOOK_COMMENT_PROVIDER=gitlab` and save a project access token with `api` scope as the masked CI variable `SPECBOOK_GITLAB_TOKEN`. The client uses `CI_MERGE_REQUEST_IID`, `CI_MERGE_REQUEST_TARGET_PROJECT_ID` (or `CI_PROJECT_ID`) and `CI_API_V4_URL` to update a [merge-request note](https://docs.gitlab.com/api/notes/#modify-existing-merge-request-note). GitLab's standard [`CI_JOB_TOKEN` only reads MR notes](https://docs.gitlab.com/ci/jobs/ci_job_token/#job-token-access); it cannot create or update them. The client reports that limitation before starting a batch if an MR job enables notes without the project token.

Provider tokens stay in the CI job; the client never sends them to Specbook. Jobs without a PR or MR still write their reports and skip commenting. A failed quality gate publishes the failure summary and exits 1. If the provider rejects publishing, the job also exits 1 and retains both local reports so the error remains visible. Existing comments from people or other token identities are left alone. The snippets serialize jobs for the same project and PR/MR to prevent concurrent jobs from creating duplicate summaries.

<details>
<summary><strong>GitHub Actions</strong></summary>

Save the Specbook token as a repository secret. Add this job after the deployment job in your existing workflow and choose the corresponding saved environment. It updates a PR comment, writes the [GitHub job summary](https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions#adding-a-job-summary) and uploads both reports as artifacts. Fork and Dependabot PRs are skipped because their jobs [cannot access repository secrets or a writable token](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request). Use your existing trusted deployment workflow for those checks.

`.github/workflows/specbook.yml`:

```yaml
name: Specbook
on: [workflow_dispatch, pull_request]
jobs:
  verify:
    if: github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    concurrency:
      group: specbook-<project-id>-${{ github.event.pull_request.number || github.ref }}
      cancel-in-progress: false
    env:
      SPECBOOK_API_URL: "https://specbook.example.com/api"
      SPECBOOK_PROJECT_ID: "<project-id>"
      SPECBOOK_ENVIRONMENT: "production"
      SPECBOOK_FAIL_ON_FLAKY: "false"
      SPECBOOK_FAIL_ON_KNOWN_BUGS: "false"
      SPECBOOK_CI_TOKEN: ${{ secrets.SPECBOOK_CI_TOKEN }}
      SPECBOOK_COMMENT_PROVIDER: github
      GITHUB_TOKEN: ${{ github.token }}
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

Save `SPECBOOK_CI_TOKEN` and `SPECBOOK_GITLAB_TOKEN` as masked CI/CD variables. The latter is the GitLab project access token described above; it never reaches Specbook. Add this job after your deployment stage. GitLab reads the [JUnit report](https://docs.gitlab.com/ci/testing/unit_test_reports/) even when the job fails, and the client updates one note when the pipeline has merge-request context. Only expose these variables to trusted pipelines.

`.gitlab-ci.yml`:

```yaml
specbook:
  image: node:26
  resource_group: specbook-$SPECBOOK_PROJECT_ID-$CI_MERGE_REQUEST_IID
  variables:
    SPECBOOK_API_URL: "https://specbook.example.com/api"
    SPECBOOK_PROJECT_ID: "<project-id>"
    SPECBOOK_ENVIRONMENT: "production"
    SPECBOOK_FAIL_ON_FLAKY: "false"
    SPECBOOK_FAIL_ON_KNOWN_BUGS: "false"
    SPECBOOK_COMMIT_SHA: "$CI_COMMIT_SHA"
    SPECBOOK_REF: "$CI_COMMIT_REF_NAME"
    SPECBOOK_BUILD_URL: "$CI_JOB_URL"
    SPECBOOK_COMMENT_PROVIDER: "gitlab"
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
          - export SPECBOOK_API_URL='https://specbook.example.com/api'
          - export SPECBOOK_PROJECT_ID='<project-id>'
          - export SPECBOOK_ENVIRONMENT='production'
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
      SPECBOOK_API_URL: "https://specbook.example.com/api"
      SPECBOOK_PROJECT_ID: "<project-id>"
      SPECBOOK_ENVIRONMENT: "production"
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
    SPECBOOK_API_URL = 'https://specbook.example.com/api'
    SPECBOOK_PROJECT_ID = '<project-id>'
    SPECBOOK_ENVIRONMENT = 'production'
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

Send `{}` to run all active, runnable Specs, `{ "featureId": "<feature-id>" }` for a Feature subtree, or `{ "specIds": ["<spec-id>"] }` for a selection. The run request also accepts `environment` (a saved name, default `production`), `baseUrl`, `commitSha`, `ref`, `buildUrl`, and `qualityGate: { failOnFlaky: false, failOnKnownBugs: false }`. Invalid Specs are excluded from all/Feature batches; explicitly selecting an invalid Spec returns its validation failure. Drafts are excluded from CI selection.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  -H "Content-Type: application/json" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/runs" \
  -d '{"environment":"preview","baseUrl":"https://preview.example.com","commitSha":"abc123","ref":"feature/login"}'
```

The JSON response contains `batch.id`, `complete`, `status`, `qualityGate`, and `results`. Use `complete` and `qualityGate.passed` for a pipeline gate; the raw `batch.status` still records execution failures that the gate may allow.

### Deploy notifications

Send a deploy event when the new application is ready. Deterministic rules run the project's checks under its automation policy. A deploy event acknowledges the signal; use the runs endpoint above when the pipeline must wait for a gate result.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SPECBOOK_CI_TOKEN" \
  -H "Content-Type: application/json" \
  "$SPECBOOK_API_URL/ci/projects/$SPECBOOK_PROJECT_ID/deploy" \
  -d '{"environment":"preview","url":"https://preview.example.com","commitSha":"abc123","ref":"feature/login"}'
```

All payload fields are optional. `environment` selects a saved environment by name; when omitted it uses Production. A repeated event with the same commit and payload is deduplicated; events without a commit are deduplicated for five minutes. Your pipeline or deploy webhook can send this generic payload without granting Specbook access to the application's source repository.
