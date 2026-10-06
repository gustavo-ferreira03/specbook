# Frequently asked questions

## What does Specbook keep as a Spec?

A Spec pairs readable behavior in `spec.yml` with an executable Playwright check in `spec.ts`. Features organize those files in the project's Git repository. Run history and evidence show whether the recorded behavior still works against the application.

## Does the agent run all the time?

It responds to events and requests. Changed checks, deployment signals, schedules and failures can start work according to the project's settings. The project steward uses deterministic rules, without an idle LLM planning loop. Coverage analysis and exploratory browsing require a request through Overview or chat. You can pause autonomous work for one project or the whole instance.

## Can it change what my application is supposed to do?

A change to `spec.yml` is a proposal for a person to approve. Most implementation fixes also arrive as proposals with diffs. Administrators can explicitly allow a narrow automatic path for verified action-locator fixes, with project opt-in and prior approved examples; that path cannot weaken assertions or change action kinds. Review remains the default.

## What happens after a failed check?

Specbook retries once. A pass on retry marks the check flaky, preserving both attempts. A repeated failure can start an investigation that distinguishes test drift, an application bug and an environment problem. The result is a proposed verified fix, a bug report or a question. A classification is evidence to review, not proof that the agent's conclusion is correct.

## Can it use a login for my application?

Save a credential profile in project Settings or complete the credential form requested by the agent. Values stay in encrypted storage and are filled locally through tools restricted to permitted origins. Avoid pasting secrets into chat. A preview deployment needs its origin explicitly allowed on a credential profile before that profile can be used there.

## What data reaches my model provider?

Agent requests can include your messages, project context, Spec content and tool results from the application, including page text and screenshots. Administrators can turn off sending screenshots to the model. That switch does not remove sensitive text from page content or from a message you type yourself.

Self-hosting keeps the application and its stored data on your infrastructure; it does not make requests to an external LLM provider local. Choose a provider and model compatible with your data policy. Check the [security model](security.md) before connecting confidential applications.

## Which model provider do I need?

Select a provider and model available in global Settings, supply its credentials and use **Test connection**. The model registry supports API-key providers and OAuth connections for Anthropic, OpenAI Codex and GitHub Copilot. Availability depends on the installed registry and your provider account. Creating or investigating Specs needs a configured model; executing existing valid Specs uses Playwright directly.

## Do I need GitHub?

You do not need a GitHub repository for a project. Specbook owns each project's Git repository and serves a normal clone/fetch/push remote with a project token. GitHub Copilot is an optional model provider; GitHub Actions is one of several CI clients you can use. Neither changes where Specbook stores your Specs.

## Can separate teams share one instance privately?

Roles apply across the instance. Projects organize work; they are not access-control boundaries. Viewers can read project data, editors can change it and administrators manage the installation. Use separate instances when groups must not see each other's projects. See [SSO and accounts](sso.md) for invitations and identity-provider configuration.

## How does it fit into CI?

A project CI token starts checks against the saved application URL or an allowed preview origin. The client waits and writes JUnit and Markdown reports. Configure whether flaky checks and known bugs fail your gate. Pausing the agent does not prevent CI results from finishing. Your runner must reach Specbook, and Specbook must reach the application being checked.

## Is browser automation harmless on production?

A browser can make real changes. Discovery and exploration restrict destructive actions and origins, but policies are not a substitute for a test account and a controlled environment. Use an application and account where the flows you intend to test are authorized, especially for payments, deletion or publication.

## Can I move or recover my installation?

Back up the database, repositories, evidence and matching encryption key using the [operations commands](operations.md), then restore into an empty storage directory. A local-key backup contains enough material to decrypt its credentials, so protect it. An external key must be preserved separately. Copying only the project Git repositories does not preserve accounts, sessions or run history.

## How much hardware should I allocate?

The [architecture guide](architecture.md#capacity-planning) gives a starting allocation for a small pilot. It is a suggestion, not a benchmark. Measure representative runs before increasing concurrency, and set retention so evidence cannot consume the entire disk.
