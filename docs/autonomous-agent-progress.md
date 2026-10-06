# Autonomous agent progress

Branch: `feat/autonomous-agent`. Product owner: Gus. No pushes; `main` is untouched.

## Product decisions

- Jobs are internal. Deterministic event rules persist intentions and dispatch work; there is no LLM planner. Overview contains Needs you, Failing and Recent runs, with no job creation form. Coverage and exploration require an explicit request.
- Steering, schedules and integrations are optional. Propose is the default autonomy level. Missing access leads to a question; credentials belong in Settings → Credentials.
- `spec.yml` is the behavior contract. Autonomous repository tools create proposals; human approval is required for behavior changes. Source-only patches preserve the existing YAML bytes.
- Gus cancelled Robot migration and requested removal of obsolete compatibility. Only `spec.yml` + `spec.ts` are supported. The GitHub repository mirror is removed; built-in Smart HTTP Git and GitHub Copilot OAuth remain.
- Existing Specbook layout, components, typography and status tokens are reused. Proposed changes are unified file diffs, as requested in the latest correction.

The six addenda have been read; the current scope follows addendum 6, with implementation and validation checkpoints below. The original source files were read from `/tmp/claude-1000/-home-gus-projetos-specbook/ebbefea2-f0e2-47c9-923c-2abbc941647f/scratchpad/codex-brief-addendum.md` and `codex-brief-addendum-2.md`.

## Implemented

### Jobs and Inbox

Persistent jobs reuse the chat runner, sessions and tools. SQLite retains queue state, internal loop safeguards, audit entries, proposals and answers. Job chats stay out of the human chat list. Tokens and active wall time accumulate across turns; tool actions are reserved before execution. Questions pause the job, answers resume it, and interrupted jobs reconcile previous output after restart.

Approval uses the existing repository writer with an original-file check for edits, a repository-head check for additions, and an Inbox commit marker for idempotent replay. Candidate verification runs outside the project checkout. The Inbox shows file diffs generated with the writer's YAML serializers; additions show all added lines, and untouched contracts show “No changes”. A test compares preview content with the bytes committed on approval.

`SPECBOOK_MAX_CONCURRENT_JOBS` defaults to `SPECBOOK_MAX_CONCURRENT_RUNS` or 2. Verification uses normal run slots. Cancellation reaches MCP calls, credential/session helpers and the scanner; stopping a job also closes its browser.

### Failure triage and flakiness

A failed manual, batch or scheduled Spec reruns once before healing. A unique persisted retry reference prevents duplicate retries after restart. Source and contract hashes are checked before retrying or healing. Pass-on-retry marks both attempts flaky, keeps history/evidence visible, and does not trigger the healer. Healing opt-out still permits the retry.

Persistent failure becomes a steward signal. The healer receives the failed step, screenshots, Playwright/ARIA context and scrubbed console/network evidence. It classifies test drift, application bug or environment. Drift permits only a minimal implementation proposal with a passing isolated rerun; bugs produce reports; environment problems lead to investigation or a question. Approval verifies the candidate source hash and execution URL.

The validator and agent instructions allow `toMatchAriaSnapshot`. Runs capture bounded console, page and network failures as evidence.

### Schedules and notifications

Settings → Automation supports optional five-field numeric UTC cron, all or selected Specs, failure investigation, and a generic status webhook with a Slack-compatible text field. Schedules persist, coalesce missed ticks and prevent overlap. The encrypted notification outbox retries delivery and deduplicates each batch/status transition.

### Project steward

Persistent observations, signals and intentions cover failed or changed Specs, deployments, credentials and explicit user requests. Existing Specs seed a silent baseline on first observation; invalid Specs create one regeneration decision and require a human request before repair. Empty projects, context changes, stale checks and availability probes do not launch agent work. Lightweight deployment checks compare build asset URLs, ETag/Last-Modified or a bounded response hash every five minutes, with availability backoff. Deterministic observation generations deduplicate crash replay while retaining actual A→B→A changes.

The LLM planner, planner tools and recursive background requests from agent sessions are removed. Chat retains `start_background_task` because it expresses a human request. Intention source distinguishes user requests from events; equivalent active work is deduplicated. Automatic investigation cooldown and rejection memory are scoped to the check, current source/contract, failed step, failure kind and execution URL. They do not promise deduplication across changed contracts or distinct failure kinds. Unique event identifiers provide replay protection, not semantic deduplication.

