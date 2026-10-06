# Autonomous agent progress

Branch: `feat/autonomous-agent`. Product owner: Gus. No pushes.

## Foundation (implemented)

Jobs reuse the chat turn runner and domain/browser/credential tools. SQLite stores the queue, usage, audit entries, Inbox items, and human answers; chat session files retain the conversation. Jobs have default budgets and need no steering fields. `SPECBOOK_MAX_CONCURRENT_JOBS` defaults to `SPECBOOK_MAX_CONCURRENT_RUNS` (or 2); verification runs still use the existing run slots.

Job policy wraps repository tools: create/update calls propose changes, never apply them. Inbox approval calls the existing repo writer with a repository-head check and an Inbox commit marker. Stale proposals require a fresh proposal. Replayed approvals find their existing commit. Source-only patches preserve the original YAML bytes. Human answers resume the same session and retain cumulative budgets.

Actions are reserved and persisted before execution. Tokens are accounted after each model response, so one response can exceed the threshold; the next action/response is stopped. Wall time includes browser/model setup and excludes time awaiting a human. Interrupted running jobs return to the queue; they inspect the Inbox and app state before continuing. Browsing has no transactional rollback, so prompts explicitly prohibit blindly replaying mutations.

UI: per-project Inbox and Jobs pages, reviewable original/proposed files, question answers, status, usage and audit logs. Job chats stay out of the human chat list and cannot be driven through chat mutation endpoints.

## Remaining work, in order

2. Legacy migration: isolated proposal verification and migrate-all action.
3. Failure triage and verified healer proposals.
4. Optional schedules and status webhook notifications.
5. Retry once, classify flakiness, show run history.
6. Coverage-gap jobs.
7. Exploratory bug hunting with discovery policy and axe.
8. Token-authenticated CI trigger and README workflow.
9. ARIA snapshot assertion allowlist and console/network run evidence.

## Verification

`pnpm typecheck` and all 179 tests pass. Added integration coverage for stale proposals, idempotent approval, byte-preserved YAML, project isolation, action budgets, credential questions, and recovery. Restarted the backend and verified a real LLM job creates an Inbox question; answering in the UI resumed the session and cumulative token accounting stopped it at the test budget. Checked Inbox and job audit views in the running Next dev app.

## Existing local change

`apps/frontend/next-env.d.ts` was already modified when work began; leave it out of feature commits.
