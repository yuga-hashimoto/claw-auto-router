# claw-auto-router

A self-hosted, OpenAI-compatible LLM router for [OpenClaw](https://openclaw.ai) — automatically imports your provider/model configuration and routes each request to the best available model.

**Primary use case:** Discord → OpenClaw → claw-auto-router → best provider/model

---

## Why this exists

OpenClaw lets you configure multiple LLM providers and run agents across them. But when you want a single "smart" endpoint that automatically picks the best model for each request — without duplicating configuration — you need a router.

claw-auto-router:
- Reads your existing OpenClaw config (zero duplication)
- Exposes an OpenAI-compatible API so OpenClaw treats it like a normal provider
- Routes requests to the most suitable model based on content (tier-based heuristics or optional RouterAI classification + explicit assignments)
- Falls back automatically when a provider fails
- Delegates imported OpenClaw models back through the OpenClaw Gateway instead of reimplementing provider OAuth here

---

## Architecture

```
OpenClaw (Discord bot)
    │
    │  POST /v1/chat/completions
    ▼
claw-auto-router  (this project, port 43123)
    │
    ├── Config loader      reads ~/.openclaw/moltbot.json (or openclaw.json)
    ├── Provider registry   normalizes providers/models
    ├── Routing engine     classifies request → picks best model
    ├── Fallback proxy     tries winner, then fallbacks
    │
    ├──► OpenClaw Gateway  (for imported OpenClaw models, built-ins, OAuth-backed providers)
    └──► Direct provider calls  (only for explicit extraProviders in router.config.json)
```

### Routing tiers

Each request is classified into one of four tiers. By default this is done with deterministic heuristics; during `claw-auto-router setup` you can optionally enable `RouterAI`, which asks a dedicated model to choose the tier before routing. claw-auto-router then picks the best model for that tier:

| Tier | Triggers | Preferred model traits |
|------|----------|------------------------|
| CODE | code fences, "implement/debug/refactor/function/class" | reasoning models, coders |
| COMPLEX | analysis keywords, messages > 2000 tokens | large context, reasoning |
| SIMPLE | short greetings, simple Q&A, < 200 tokens | fast, cheap |
| STANDARD | everything else | config order |

**Explicit tier assignments** (set via `claw-auto-router setup` or `router.config.json`) always override automatic scoring.

Heuristics vs RouterAI:

- `Heuristic` is faster, deterministic, and adds no extra model call. This is the safest default.
- `RouterAI` can do better on ambiguous prompts, but every auto-routed request pays for one small classifier call first.
- If RouterAI fails, claw-auto-router automatically falls back to heuristics for that request.

---

## Setup wizard

During `claw-auto-router setup`, claw-auto-router prompts you to classify any model that lacks a tier assignment:

```
┌──────────────────────────────────────────────────────────────┐
│              claw-auto-router — Model Tier Setup Wizard                 │
│  Assign each model to its best routing tier.                 │
│  Press Enter or type 5 to skip (heuristics decide).          │
└──────────────────────────────────────────────────────────────┘

  Model    : Kimi for Coding
  ID       : kimi-coding/k2p5
  Context  : 256k tokens   Reasoning: yes ✓

    1) SIMPLE     Fast, cheap — quick Q&A, one-liners, lookups
    2) STANDARD   General purpose — default routing for most tasks
    3) COMPLEX    Large context, deep reasoning — analysis, long docs
    4) CODE       Code generation, debugging, refactoring, PRs
    5) Skip  — use auto-heuristics

  Choice [1-5, Enter=skip]: 4
  ✓ Assigned to CODE
```

Assignments are saved to `~/.openclaw/router.config.json` by default (or next to the config file you target with `--config`) and take effect immediately.

The setup wizard also asks whether you want to keep deterministic heuristics or enable RouterAI, and if you choose RouterAI it lets you pick the classifier model to use.

---

## How OpenClaw config is imported

Config discovery order:

1. `OPENCLAW_CONFIG_PATH` env var
2. `~/.openclaw/openclaw.json`
3. `~/.openclaw/moltbot.json`

From the config it extracts:
- `models.providers.*` — base URLs, API styles, model definitions
- OpenClaw agent `models.json` / `models list --json` — implicit configured providers and models such as OpenRouter, GitHub Copilot, OpenAI Codex, MiniMax Portal, and Google Antigravity
- `agents.defaults.model.primary` — top-priority model
- `agents.defaults.model.fallbacks` — fallback chain order
- `agents.defaults.models.*` — aliases

Execution path:
- Providers imported from OpenClaw run back through the OpenClaw Gateway with a provider/model override
- This means built-in and OAuth-backed providers like OpenRouter, GitHub Copilot, OpenAI Codex, MiniMax Portal, Qwen Portal, and Google Antigravity stay on OpenClaw's auth/runtime path
- `extraProviders` in `router.config.json` are still called directly by claw-auto-router

Supported direct transports for `extraProviders` are:
- `openai-completions`
- `anthropic-messages`
- `openai-codex-responses`
- `google-gemini-cli`

### API key resolution

| Source | Resolution |
|--------|-----------|
| Literal key in config | Used directly |
| `"xxx-oauth"` sentinel | Checks `{PROVIDER}_TOKEN` env var (e.g. `QWEN_PORTAL_TOKEN`) |
| No key in config | Checks `{PROVIDER_ID_UPPER}_API_KEY` env var |
| Not resolvable | Hidden from routing pool |

Visibility rules:
- OpenClaw-backed models appear in `/v1/models` when the OpenClaw Gateway is reachable
- Direct `extraProviders` appear when claw-auto-router can resolve their local API key or token
- If the Gateway is down, imported OpenClaw models are hidden until it comes back

Current caveats for OpenClaw-backed execution:
- Streaming is synthesized from the final Gateway result today, so imported models do not token-stream incrementally yet
- Image inputs for Gateway-backed requests currently support `data:image/...;base64,...` URLs from the latest user turn

---

## Quick start

Pick the path that matches your setup:

- Use `npm` if you already have Node.js 20+
- Use Docker if you do not want to install Node.js

### Easiest install: npm

If you already use Node.js, the best install UX is a single npm command.

#### Install from npm

```bash
npm install -g claw-auto-router
claw-auto-router setup
```

Make sure your OpenClaw Gateway is running before you expect imported models to route:

```bash
openclaw gateway status
```

`claw-auto-router setup` automatically:

- detects your active OpenClaw config via `openclaw config file`
- imports the current OpenClaw model catalog, including built-in configured providers like OpenRouter, GitHub Copilot, OpenAI Codex, MiniMax Portal, and Google Antigravity
- asks you to assign tiers to your current models
- shows the current order inside each tier and lets you save explicit priority overrides
- asks whether routing decisions should stay heuristic or use RouterAI, and lets you pick the classifier model
- writes `~/.openclaw/router.config.json`
- updates your OpenClaw config to point `claw-auto-router/auto` at the local router
- on macOS, installs and starts a `launchd` background service automatically

If you want to throw away previous claw-auto-router tier assignments and rebuild them from scratch, use:

```bash
claw-auto-router clean-setup
```

It also installs a short alias:

```bash
clawr
```

Useful examples:

```bash
# Use an explicit OpenClaw config path
claw-auto-router setup --config ~/.openclaw/moltbot.json

# Rebuild existing claw-auto-router setup from scratch
claw-auto-router clean-setup

# Use a custom router port during setup
claw-auto-router setup --port 3001

# Check the background service on macOS
claw-auto-router service status

# Start or restart the background service manually
claw-auto-router service start
claw-auto-router service restart
```

See recent routing decisions and why they were chosen:

```bash
claw-auto-router logs --limit 20
claw-auto-router logs --json
```

Background service management on macOS:

```bash
claw-auto-router service install
claw-auto-router service status
claw-auto-router service stop
claw-auto-router service uninstall
```

If you want the latest unreleased version straight from GitHub instead:

```bash
npm install -g github:yuga-hashimoto/claw-auto-router
claw-auto-router setup
claw-auto-router
```

### Release automation

npm publishing is handled by GitHub Actions trusted publishing in
[`publish.yml`](./.github/workflows/publish.yml).

- Bump the `version` in `package.json`
- Register `yuga-hashimoto/claw-auto-router` + `.github/workflows/publish.yml` once as an npm trusted publisher
- Push to `main` or run the workflow manually from GitHub Actions
- The workflow runs `pnpm typecheck`, `pnpm test`, and `pnpm build`
- If that version is not already on npm, it publishes automatically without an npm token
- The same workflow also creates a `vX.Y.Z` Git tag and GitHub Release with generated release notes

### No-Node install: Docker Compose

If you want clawr running without installing Node.js locally, use Docker.

#### What you need

- Docker Desktop or Docker Engine + Docker Compose
- Your OpenClaw config at `~/.openclaw/openclaw.json` or `~/.openclaw/moltbot.json`
- Provider API keys only if they are **not** already stored in your OpenClaw config

#### 1. Clone and start

```bash
git clone https://github.com/yuga-hashimoto/claw-auto-router.git
cd claw-auto-router
cp .env.example .env
docker compose up --build -d
```

`docker-compose.yml` mounts `~/.openclaw` read-only and now loads values from your local `.env` file automatically.

#### 2. Add keys only if needed

Open `.env` and fill in only the provider keys that are missing from your OpenClaw config:

```bash
ZAI_API_KEY=
KIMI_CODING_API_KEY=
GOOGLE_API_KEY=
OPENROUTER_API_KEY=
NVIDIA_API_KEY=
QWEN_PORTAL_TOKEN=
```

Then restart:

```bash
docker compose restart
```

#### 3. Verify it is up

```bash
curl http://localhost:43123/health
curl http://localhost:43123/v1/models
```

If `/v1/models` returns an empty list:
- start or fix the OpenClaw Gateway for imported models
- or add local env vars for any direct `extraProviders`

### Local install: Node.js + pnpm

Use this if you want local development, hot reload, or to modify the code.

#### What you need

- Node.js 20+
- pnpm
- Your OpenClaw config at `~/.openclaw/openclaw.json` or `~/.openclaw/moltbot.json`

```bash
# Install dependencies
pnpm install

# Build the CLI once
pnpm build

# Run one-time setup against your OpenClaw config
pnpm start -- setup

# Or run the server directly during development
pnpm dev
```

The router starts on `http://localhost:43123` and reads your OpenClaw config automatically. On macOS, `setup` also installs a `launchd` agent so the router can keep running in the background after setup.

For a production-style local run:

```bash
pnpm install
pnpm start -- setup
pnpm build
pnpm start
```

```bash
pnpm dev          # Dev server with hot reload
pnpm build        # Compile TypeScript
pnpm start        # Run compiled output
pnpm test         # Run all tests
pnpm typecheck    # Type-check
```

---

## `router.config.json`

Optional claw-auto-router-specific settings.

Default path:

- `~/.openclaw/router.config.json`
- If you run `claw-auto-router setup --config /path/to/openclaw.json`, it writes `/path/to/router.config.json`

Example:

```json
{
  "modelTiers": {
    "kimi-coding/k2p5": "CODE",
    "nvidia/qwen/qwen3.5-397b-a17b": "COMPLEX",
    "google/gemini-flash": "SIMPLE"
  },
  "tierPriority": {
    "CODE": ["kimi-coding/k2p5", "nvidia/qwen/qwen3.5-397b-a17b"],
    "SIMPLE": ["google/gemini-flash"]
  },
  "routerAI": {
    "mode": "ai",
    "model": "google/gemini-3-flash-preview",
    "timeoutMs": 8000
  },
  "extraProviders": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "models": [{ "id": "auto", "name": "OpenRouter Auto" }]
    }
  },
  "denylist": ["some-provider/bad-model"]
}
```

| Field | Description |
|-------|-------------|
| `modelTiers` | Explicit tier per model — overrides heuristic scoring. Set by setup wizard. |
| `tierPriority` | Preferred model order within each tier (explicit beats score). Setup wizard can write this too. |
| `routerAI` | Optional AI classifier for tier decisions. If it fails, routing falls back to heuristics automatically. |
| `extraProviders` | Providers not in your OpenClaw config (e.g. openrouter, openai-codex, google-gemini-cli) |
| `denylist` | Models to exclude from routing |

`claw-auto-router setup` also writes `openClawIntegration` metadata here so the router can remember your original OpenClaw primary/fallback chain without routing to itself.

---

## API reference

### `POST /v1/chat/completions`

OpenAI-compatible chat completions.

```bash
# Auto-routing
curl -X POST http://localhost:43123/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'

# Explicit model
curl -X POST http://localhost:43123/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nvidia/qwen/qwen3.5-397b-a17b","messages":[{"role":"user","content":"Explain neural networks"}]}'
```

### `GET /v1/models`

Returns all models with resolved API keys.

### `GET /health`

Liveness check with model counts.

### `GET /stats`

Routing stats: requests, per-model counts, fallback rate, average latency, config status.

### `POST /reload-config`

Reload OpenClaw config without restart. Atomically replaces the routing pool.

```bash
curl -X POST http://localhost:43123/reload-config

# With admin token:
curl -X POST http://localhost:43123/reload-config \
  -H "Authorization: Bearer your-token"
```

---

## Pointing OpenClaw at claw-auto-router

If you use `claw-auto-router setup`, you do **not** need to edit OpenClaw manually.

Add to your `moltbot.json` (or `openclaw.json`):

```json
{
  "models": {
    "providers": {
      "claw-auto-router": {
        "baseUrl": "http://localhost:43123",
        "apiKey": "any-value",
        "api": "openai-completions",
        "models": [
          {
            "id": "auto",
            "name": "Auto Router",
            "api": "openai-completions",
            "contextWindow": 262144,
            "maxTokens": 32768
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "claw-auto-router/auto"
      }
    }
  }
}
```

Set your agent model to `claw-auto-router/auto`. OpenClaw sends chat completions to claw-auto-router, which routes to the actual best model internally.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `43123` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `trace\|debug\|info\|warn\|error` |
| `OPENCLAW_CONFIG_PATH` | auto-detect | Override config path |
| `ROUTER_REQUEST_TIMEOUT_MS` | `30000` | Per-provider timeout (ms) |
| `ROUTER_ADMIN_TOKEN` | _(none)_ | Token for `/reload-config` |
| `ZAI_API_KEY` | _(none)_ | zai provider key |
| `KIMI_CODING_API_KEY` | _(none)_ | kimi-coding provider key |
| `GOOGLE_API_KEY` | _(none)_ | Google provider key |
| `OPENROUTER_API_KEY` | _(none)_ | OpenRouter key |
| `NVIDIA_API_KEY` | _(none)_ | NVIDIA key (if not in config) |
| `QWEN_PORTAL_TOKEN` | _(none)_ | qwen-portal OAuth token |
| `OPENAI_CODEX_TOKEN` | _(none)_ | Override token for openai-codex |

---

## Docker

```bash
# Start with docker compose
docker compose up

# Manual run (mounts your OpenClaw config read-only)
docker build -t claw-auto-router .
docker run -p 43123:43123 \
  -v ~/.openclaw:/root/.openclaw:ro \
  -e ZAI_API_KEY=your-key \
  claw-auto-router
```

---

## Troubleshooting

**"No resolvable candidates"**
→ All models have missing keys. Check `GET /stats` → `configStatus.warnings`. Set `{PROVIDER}_API_KEY` env vars.

**Provider in fallbacks but not in routing pool**
→ Phantom ref — add it to `router.config.json` under `extraProviders`.

**"env_missing" but key is set**
→ Check the exact name: `{PROVIDER_ID_UPPERCASE_WITH_UNDERSCORES}_API_KEY`. Example: `kimi-coding` → `KIMI_CODING_API_KEY`.

**502 All providers failed**
→ All providers returned errors. Check `GET /stats` for per-model failure counts and server logs for specific HTTP errors.

**Wizard doesn't appear**
→ claw-auto-router only runs the wizard when stdin/stdout are TTYs. In Docker or CI, set `modelTiers` in `router.config.json` manually.
