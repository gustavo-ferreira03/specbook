# Security and model-provider data

Specbook is a self-hosted application with instance-wide permissions. Every user belongs to the same instance and can read its projects. Use separate instances when teams need separate data boundaries; there are no per-project access controls.

| Role | Access |
| --- | --- |
| Viewer | Read projects, Specs, conversations and run evidence |
| Editor | Viewer access plus project changes, runs, chat, credentials and browser interaction |
| Admin | Editor access plus members, models, SSO, agent safety, global pause, retention and audit |

The API denies access unless a route declares its policy. Browser sessions use opaque tokens stored as hashes, httpOnly SameSite=Lax cookies and a custom header on state-changing requests. Passwords use scrypt. Disabling an account or changing its role revokes sessions; browser streams and chat events close when access expires or is revoked.

Git and CI tokens are scoped to a project and stored as hashes. Revoke them in that project's settings. Artifact downloads require a signed-in account. CI tokens retrieve JSON, JUnit and Markdown results; their evidence links open in the authenticated interface. Treat artifacts as project data: screenshots can contain information visible in your application.

## What reaches a model provider

Agent requests include the conversation, project URL and confirmed context, relevant Spec and Feature files, tool results, and page snapshots. Failure investigation can include screenshots and browser error context. The chosen model provider processes those requests under its own terms.

Admins can disable **Screenshots sent to model** in **Settings → Agent safety**. The setting also filters image content from restored conversations and active sessions. It leaves local run evidence available; textual page snapshots, console messages and relevant network diagnostics can still contain application data.

Private credentials belong in the Credentials form. The agent receives profile and field names and asks a tool to type the value; the tool checks the allowed origin. Known secrets are scrubbed from textual tool results, logs and failure evidence. Don't paste passwords or tokens into chat: arbitrary text and images cannot be guaranteed free of sensitive information.

Model keys, saved application sessions, credential values, notification webhook URLs and SSO secrets use AES-256-GCM at rest. The default key lives in the storage directory, so someone who obtains both can decrypt them. An [external encryption key](operations.md#encryption-keys-and-upgrades) keeps that key outside the data volume. The host, its administrators and its backups remain part of the trust boundary.

## Agent actions and review

`spec.yml` defines expected behavior. The agent must propose changes to it for human review. It may investigate and propose a `spec.ts` implementation repair, which must validate and pass verification before it qualifies as a tested fix.

Automatic locator approval is disabled globally by default. An admin can allow it and opt in per project; eligibility and policy are checked again before applying the commit. Other behavior decisions remain in Overview.

Discovery and autonomous exploration check the actual browser snapshot reference before a click. They reject destructive names, form submission and unapproved browser actions. Interactive chat shares the origin policy and keeps its broader tools available. Chromium blocks document navigation outside the project and credential origins, including redirects.

These controls reduce accidental changes; they are not isolation from a hostile application. Pages load scripts and subresources, and an allowed page can itself send requests. Use an application environment and account whose permissions match the checks you intend to perform.

Specs run through a restricted TypeScript/Playwright validator and runtime. A run that uses credential values disables video and the HTML report. Step screenshots still capture the page and can contain sensitive visible content. Tests that avoid credentials can retain failure video and a report until retention expires them.

## Audit and operations

Admins can review the audit log for member actions, chat tool calls, repository commits and autonomous work. Interactive commits use the acting user's name and email. The audit log omits tool argument bodies and scrubs known project secrets; API responses return a public error identifier instead of a server stack trace; backend logs retain diagnostic details for the operator.

Backups contain private project data. Local-key backups also contain the key needed to decrypt credentials. Keep them in restricted storage and follow the [restore and rotation procedures](operations.md). Security reports belong in the process described in [SECURITY.md](../SECURITY.md).
