# Changelog

All notable changes to Specbook appear in this file. Future entries are generated from Conventional Commits by Release Please.

## [0.2.0](https://github.com/gustavo-ferreira03/specbook/compare/v0.1.0...v0.2.0) (2026-07-21)


### Features

* add chat_sessions table and repository for saved browser sessions ([afa9444](https://github.com/gustavo-ferreira03/specbook/commit/afa94448d42d38ba64e42e104854fa4066056b71))
* add project context card to specs dashboard ([99cd1a6](https://github.com/gustavo-ferreira03/specbook/commit/99cd1a63be7d497edeb7061a1e1f0c5c3e8e3f77))
* add save_session and resume_session chat tools ([0d9cb19](https://github.com/gustavo-ferreira03/specbook/commit/0d9cb192c7e3b11202c66092bb45d3f17e829697))
* chat tools for listing credentials and filling secrets ([8a44ba9](https://github.com/gustavo-ferreira03/specbook/commit/8a44ba9aa6691e2c1150b419fbaf7512e1c51222))
* credential profiles API and settings UI ([e82f6c4](https://github.com/gustavo-ferreira03/specbook/commit/e82f6c4ab367b5300f0d0483dfb45d634af67ab6))
* credential profiles store with encrypted secrets ([f40778a](https://github.com/gustavo-ferreira03/specbook/commit/f40778a1c752a933dda68fa01c69cae8cdb1bade))
* enable storage capability in the chat MCP browser for session save/restore ([08f5934](https://github.com/gustavo-ferreira03/specbook/commit/08f593483216601e168de02f3d9a233f8afc7f9f))
* match All Specs height to Status Breakdown, add Run dropdown ([df5036a](https://github.com/gustavo-ferreira03/specbook/commit/df5036a5cde0d43137f6652acd5da9a90ec61f0d))
* request_credential flow with secure chat form ([d37dd50](https://github.com/gustavo-ferreira03/specbook/commit/d37dd508e04b9b001ce2e22edeb8d8f11557300e))
* runner secret injection via Fill Secret env references ([0bfa78b](https://github.com/gustavo-ferreira03/specbook/commit/0bfa78baa9033f2549aa14cce7a7f8ddde5e9618))
* scrub secret values from browser tool output ([ffc0954](https://github.com/gustavo-ferreira03/specbook/commit/ffc09547283839485acf71f9202dceab9c9ac0e6))
* teach the agent qa.tech-inspired authoring style and element-finding troubleshooting ([8b43713](https://github.com/gustavo-ferreira03/specbook/commit/8b437139f011a62465613eec0b72dc63e36c918e))
* teach the chat agent the credential workflow ([99dae04](https://github.com/gustavo-ferreira03/specbook/commit/99dae048607deed2fc7a4a876febf8eaca90b256))
* wire session persistence tools into chat and guide the agent to use them ([980ad9e](https://github.com/gustavo-ferreira03/specbook/commit/980ad9e41b575addae61f00e667ad70f9a839aad))


### Bug Fixes

* cap All Specs height at 320px, remove fixed height from chart panel ([5c06d2f](https://github.com/gustavo-ferreira03/specbook/commit/5c06d2f4d08620355c19f3d6ad0f1a2660edea7b))
* cascade-delete saved chat sessions when a credential profile is deleted ([415139f](https://github.com/gustavo-ferreira03/specbook/commit/415139fe67ec995b6583644c502b0e2a4577ad01))
* make Specs list scrollable ([7ca595d](https://github.com/gustavo-ferreira03/specbook/commit/7ca595da28b7ca68582d37982811a34dd25861ca))
* move project title before stats, remove card wrapper ([fb833d0](https://github.com/gustavo-ferreira03/specbook/commit/fb833d03248e8c20aa234e199776a5ee0396669a))
* navigate to tab home on re-click ([f83fb28](https://github.com/gustavo-ferreira03/specbook/commit/f83fb280f1ea8f9aec9ccbfaee7cd7a5c2002c8d))
* resolve secrets fresh on every scrub call, not once per chat turn ([d299d36](https://github.com/gustavo-ferreira03/specbook/commit/d299d368cc6636141ec4dda8fa9c12cb33483eff))
* use correct target parameter name for browser_type/browser_click in fill_secret ([e7a1372](https://github.com/gustavo-ferreira03/specbook/commit/e7a13729afc65472e8730a3a6f0ebc1ec7026faf))


### Reverts

* restore borders on stat tiles and chart panel ([fa1b166](https://github.com/gustavo-ferreira03/specbook/commit/fa1b166b4a51c2553fc67dda1959112e0e93e4bc))

## [0.1.0] - 2026-07-18

### Added

- Git-backed project repositories with YAML Specs and Robot Framework execution.
- Visible browser-assisted authoring, guided project discovery, run evidence, and manual file editing.
- A public Docker image at `ghcr.io/gustavo-ferreira03/specbook`.
