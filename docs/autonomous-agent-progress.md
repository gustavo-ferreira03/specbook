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
