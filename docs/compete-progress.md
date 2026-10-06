# Competitive release progress

Completed on `feat/compete`, based on `main` (`20e836c`), with the later main polish merged before integration. All six features were verified and merged locally into main in `9cd2988`. No push or tags.

## Scope

- Named environments, including Production migrated from the saved project URL.
- Selected batches of proposed Specs, generated and run individually.
- Draft Specs and explicit activation; automated runs include active Specs only.
- Restricted Playwright API tests with redacted evidence.
- Coverage and Spec health against confirmed project context.
- PR/MR feedback posted by the CI client, never by the backend.

## Decisions

- Runs retain an environment snapshot, including the credential mapping, so retries and investigations use the original destination.
- Selecting a proposed Spec authorizes its creation as a draft. Expected behavior remains reviewable; existing behavior contracts are never silently rewritten.
- Draft is an operational state, separate from the result of the last run.
- Environment credential overrides explicitly map a profile used by a Spec to another saved profile. Production credentials are not implicitly authorized for other origins.
- GitLab's ordinary job token cannot create merge-request notes. The client will use a masked project access token for this operation and document that limitation.
- Preserve the existing row-based screens, side panels, typography and components.

## Implementation

Implemented all six features. Named environments and snapshots, draft lifecycle and automation exclusions, selected batch generation with durable recovery and incremental results, API request guards and evidence, confirmed-context coverage and environment health, and CI-owned PR/MR feedback are integrated.

Shared schema/type groundwork is included with the environment foundation. Feature commits separately cover environments, draft execution policy, batch proposals, API Specs, coverage and CI feedback.

Merged the main UI polish (`c4af2b2`) into the feature branch in `934727c`: use “Spec” consistently, retain the simple Overview title and Project context page, one theme toggle, and no redundant model/chat status pills.

Final review also fixed stale coverage responses, links to matched Specs, GitLab merge-request pipeline rules, environment-save and lifecycle-operation races, unfinished generation recovery, and human chats disappearing after batch proposals. Generation retries internal stalls before asking for help; a saved draft and its first result are required for completion.

## Verification

Passed focused API, credential/session, batch selection, documentation safety, CI mock and coverage/access tests. Public httpbin requests passed with secrets in headers and JSON bodies; evidence contains no secret, and API-only runs work without browser binaries. Desktop/mobile interactive checks (1440px/390px) show no overflow and 14px body/12px minimum text.

The isolated running app exercised selected-Spec creation through the authorized generation tool and a passing first browser run against SauceDemo, plus a manual API run in Staging. No real model generation was exercised and no user provider credentials were copied.

The final integrated typecheck and full suite passed (291 tests, no failures or skips), including the review corrections. Backend and isolated frontend production builds passed without touching the live development build.

The running app also verified environment creation/editing/deletion, environment-specific coverage at both widths, a passing Staging API batch, and the real zero-dependency CI client against that environment. It included one active Spec, excluded the draft, exited successfully, and wrote JUnit (one test, zero failures) and a Markdown summary. A deliberately delayed Production response did not overwrite the selected Staging coverage; the matching-Spec link opened its actual feature.

A private storage archive and SQLite backup were taken before the transparent migration. The restarted backend on port 4000 is healthy: all nine project URLs and CI origin lists became Production environments, all 23 existing Specs remained active, and the existing user remained present. Hash verification found no changes or missing files among 8,986 preexisting storage files. The temporary QA project was deleted through the API (204), leaving no projects in the isolated QA instance; its servers and browser sessions were closed. The original frontend development session remains running.

Live PR/MR publishing was not exercised against provider accounts; local provider mocks verify create/update, duplicate handling, failure results and token redaction. Coverage is an inference from confirmed context, Spec text and tested routes, not a claim of complete behavioral coverage.
