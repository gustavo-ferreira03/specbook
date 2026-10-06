# Autonomous agent progress

Branch: `feat/autonomous-agent`. Product owner: Gus. No pushes; `main` is untouched.

## Product decisions

- Jobs are internal. The project steward observes signals, persists intentions and dispatches work; the UI is Activity + Inbox, with no job creation form.
- Steering, schedules and integrations are optional. Propose is the default autonomy level. Missing access leads to a question; credentials belong in Settings → Credentials.
- `spec.yml` is the behavior contract. Autonomous repository tools create proposals; human approval is required for behavior changes. Source-only patches preserve the existing YAML bytes.
- Gus cancelled Robot migration and requested removal of obsolete compatibility. Only `spec.yml` + `spec.ts` are supported. The GitHub repository mirror is removed; built-in Smart HTTP Git and GitHub Copilot OAuth remain.
- Existing Specbook layout, components, typography and status tokens are reused. Proposed changes are unified file diffs, as requested in the latest correction.

Both addenda have been applied. Their source files were read from `/tmp/claude-1000/-home-gus-projetos-specbook/ebbefea2-f0e2-47c9-923c-2abbc941647f/scratchpad/codex-brief-addendum.md` and `codex-brief-addendum-2.md`.

## Implemented

### Jobs and Inbox

Persistent jobs reuse the chat runner, sessions and tools. SQLite retains queue state, budgets, audit entries, proposals and answers. Job chats stay out of the human chat list. Tokens and active wall time accumulate across turns; tool actions are reserved before execution. Questions pause the job, answers resume it, and interrupted jobs reconcile previous output after restart.

Approval uses the existing repository writer with an original-file check for edits, a repository-head check for additions, and an Inbox commit marker for idempotent replay. Candidate verification runs outside the project checkout. The Inbox shows file diffs generated with the writer's YAML serializers; additions show all added lines, and untouched contracts show “No changes”. A test compares preview content with the bytes committed on approval.

`SPECBOOK_MAX_CONCURRENT_JOBS` defaults to `SPECBOOK_MAX_CONCURRENT_RUNS` or 2. Verification uses normal run slots. Cancellation reaches MCP calls, credential/session helpers and the scanner; stopping a job also closes its browser.

### Failure triage and flakiness

A failed manual, batch or scheduled Spec reruns once before healing. A unique persisted retry reference prevents duplicate retries after restart. Source and contract hashes are checked before retrying or healing. Pass-on-retry marks both attempts flaky, keeps history/evidence visible, and does not trigger the healer. Healing opt-out still permits the retry.

Persistent failure becomes a steward signal. The healer receives the failed step, screenshots, Playwright/ARIA context and scrubbed console/network evidence. It classifies test drift, application bug or environment. Drift permits only a minimal implementation proposal with a passing isolated rerun; bugs produce reports; environment problems lead to investigation or a question. Approval verifies the candidate source hash and execution URL.

The validator and agent instructions allow `toMatchAriaSnapshot`. Runs capture bounded console, page and network failures as evidence.

### Schedules and notifications

Settings → Automation supports optional five-field numeric UTC cron, all or selected Specs, failure investigation, and a generic status webhook with a Slack-compatible text field. Schedules persist, coalesce missed ticks and prevent overlap. The encrypted notification outbox retries delivery and deduplicates each batch/status transition.

### Project steward

Persistent observations, signals and intentions cover failed/invalid/stale/changed Specs, confirmed context, empty projects, deployments, credentials and chat requests. Lightweight deployment checks compare build asset URLs, ETag/Last-Modified or a bounded response hash every five minutes, with availability backoff. Deterministic observation generations deduplicate crash replay while retaining actual A→B→A changes.

A daily planner uses a compact project digest and Zod-derived `propose_intents`; chat and jobs can request background work through the same intention queue. Independent coverage goals remain distinct. Equivalent work has a six-hour cooldown, blocked work prevents equivalent dispatch, and rejected proposals are remembered. Exact rejected proposals cannot be silently recreated.

The steward reserves at most 300,000 tokens and 30 active minutes per project per UTC day, serializes jobs within a project, and limits autonomous batches to twelve per day. A run that cannot start creates a budgeted prerequisite investigation; after resolution it can retry the original selection and URL without an unlimited loop. New credentials resume explicitly tagged credential questions.

Observe records signals without dispatching new work. Propose submits changes for review. Act may apply a verified selector-only fix after three approved examples and no rejected examples; AST comparison excludes assertions, input data and contract changes.

### Coverage and exploration

Coverage jobs compare confirmed areas, roles and rules with existing Specs and Features. Findings become proposals or questions in Inbox. “Promote to regression Spec” creates one persisted coverage intention from a bug report; approval remains required for any repository mutation.

