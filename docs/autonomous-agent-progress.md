# Autonomous agent progress

Branch: `feat/autonomous-agent`. Product owner: Gus. No pushes.

User corrections: preserve existing UI patterns/components. Remove all obsolete format support; the original request to migrate Robot Specs is cancelled. Current code supports spec.yml + spec.ts only. Do not delete existing storage data.

## Foundation (implemented)

Jobs reuse the chat turn runner and domain/browser/credential tools. SQLite stores the queue, usage, audit entries, Inbox items, and human answers; chat session files retain the conversation. Jobs have default budgets and need no steering fields. `SPECBOOK_MAX_CONCURRENT_JOBS` defaults to `SPECBOOK_MAX_CONCURRENT_RUNS` (or 2); verification runs still use the existing run slots.

Job policy wraps repository tools: create/update calls propose changes, never apply them. Inbox approval calls the existing repo writer with a file-content check for existing Specs and repository-head check for new files and an Inbox commit marker. Stale proposals require a fresh proposal. Replayed approvals find their existing commit. Source-only patches preserve the original YAML bytes. Human answers resume the same session and retain cumulative budgets.

Actions are reserved and persisted before execution. Tokens are accounted after each model response, so one response can exceed the threshold; the next action/response is stopped. Wall time includes browser/model setup and excludes time awaiting a human. Interrupted running jobs return to the queue; they inspect the Inbox and app state before continuing. Browsing has no transactional rollback, so prompts explicitly prohibit blindly replaying mutations.

UI: per-project Inbox and Jobs pages, reviewable original/proposed files, question answers, status, usage and audit logs. Job chats stay out of the human chat list and cannot be driven through chat mutation endpoints.

## Remaining work, in order

2. Removed obsolete Robot compatibility and plaintext-token conversion. No migration job or migration action.
4. Optional schedules and status webhook notifications.
5. Retry once, classify flakiness, show run history.
6. Coverage-gap jobs.
7. Exploratory bug hunting with discovery policy and axe.
8. Token-authenticated CI trigger and README workflow.
9. ARIA snapshot assertion and console/network evidence are implemented with failure triage.

## Verification

`pnpm typecheck` and all 191 tests pass. Added integration coverage for stale proposals, idempotent approval, byte-preserved YAML, project isolation, action budgets, credential questions, and recovery. Restarted the backend and verified a real LLM job creates an Inbox question; answering in the UI resumed the session and cumulative token accounting stopped it at the test budget. Checked Inbox and job audit views in the running Next dev app.

## Existing local change

`apps/frontend/next-env.d.ts` was already modified when work began; leave it out of feature commits.

## Failure triage (implemented)

Automated manual/batch failures persist a pending dispatch flag. A monitor creates at most one triage job per run; boot resumes undelivered failures. The agent reads failed-step screenshots, ARIA/error context and bounded console/network diagnostics, investigates, and classifies drift, application bug or environment. The tool policy permits source-only fixes for drift. Candidate execution occurs outside the project checkout; approval requires a passing result for the same source and URL. Independent Spec approvals do not stale each other.

Question tools abort the active turn after persisting their question. Spec execution and run-slot queues honor cancellation. Job browsers close when work stops. Tool parameters now derive from shared Zod schemas.

A real migration rehearsal against a temporary SauceDemo project passed before Gus cancelled that feature. Its temporary project was deleted via the API; no migration UI or code is retained. Proposal verification remains for the healer.

Live healer verification: a temporary SauceDemo Spec with a deliberately outdated username locator failed, automatically started a job, received browser investigation plus screenshot/ARIA evidence, was classified as test drift, and produced a passing isolated candidate (8 actions). Approval through the Inbox UI committed the source-only patch. Desktop and 390px Inbox/Jobs checks passed without horizontal overflow. All contract bytes remain unchanged.

## Gus's addenda: revised direction

