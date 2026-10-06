# Competitive release progress

Branch: `feat/compete`, based on `main` (`20e836c`). Local merge after verification; no push or tags.

## Scope

- Named environments, including Production migrated from the saved project URL.
- Selected batches of proposed checks, generated and run individually.
- Draft checks and explicit activation; automated runs include active checks only.
- Restricted Playwright API tests with redacted evidence.
- Coverage and check health against confirmed project context.
- PR/MR feedback posted by the CI client, never by the backend.

## Decisions

- Runs retain an environment snapshot, including the credential mapping, so retries and investigations use the original destination.
- Selecting a proposed check authorizes its creation as a draft. Expected behavior remains reviewable; existing behavior contracts are never silently rewritten.
- Draft is an operational state, separate from the result of the last run.
- Environment credential overrides explicitly map a profile used by a check to another saved profile. Production credentials are not implicitly authorized for other origins.
- GitLab's ordinary job token cannot create merge-request notes. The client will use a masked project access token for this operation and document that limitation.
- Preserve the existing row-based screens, side panels, typography and components.

## Implementation

Implemented all six features. Named environments and snapshots, draft lifecycle and automation exclusions, selected batch generation with durable recovery and incremental results, API request guards and evidence, confirmed-context coverage and environment health, and CI-owned PR/MR feedback are integrated.

Shared schema/type groundwork is included with the environment foundation. Feature commits separately cover environments, draft execution policy, batch proposals, API Specs, coverage and CI feedback.

Gus's latest steering adds the main UI polish (`c4af2b2`) before integration: use “Spec” consistently, retain the simple Overview title and Project context page, one theme toggle, and no redundant model/chat status pills.

## Verification

Passed focused API, credential/session, batch selection, documentation safety, CI mock and coverage/access tests. Public httpbin requests passed with secrets in headers and JSON bodies; evidence contains no secret, and API-only runs work without browser binaries. Desktop/mobile interactive checks (1440px/390px) show no overflow and 14px body/12px minimum text.

The isolated running app exercised selected-Spec creation through the authorized generation tool and a passing first browser run against SauceDemo, plus a manual API run in Staging. No real model generation was exercised and no user provider credentials were copied.

The first full suite finished with two failures: a fixture had no permitted preview origin under the new environment rules, and an expected health response omitted the new draft count. Correcting these expectations, incorporating the main polish, then rerunning the full suite and isolated production builds remain before local merge.