The steward serializes investigations within a project. There is no daily quota, token reservation or per-day batch cap. A run that cannot start creates a deterministic prerequisite question, without an LLM turn. An answer retries the original selection and URL once; if the prerequisite persists, a new question is required. New credentials resume explicitly tagged credential questions.

Observe records signals without dispatching automatic work; explicit requests remain available. Propose submits changes for review. Act requires a separate auto-approval opt-in, off by default, plus three approved examples and no rejected examples. AST comparison permits direct action-locator changes only; assertions, aliases, input data, action kind and contracts remain unchanged. Policy is checked again under the repository lock and before commit.

### Coverage and exploration

Only a project action or chat request starts coverage or exploration. Coverage jobs compare confirmed areas, roles and rules with existing Specs and Features. Findings become proposals or questions in Inbox. “Promote to regression Spec” creates one persisted coverage intention from a bug report; approval remains required for any repository mutation.

`scan_page` uses a strict empty Zod input and fixed trusted code. It runs axe on the current main document, captures console/network errors and checks up to twenty safe same-origin links with HEAD. It skips destructive link names/URLs, including encoded variants, and never follows link-check redirects. HEAD-unsupported responses are not reported as broken links. Output is bounded, scrubbed and saved in the job audit log with an Overview evidence link. Agents must confirm findings and include reproduction steps before reporting them.

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

## Earlier verification checkpoint (before addenda 3–6)

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

The requested core features are implemented within the event-driven scope of addendum 6. Provider-specific deploy adapters for Vercel, Netlify and Render were optional and are not included; their pipelines can call the generic endpoint.

Exploration is bounded to the rendered main document and safe links; it does not claim exhaustive accessibility or application coverage. Passive deployment fingerprints are heuristic; explicit deployment webhooks provide a reliable pipeline signal.

Token usage is recorded for evaluation, never used as a scheduling quota. Browser side effects cannot be rolled back after a crash; recovered jobs are instructed to inspect state before repeating an action.

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

## Addendum 3: plain-language review and browser recovery

Gus prioritized Inbox/Activity clarity over further CI work. The existing CI implementation is left in place while these screens are revised. Activity will group work into stories with a next step; Inbox will contain actionable questions, screenshots and consequences, with diffs/logs under Technical details.

Vocabulary for user-facing copy: hide job and internal safety ceilings; steward → Specbook; verification → test run; commit → save; spec fix → update to a check; proposal → suggestion. “Paused” means the user paused Specbook, locally or globally. UI and generated summaries use English, preserving quoted project/Spec names. Spec remains the existing product term and is explained as a saved check of app behavior. Server paths and Specbook stack frames must never appear in the main text.

Xvfb diagnosis: orphaned browser processes from earlier backend exits occupied every fixed display from :99 through :119. Display ownership only existed in the current process's map. The fix selects high candidate displays, checks existing sockets/locks, lets Xvfb claim its native lock atomically and waits for displayfd readiness. VNC binds an available port independently. Child supervisors close only their own processes when the backend's pipe closes, including abrupt termination; shutdown is awaited and no foreign lock is removed.

Validation: a real test started two concurrent stacks and a third in another backend process, killed only that test backend, confirmed its browser processes/lock were cleaned up and the other two stayed available, then confirmed normal shutdown closed their ports. Existing user browser processes and locks were untouched. The test lives in the existing runner suite and is explicitly enabled with SPECBOOK_TEST_VNC=1.

Addendum 3 checkpoint: Inbox questions now include consequences, available before/after screenshots and collapsed file diffs. Activity groups work by subject. Internal browser/provider failures retry without creating human questions; historical internal-failure questions are removed from the decision view. Failed required test runs remain internal while investigation continues and become a request for help only after it stops.

The daily allocation mechanism from this checkpoint was removed by addendum 5. It is not part of the current implementation; only the internal per-investigation loop safeguard remains. Recovery now uses persisted active-time heartbeats rather than counting backend downtime.