Jobs are internal execution records. The project steward observes failures, invalid Specs, deployments, confirmed context, Git changes, credentials and chat requests, then persists prioritized intents. It must enforce daily budgets, deduplication, cooldowns and remembered human decisions. The default autonomy is propose; observe and act are optional. Activity replaces the Jobs page; there is no job creation form. Inbox contains proposals, questions and bug reports that need a human. The steward must work without required setup fields.

Remove the GitHub repository mirror in its own commit, including API, UI, credentials, background sync and database columns. Keep the built-in Git Smart HTTP remote and GitHub Copilot OAuth. Historical Drizzle migrations remain so existing databases can migrate forward without deleting user data.

After the steward, replace the original CI trigger with scoped CI tokens, run/deploy APIs, bounded waiting, JUnit and Markdown results, preview URLs, build metadata, quality-gate options and a dependency-free client. Settings and README will include GitHub Actions, GitLab, Bitbucket, CircleCI and Jenkins snippets. Deploy webhooks also feed the steward.

## Resume checkpoint

Optional schedules and webhook delivery were already prepared before the addenda: persisted UTC cron, selected Specs, missed-run coalescing, overlap prevention, an encrypted notification outbox with bounded retry, and an Automation settings tab using existing components. Commit this completed foundation before removing mirror columns, because its generated migration precedes the removal migration. Live schedule verification is pending.

The Activity/Inbox navigation changes are still uncommitted and need the steward activity endpoint. The unfinished steward tool draft is saved at `/tmp/specbook-steward-resume/tools.ts` while its engine is implemented; it is not wired into chat yet. Next: remove the mirror, complete steward and Activity, implement retry/flakiness, then CI/CD and the remaining coverage/exploration work. No manual-job UI should return.

Schedule checkpoint validation: `pnpm typecheck` and all 194 tests pass. After restarting the backend, a real scheduled SauceDemo batch started at the next UTC minute and passed. The Automation tab loaded the persisted settings in the running frontend without console errors. Webhook retry is being checked against a temporary receiver.

## GitHub mirror removal (implemented)

Removed mirror routes, connection UI, remote credentials, background pulls/pushes, conflict resolution, force-publish after rebase and the mirror-only Spec status. Migration 0011 drops the four mirror columns; boot reindex derives current Spec status from files. Built-in Git Smart HTTP, scoped repository tokens, canonical bare repositories and Copilot OAuth remain. README now points to Settings → Git.

Validation: `pnpm typecheck` and 189 tests pass (five mirror-only tests removed). Restarted the backend, confirmed the removed endpoint returns 404, and cloned/pushed the temporary QA repository with a scoped token, then revoked it. The optional schedule's running/passed webhook deliveries both succeeded on retry. General Git conflict/dirty-tree safeguards remain to protect externally edited repositories.

## Project steward (implemented, validation in progress)

Signals, intentions and observations survive restarts. Deterministic rules cover failed/invalid/stale/changed Specs, empty projects, confirmed context and new credentials. Lightweight deployment checks compare build asset URLs, ETag or a bounded response hash every five minutes, with backoff for unavailable apps. A daily planner reuses the job runner and proposes prioritized intents through Zod-derived tools. Chat and jobs can request background work without a job creation form.

The steward reserves queued/running/blocked job budgets against 300,000 tokens and 30 active minutes per project per UTC day. It serializes dispatch per project, limits autonomous batches to twelve per day, deduplicates signal and intent keys, gives equivalent work a six-hour cooldown and remembers rejected proposals for the same Spec/context version. Credential signals resume credential questions. Completion signals return to Activity. Observe records future signals without dispatch; propose is the default. Act may apply verified selector-only fixes after three approved examples, with no rejected examples; AST comparison excludes changed inputs, assertions or contract fields.

Activity replaces the Jobs page and exposes audit/evidence links. Automation settings reuse the existing settings rows for the optional autonomy level. Autonomous browser tools remain visible, with the discovery origin/destructive-action policy checked when invoked. Spec regeneration is implementation-only and requires isolated verification. Coverage jobs receive confirmed context and prior decisions; advanced exploratory diagnostics/axe and CI/CD remain to implement.