`scan_page` uses a strict empty Zod input and fixed trusted code. It runs axe on the current main document, captures console/network errors and checks up to twenty safe same-origin links with HEAD. It skips destructive link names/URLs, including encoded variants, and never follows link-check redirects. HEAD-unsupported responses are not reported as broken links. Output is bounded, scrubbed and saved in the job audit log with an Activity evidence link. Agents must confirm findings and include reproduction steps before reporting them.

### CI/CD and mirror removal

The GitHub mirror's backend, frontend, credential storage, background sync and database columns are removed. Historical Drizzle migrations remain to upgrade existing databases safely; user repositories and data are preserved. The built-in Git remote and Copilot provider remain functional.

Settings → CI/CD issues, rotates and revokes hashed project-scoped tokens, shown once and separate from Git tokens. It provides snippets for GitHub Actions, GitLab CI, Bitbucket Pipelines, CircleCI and Jenkins, plus recent CI batches with commit/ref/build metadata and evidence links.

- `POST /ci/projects/:id/runs`: all, Feature or selected Specs, optional preview URL, build metadata and quality-gate options.
- `GET /ci/runs/:batchId`: JSON status, bounded long polling, JUnit or Markdown results.
- `GET /ci/projects/:id/client.mjs`: authenticated download of the dependency-free Node client.
- `POST /ci/projects/:id/deploy`: generic deployment signal for the steward.

Every CI endpoint is token-authenticated and exempt from browser Host/CSRF checks. The client waits, exports reports and returns a failing exit code when appropriate. It retries bounded transient GET failures but never repeats POST. Busy Specs return 409 with atomic lock reservation, preventing an unexpected later batch after the caller times out.

Quality gates snapshot open Inbox bugs at batch creation. By default, previously known failures and flaky results do not fail the pipeline; both are visible in reports. New bugs do not retroactively waive a failed gate.

Preview URLs persist through execution, retry, investigation and candidate verification. They do not authorize stored secrets: credential origin rules remain tied to the canonical project URL and the profile's explicit allowed origins. The README explains preview authorization and all five pipeline snippets.

## Verification

- `pnpm typecheck`: passed for both apps.
- `pnpm test`: 212 passed, zero failures or skips.
- `pnpm --filter backend build`: passed. No frontend production build was run into the live `.next` directory.
- Restarted the development backend to verify changes. Live LLM/Inbox checks covered asking a question, answering and resuming, cumulative budgets, automatic steward activity, and healer investigation followed by approval of a verified SauceDemo locator fix. The YAML contract remained byte-identical.
- A scheduled SauceDemo batch passed; running/passed webhook deliveries succeeded after retry. A real flaky fixture failed once, passed on retry, kept both history entries and created no healer job.
- Live CI checks covered tokens, preview execution, client download/wait/reports, deployment signals, rotation/revocation and settings snippets. A real-browser credential test proved an untrusted preview receives no typing event or form submission, then passes after explicit authorization.
- Real Chromium + Playwright MCP checks covered axe, console/network failures, safe links, redirects, origin limits and redaction. Integration checks cover promotion idempotency/project isolation, replay, rejection memory, budgets and approval concurrency.
- Activity, Inbox, CI/CD and unified diffs were checked in the running frontend at desktop and 390px without horizontal page overflow. The real healer diff showed one removed/added locator line and unchanged YAML.
- Temporary verification projects were deleted through the API. Git verification tokens were revoked. Existing user projects and storage were preserved.

## Limits and remaining optional work

The requested core features and both addenda are implemented. Provider-specific deploy adapters for Vercel, Netlify and Render were optional and are not included; their pipelines can call the generic endpoint.

Exploration is bounded to the rendered main document and safe links; it does not claim exhaustive accessibility or application coverage. Passive deployment fingerprints are heuristic; explicit deployment webhooks provide a reliable pipeline signal.

Token usage is recorded after each model response, so a response can cross the threshold before further work stops. Browser side effects cannot be rolled back after a crash; recovered jobs are instructed to inspect state before repeating an action.

## Commits and workspace

- `a083745 feat: add persistent autonomous jobs and project inbox`
- `e440354 feat: triage spec failures and verify proposed fixes`
- `a963ac1 feat: schedule spec runs and deliver status webhooks`
- `cb67a6f refactor!: remove the GitHub repository mirror`
- `e24cf62 feat: let the project steward drive autonomous activity`
- `b4e61fc feat: detect flaky specs with one persistent retry`
- `4e83624 feat: integrate CI pipelines and deployment signals`
- `5fcb51f feat: explore coverage gaps and propose regression specs`
- `feat: show proposed changes as file diffs` records unified proposal review and this consolidated checkpoint.

`apps/frontend/next-env.d.ts` was already modified when work began and is excluded from these commits. Nothing has been pushed.