Validation at this checkpoint: both app typechecks passed; 225 tests passed with SPECBOOK_TEST_VNC=1, including browser process cleanup, presentation filtering, usage/recovery, continuation concurrency and decision actions. Inbox and Activity were inspected at desktop and phone widths in the running app. Browser fix is committed separately as 1cbf1c3; the execution and review changes are in 371d554. The remaining layout and timeline issues are addressed by addendum 4 below.

## Addendum 4: one project Overview

Gus superseded the two-screen layout before further CI work. Replace Inbox and Activity navigation with Overview, keep their old URLs as redirects, and use fixed sections: Needs you, Working on it now, Problems found, one aggregated Paused row, and History grouped by day. Use compact rows with details in the existing side sheet. Status counts and Spec-tree dots must share a single health interpretation. Remove generic narrative and repeated timeline text, sort panel events chronologically, and preserve question wording, screenshots and file diffs in review details.

Overview now replaces both screens with compact rows and the existing side sheet. Decisions exclude bug reports and sort oldest first; current work is capped at two visible rows, queues and pauses are aggregated, and finished work is grouped by day. Per-Spec health drives the header and sidebar. Timelines sort by event time, include linked run evidence and omit filler. Failed, flaky and stopped history entries have distinct outcomes. Completed batches retain their own history without hiding later work on the same Specs. Old URLs preserve their anchors when opening Overview.

Both app typechecks and five focused presentation/Overview tests passed. Live checks covered the Agora desktop/phone layout, actual sidebar health, old URL redirects, badge invalidation and project switching; the sheet returns focus to its opener. Gus sent addendum 5 during final verification, so the full six requested screenshots will be captured after replacing the daily-limit controls below.

## Addendum 5: continuous autonomy with explicit pause

Gus rejected the daily allowance and all cost controls. Daily accounting, advance reservations, extraUsage, Continue now and tomorrow-based pauses have been removed, including their database fields and APIs. Migration 0016 preserves existing counters and audit history while giving unfinished investigations a new internal attempt. Pause/resume is persistent per project and globally, separate from observe/propose/act. Running agent turns stop cleanly; resumption preserves cumulative progress and reconciles browser effects. Automatic scheduled starts and failure retries wait during a pause; explicit manual/CI runs remain available.

The only execution ceiling is internal: 500 actions and one active hour per attempt. There is no token ceiling. Up to two subsequent attempts use backoff and a prompt requiring a different approach. Continued inability to finish becomes a specific question with the recorded failure, not a quota notification. Infrastructure failures remain automatic service retries. The Overview and Automation settings expose only user pause controls.

Validation: both app typechecks, backend build and the full suite passed, including persistent local/global pause, simultaneous requests, safe tool cancellation, cumulative recovery, retry backoff and migration preservation. The live backend watcher was temporarily suspended during the next reduction so the superseded planner could not launch work between migrations. It was resumed and restarted with migration 0017 for the final UI verification.

## Addendum 6: event-driven autonomy (current product decision)

This supersedes continuous autonomy and the five-section Overview. Without a new event or a direct user request, the agent is idle. Deterministic rules connect deployments, schedules, CI requests, Spec changes, failures and newly supplied credentials to execution or investigation. The periodic LLM planner is removed. Coverage analysis and exploration require a button or chat request. Pause/resume and the removal of daily quotas still apply.

Overview is reduced to Needs you, Failing and Recent runs. It retains readable questions, evidence, file diffs, chronological detail panels and shared Spec health. The header contains the health verdict, last check and pause control. There is no planner feed or paused-work section.

### Decision rationale for the TCC

Gus selected event-driven autonomy to concentrate the product on test maintenance, pipeline verification and readable behavior contracts. These are product hypotheses about adoption, not findings from a market study. A deployment or failing run provides a concrete reason to invoke the agent and a traceable outcome to evaluate. Self-hosting and explicit triggers preserve control over when the user's LLM account is used; they do not establish a monetary cost guarantee.

The owner's review of Agora Leads reported ten Inbox items, including questions that did not support a useful decision and failures caused by Specbook's own browser infrastructure. This is a qualitative observation from the development instance. It motivates reducing unsolicited work and separating application failures from tool failures, but it does not measure false-positive rates across other applications. Continuous exploration remains available as an explicit investigation; it is not initiated by a periodic planner.