Steward validation: all 191 tests passed before starting the next feature, including concurrent dispatch/idempotency, observe mode, reserved budgets, remembered rejection and AST safeguards. Restarted the running backend; automatic coverage/regeneration jobs entered the queue, some asked for access in Inbox, and the per-project daily planner appeared without manual creation. Activity loaded at 390px with no horizontal overflow. Old instruction-heavy job goals now render as human-facing activity titles.

## Flakiness (implemented)

Failures now rerun once before triage. A unique retry reference survives restart; the monitor checks the original source and YAML hashes before retrying or healing. Pass-on-retry flags both attempts as flaky and emits no healer signal. Disabling healing still allows the retry. Runs persist the actual URL so preview retries cannot accidentally run against the project's default URL.

History retains both attempts, a link to the first attempt and existing warning badges for flaky Specs. Nine real-browser tests passed, including restart replay, changed contracts and URL overrides. Live verification produced one failed attempt and one passing retry, preserved the YAML bytes, showed both attempts in the UI and created no job.

## CI/CD (implemented)

Migration 0014 adds hashed, project-scoped CI tokens independent of Git tokens. Settings → CI/CD creates, rotates and revokes a token, supplies snippets for GitHub Actions, GitLab CI, Bitbucket Pipelines, CircleCI and Jenkins, and lists batches with commit/ref/build metadata and evidence links. No GitHub API or GitHub App integration is involved.

Authenticated endpoints start all/selected/Feature Specs, wait with bounded long polling, export JSON/JUnit/Markdown, download the dependency-free Node client, and accept generic deployment signals. Quality gates snapshot existing Inbox bugs at batch creation and waive known failures and flaky results by default. Busy Specs return 409 without queuing an orphan batch. The client retries transient GET failures within its deadline and never retries POST.

Preview URLs persist through batch execution, retry, healer investigation and isolated proposal verification. They do not grant credential access: stored secrets retain their canonical project/profile origins. A real-browser test verified that an untrusted preview receives no typing event or form submission, then passes after explicit origin authorization. Browser, credential and session calls now propagate cancellation to MCP; cancelling a job also closes its browser.

Steward collection now uses deterministic observation generations to deduplicate crash replays while retaining real reversions. A failed run prerequisite creates a budgeted investigation and an Inbox question; completion can retry the original environment without an unlimited retry loop.

Validation: 209 tests and both app typechecks passed before the final review. Six CI-specific tests pass, including atomic busy rejection and client reconnection. Live checks covered token creation/rotation/revocation, real Chromium on a preview URL, the client and report exports, deploy signals, and the settings UI at desktop/390px. Provider-specific deploy adapters are optional and are not included; all providers can use the generic endpoint.

Next: finish exploration/coverage verification and replace proposal field dumps with file diffs as requested by Gus. Then consolidate this log and delete only the temporary verification projects via the API.

## Coverage and exploration (implemented)

Coverage jobs compare confirmed areas, roles and rules with existing Specs. Independent coverage requests retain distinct intent fingerprints, and an exact rejected proposal cannot be silently recreated. Bug reports have a "Promote to regression Spec" action that creates one persisted coverage intent; the repository remains untouched until proposal approval.

The agent now has a Zod-derived scan_page tool. It runs fixed, trusted axe code on the current project page and captures bounded console/network errors and same-origin link checks. Link checks use HEAD with short timeouts, skip destructive names/URLs (including encoded variants), and do not follow redirects. Page diagnostics redact stored secrets and query values, persist in job audit entries, and link from bug reports to Activity. Cancellation propagates through the scanner and prevents saving incomplete evidence.

Validation: the existing runner suite passes with real Chromium and Playwright MCP, including HTTP errors, accessibility violations, destructive/off-origin links, redirects and secret redaction. Integration tests cover promotion idempotency/project isolation, unchanged repositories, independent coverage requests and rejected proposals. Final full-suite validation is running alongside the diff review change.
