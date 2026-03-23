# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yuga-hashimoto/claw-auto-router/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yuga-hashimoto/claw-auto-router/releases/tag/v0.1.0