Octomind's company announcement stated that it had not obtained sufficient market validation and planned to turn off its product at the end of May 2026. This is relevant background, not evidence that autonomous exploration caused the closure or that human review guarantees adoption. See [Octomind's company announcement](https://www.linkedin.com/company/octominddev), consulted on 2026-10-06. Broader claims about vendors' commercial success require separate evidence.

The evaluation should use injected faults with independently assigned labels: test drift, application bug and environment failure. Report classification accuracy and the number of unclassified or interrupted investigations. Record whether a verified correction was merely proposed, approved by a person or applied under the established trust policy; a passing candidate alone is not a resolved production check. Measure approval and rejection among decided suggestions, reporting pending suggestions separately.

For chat-created versus hand-written Specs, use matched application flows and record authoring time, validator acceptance and repeat-run stability. Manual authoring times and injected-fault labels must be supplied by the experiment protocol, not inferred from an agent's own classification. Existing chat-turn metrics remain available; the implementation extends exportable evaluation records with investigation, classification, verification and decision events. No experiment results are claimed here.

### Addendum 6 implementation checkpoint

The planner loop, `propose_intents`, planner kind, last-planning timestamp and automatic coverage/exploration rules are deleted. Migration 0017 records why obsolete work was retired, preserves existing findings, proposals and audit history, and removes its pending questions from the decision surface. It preserves identifiable user requests, including chat and regression promotion. New requests store their source explicitly.

Run prerequisites now become questions directly, without an agent turn. Answering or supplying credentials resumes the original selected checks and preview URL. Observe still permits explicit user requests; project/global pause gates both sources. Chat agents can request background work, but background sessions cannot recursively create new tasks.

`storage/metrics/agent-events.jsonl` records classification, verification and decision events with stable identifiers and cumulative usage. Human and automatic approvals are distinct. `node apps/backend/scripts/export-metrics.mjs --agent --out agent-events.csv` exports them alongside the existing turn/run exports. Metrics exclude prompts, URLs, errors and credentials; external fault labels and manual timing still belong to the evaluation protocol.

The final Overview has three sections with shared health counts and per-check triage. Run counts use mutually exclusive outcomes during retry; resumed deployments retain their trigger, and an older classification cannot label a different failure. Pause does not overwrite run health. Coverage/exploration actions use explicit buttons in the existing toolbar, and evidence/review stays in the existing side sheet.

Live checks covered Agora Leads, Swag Labs and a temporary empty project at 1440px and 390px, with no horizontal overflow and no text below 12px. Evidence screenshots loaded, diffs stayed collapsed by default, and keyboard closure restored focus. A temporary verified locator proposal displayed one removed/added line, then approval created a repository commit with byte-identical YAML. Project pause/resume persisted. An empty project stayed at zero jobs/intentions until an explicit coverage action; that request remained pending while paused. The temporary projects were deleted through the API.

Final validation: `pnpm typecheck` passed for both apps; `SPECBOOK_TEST_VNC=1 pnpm test` passed all 239 tests with no failures or skips; the backend build passed. The added cases cover idle projects, explicit requests under Observe, migration/restart preservation, deterministic credential questions, scheduled recovery with the original selection and healer policy, exclusive retry counts, current-failure triage and metric export without sensitive text. Final live reload had zero browser console errors; font-preload warnings came from Next development mode. No frontend production build was run.

Commit split: `f952f21 refactor: drive autonomous QA through deterministic events` contains the event rules, explicit tasks, migration and evaluation records. The following Overview commit contains the three-section layout and its health/run model. Operational event reads include the full stored history: an additional Chromium regression inserted 301 later events and confirmed a blocked schedule still resumes with its saved options. That checkpoint still placed invalid checks under Failing. Phase 0 corrects this: invalid checks have their own health state, and reviewable findings without a current failed run appear in Needs you.


## Phase 0: release review corrections

Gus requested separate correction commits before merge. The branch remains unmerged and unpushed.

- First observation records a baseline without creating run intentions. Invalid or older checks are grouped into one regeneration question; acceptance is persisted before dispatch, and replacement files still require reviewed diffs.
- Observe → Propose drops stale events and considers only current content and run evidence. Triage validates the latest run and both implementation/contract hashes. Automatic cooldown and rejection matching use the check and failure kind rather than a unique run identifier.
- Pausing retains investigation instructions and cannot be overwritten by completion. CI retries and final reporting complete independently of agent pause. Failure handling uses the original failure identifier and retries temporary startup errors with backoff before considering triage.
- A five-second heartbeat records active execution time. Recovery excludes downtime; a crash may omit at most the unpersisted active interval. Finishing an execution accounts for it once.
- Automatic fixes require explicit opt-in. Assertion targets and matchers, aliases and action kinds cannot be normalized away. Revoking permission before commit rolls back the candidate and reindexes the repository.
- CI origins are explicit, private-network exceptions require a saved private IP/localhost base URL, and HTTP(S) run connections pin validated DNS addresses. Per-token trigger limits and short deployment deduplication prevent unbounded repeated batches. Webhooks require explicit private-network permission and never follow redirects.
- Overview separates invalid checks from failures. Counts, last-check time and failure rows use the same current-content evidence. Human decisions appear in Needs you; repeated runs collapse into one row with individual runs in the timeline. Empty projects have one introduction and coverage/exploration have named buttons.
- CHANGELOG now preserves the 0.1.0 release and places Robot execution and GitHub mirror removal under Unreleased.

Validation:

- `pnpm typecheck` passed for backend and frontend. `SPECBOOK_TEST_VNC=1 pnpm test` passed all 263 tests, with no failures or skips. The suite covers the current-failure guards, pause races, active-time recovery, regeneration approval/recovery, assertion preservation, CI origins, DNS rebinding, redirected navigation, webhook delivery and Overview health.
- Both application builds passed. The frontend production build used `NEXT_DIST_DIR=.next-phase0-build`; the live `.next` was preserved, and generated changes to TypeScript configuration were restored.
- The backend was explicitly restarted and migrations 0018–0021 applied at boot; `/health` returned OK.
- A temporary copy of Agora's six existing checks produced zero signals, intentions or agent actions and one grouped regeneration decision on first observation. The original repository HEAD was unchanged. Additional integration cases use 80 existing valid and 80 invalid checks. Temporary project copies were deleted through the API.

Live verification:

- Agora Leads (`d91f9891…`), Swag Labs (`0fa0cdc2…`) and the existing empty project (`1201eeac…`) were captured at 1440px and 390px. Agora now shows six invalid checks, zero failures, no misleading last-check time and one regeneration question. Its three historical runs have different repository revisions, so they stay separate with timestamps including seconds.
- Overview decisions wrap on mobile. The six captures have no horizontal overflow or page errors; the decision panel fits at 390px, and Escape closes it and returns focus. The empty project has one introduction. Existing Settings controls handled opt-in, cancellation, save/reload and CI origin editing in 19 successful browser checks, with no overflow or errors during that flow.
- Evidence is saved under `/tmp/specbook-phase0-qa/`: `agora-*`, `swag-*`, `empty-*`, `automation-*` and `ci-*` screenshots, plus browser verification logs. The copied-project report is `/tmp/specbook-phase0-import-results.json`. Temporary projects were removed through the API; existing project files and repository HEADs were preserved.

Correction commits:

- `dad4590`: preserve paused investigation instructions (finding 5).
- `e27324f`: finish CI reporting independently of pause (finding 3).
- `5727d54`: recover active time without charging downtime (finding 6).
- `8736233`: guard completion and environment retries against a concurrent pause (finding 7).
- `e1f1095`: retry transient startup failures and deduplicate triage by the original failure (finding 8).
- `e5445af`: restrict CI destinations, rate-limit tokens and deduplicate deploys (finding 9).
- `0bbe4eb`: require explicit permission for private webhooks (finding 10).
- `24c351b`: preserve assertions and require automatic-fix opt-in (finding 4).
- `5daa622`: seed existing checks silently and request regeneration once (finding 1).
- `de13ba0`: discard stale signals and deduplicate current failure subjects (finding 2).
- `9f4556b`: correct Overview health, decisions and repeated-run presentation.

The separate documentation commit preserves 0.1.0 and documents these breaking changes under Unreleased. Phase 0 has no remaining implementation work. Merge and push remain outside this request. Pre-existing changes in `.gitignore` and `apps/frontend/next-env.d.ts` were not included.
