# Security policy

Specbook is self-hosted software maintained by Gus. Its accounts and roles apply to the whole instance: a project is not a tenant or a private workspace. Administrators control provider credentials and security settings. Use separate installations when users must not share access to project data.

## Report a vulnerability privately

Use [GitHub's private vulnerability report](https://github.com/gustavo-ferreira03/specbook/security/advisories/new). Include the affected commit or image tag, a minimal reproduction, the expected access boundary and the observed impact. Remove real credentials and personal data from attachments.

If private reporting is unavailable, contact Gus through an available private contact method on the [maintainer profile](https://github.com/gustavo-ferreira03). If no method is listed, open an issue asking for a private security contact, without vulnerability details, exploit steps, credentials or affected identities. Do not post the report itself in a public issue or discussion.

Gus will review the report and coordinate a fix and disclosure with the reporter. There is no guaranteed response deadline. Security fixes target the current development line and the latest release; backports to other versions are not guaranteed. Reports are welcome even when the affected version is uncertain.

## Deployment boundaries

Expose shared installations through HTTPS and configure the allowed hosts. Protect the storage volume and encryption key; encryption at rest does not prevent someone controlling the backend process from using its credentials. External model providers receive the data supplied to agent requests according to your configuration and their policies.

Browser actions can alter the application under test. Run only authorized flows, using suitable accounts and environments. The validator, origin checks and agent policies reduce risk but do not turn arbitrary third-party pages or model output into trusted instructions.

Read the [security model](docs/security.md) for data flows and controls, [SSO setup](docs/sso.md) for account configuration, and [operations](docs/operations.md) for backup and key handling.
