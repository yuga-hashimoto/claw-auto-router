# Contributing to claw-auto-router

Thank you for your interest in contributing! This document covers everything you need to get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

---

## Development Setup

**Requirements:**
- Node.js >= 20.0.0
- [pnpm](https://pnpm.io/) >= 10

```bash
# Clone the repo
git clone https://github.com/yuga-hashimoto/claw-auto-router.git
cd claw-auto-router

# Install dependencies
pnpm install

# Run in dev mode (watch)
pnpm dev

# Type-check
pnpm typecheck

# Lint
pnpm lint

# Run tests
pnpm test

# Build
pnpm build
```

---

## Project Structure

```
src/
├── adapters/     # Protocol adapters (OpenAI, Anthropic, Gemini, ...)
├── config/       # Config schema and loader
├── openclaw/     # OpenClaw gateway discovery & execution
├── providers/    # Provider registry and normalization
├── proxy/        # Request execution and fallback logic
├── router/       # Routing algorithm (classifier, scorer, chain-builder)
├── server/       # Fastify HTTP server and routes
├── setup/        # Setup wizard CLI command
├── stats/        # Request statistics
├── utils/        # Shared utilities
├── wizard/       # Interactive tier-assignment wizard
├── cli.ts        # CLI entry point
└── index.ts      # Main entry point
```

---

## Coding Standards

- **TypeScript strict mode** — all strict flags are enabled; no `any` unless unavoidable
- **Immutability** — create new objects instead of mutating existing ones
- **Small files** — aim for < 400 lines per file; extract utilities when files grow
- **Error handling** — handle errors explicitly; never silently swallow them
- **No hardcoded secrets** — use environment variables; never commit `.env` files
- **Conventional commits** — commit messages must follow the format:

  ```
  <type>: <description>

  Types: feat | fix | refactor | docs | test | chore | perf | ci
  ```

---

## Testing

All PRs must maintain or improve test coverage. We use [vitest](https://vitest.dev/).

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# With coverage report
pnpm test:coverage
```

**Requirements:**
- New features must include unit tests
- Bug fixes must include a regression test
- Integration tests for new API routes
- Coverage target: 80%+

---

## Submitting Changes

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```

2. **Make your changes** following the coding standards above

3. **Run the full check suite** before opening a PR:
   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   ```

4. **Open a Pull Request** against `main` with:
   - A clear title following conventional commits format
   - Description of what changed and why
   - Reference to any related issues (`Closes #123`)

5. A maintainer will review your PR. Please be responsive to feedback.

---

## Reporting Issues

Use the [GitHub Issues](https://github.com/yuga-hashimoto/claw-auto-router/issues) page. Please use the provided templates:

- **Bug report** — for unexpected behavior
- **Feature request** — for new functionality

For **security vulnerabilities**, see [SECURITY.md](./SECURITY.md).
