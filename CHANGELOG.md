# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-03-24

### Added
- Live `/dashboard` view for routing volume, classifier mix, spend/savings, recent history, and active session overrides
- Conversation-scoped natural-language routing controls such as `use opus`, `prefer code`, `thinking high`, and `reset routing`
- Session override tracking in `/stats`, including recent override summaries
- Cost estimation against a configurable dashboard baseline model
- Native Anthropic thinking support for direct `anthropic-messages` models, including adaptive thinking on Claude 4.6 and interleaved-thinking headers where applicable

### Fixed
- Preserve model cost metadata during provider normalization and router-config imports
- Extract Anthropic text responses correctly when thinking blocks appear before text blocks

## [0.6.0] - 2026-03-24

### Added
- Optional `RouterAI` tier classification mode with setup-time model selection
- Setup wizard prompt for choosing between deterministic heuristics and AI-assisted routing
- Decision logs now show whether a request was classified by heuristics or RouterAI

### Changed
- Keep deterministic heuristics as the default routing classifier, with automatic fallback whenever RouterAI is unavailable or fails

## [0.5.1] - 2026-03-24

### Fixed
- Stabilize `claw-auto-router service restart` by waiting for launchd unload/load transitions before re-bootstrap

## [0.5.0] - 2026-03-24

### Added
- macOS `launchd` background service management via `claw-auto-router service`
- Automatic background service install/start during `setup` and `clean-setup` on macOS
- Setup summary now reports background service status and how to verify it

### Fixed
- Launchd services now resolve Node-based CLI entrypoints correctly instead of failing on `env: node: No such file or directory`

## [0.4.1] - 2026-03-24

### Changed
- Default local router port is now `43123` to avoid common port collisions on developer machines
- Docker and setup documentation now use the new default port consistently

### Fixed
- Suppress the self-reference warning for `claw-auto-router/auto` during normal startup
- Publish workflow now creates a GitHub Release alongside npm publishing

## [0.3.1] - 2025-03-23

### Added
- Routing decision logs (capped at 100 entries)
- Tier priority prompts in setup wizard
- Clean setup command for resetting configuration

### Fixed
- Cap routing decision log entries at 100 to prevent unbounded memory growth

## [0.3.0] - 2025-03-22

### Added
- Route imported models through OpenClaw gateway
- Guided setup workflow with interactive wizard
- Setup status summary with provider/model overview
- Trusted npm publishing via GitHub Actions (no stored tokens)

### Fixed
- Setup and reload flow reliability improvements

## [0.2.0] - 2025-03-21

### Added
- npm-installable CLI packaging (`claw-auto-router` / `clawr` binaries)
- OpenAI-compatible HTTP server via Fastify
- `/v1/chat/completions`, `/v1/models`, `/health`, `/stats`, `/reload-config` endpoints
- Multi-tier routing: SIMPLE / STANDARD / COMPLEX / CODE classification
- Fallback chain execution with automatic retry on provider failure
- Provider adapters: OpenAI Completions, Anthropic Messages, Google Gemini CLI, OpenAI Codex Responses
- Auto-import of providers from OpenClaw config
- Docker and Docker Compose support

## [0.1.0] - 2025-03-20

### Added
- Initial OpenClaw-compatible model router implementation

[Unreleased]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.4.0...v0.4.1
[0.3.1]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuga-hashimoto/claw-auto-router/releases/tag/v0.1.0
