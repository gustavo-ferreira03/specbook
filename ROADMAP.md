# Roadmap

Specbook's current focus is a self-hosted QA workflow for independent developers and small teams: readable Specs, checks against a live application, failure investigations and reviewable changes. Gus owns product direction. This page describes priorities, not delivery dates or commitments to specific integrations.

Next work should improve the parts people depend on during a pilot:

- Broaden verification of identity-provider recipes and deployment environments, with reproducible checks and clearer diagnostics when setup fails.
- Measure browser resource use and run reliability on representative applications so sizing guidance can become evidence-based.
- Improve the path from a failure to a decision: useful evidence, understandable proposals and less repeated investigation.
- Refine coverage analysis and exploration from real project feedback, while keeping both on demand.
- Keep installation, upgrades and restore instructions tested as dependencies and container images change.

Behavior contracts remain human-owned. Automation responds to events, and changes to `spec.yml` require review. The interface should continue to put Specs and their status before internal agent machinery; [PRODUCT.md](PRODUCT.md) describes that direction.

Managed hosting, billing, multi-tenancy, per-project access control and translations are outside the current scope. Raise use cases in [Discussions](https://github.com/gustavo-ferreira03/specbook/discussions) before beginning a large feature; report reproducible defects in [Issues](https://github.com/gustavo-ferreira03/specbook/issues). Security reports follow [SECURITY.md](SECURITY.md).
