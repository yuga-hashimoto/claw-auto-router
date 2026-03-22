# claw-auto-router

A self-hosted, OpenAI-compatible LLM router for [OpenClaw](https://openclaw.ai) — automatically imports your provider/model configuration and routes each request to the best available model.

**Primary use case:** Discord → OpenClaw → claw-auto-router → best provider/model

---

## Why this exists

OpenClaw lets you configure multiple LLM providers and run agents across them. But when you want a single "smart" endpoint that automatically picks the best model for each request — without duplicating configuration — you need a router.

claw-auto-router:
- Reads your existing OpenClaw config (zero duplication)
- Exposes an OpenAI-compatible API so OpenClaw treats it like a normal provider
- Routes requests to the most suitable model based on content (tier-based heuristics + explicit assignments)
- Falls back automatically when a provider fails

---

## Architecture

```
OpenClaw (Discord bot)
    │
    │  POST /v1/chat/completions
    ▼
claw-auto-router  (this project, port 3000)
    │
    ├── Config loader      reads ~/.openclaw/moltbot.json (or openclaw.json)
    ├── Provider registry   normalizes providers/models
    ├── Routing engine     classifies request → picks best model
    ├── Fallback proxy     tries winner, then fallbacks
    │
    ├──► OpenAI-compat providers  (nvidia, zai, ...)
    ├──► Anthropic-compat providers  (kimi-coding, ...)
    └──► Any custom OpenAI-compat endpoint
```

### Routing tiers

Each request is classified into one of four tiers. claw-auto-router then picks the best model for that tier:

| Tier | Triggers | Preferred model traits |
|------|----------|------------------------|
| CODE | code fences, "implement/debug/refactor/function/class" | reasoning models, coders |
| COMPLEX | analysis keywords, messages > 2000 tokens | large context, reasoning |
| SIMPLE | short greetings, simple Q&A, < 200 tokens | fast, cheap |
| STANDARD | everything else | config order |

**Explicit tier assignments** (set via startup wizard or `router.config.json`) always override heuristics.

---

## Startup wizard

On first run, claw-auto-router prompts you to classify any model that lacks a tier assignment:

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

Assignments are saved to `router.config.json` and take effect immediately.

---

## How OpenClaw config is imported

Config discovery order:

1. `OPENCLAW_CONFIG_PATH` env var
2. `~/.openclaw/openclaw.json`
3. `~/.openclaw/moltbot.json`

From the config it extracts:
- `models.providers.*` — base URLs, API styles, model definitions
- `agents.defaults.model.primary` — top-priority model
- `agents.defaults.model.fallbacks` — fallback chain order
- `agents.defaults.models.*` — aliases

### API key resolution

| Source | Resolution |
|--------|-----------|
| Literal key in config | Used directly |
| `"xxx-oauth"` sentinel | Checks `{PROVIDER}_TOKEN` env var (e.g. `QWEN_PORTAL_TOKEN`) |
| No key in config | Checks `{PROVIDER_ID_UPPER}_API_KEY` env var |
| Not resolvable | Hidden from routing pool |

Only models with a resolved API key appear in `/v1/models` and routing.

---

## Quick start

### Local dev

```bash
# Install dependencies
pnpm install

# Copy env template
cp .env.example .env
# Edit .env if needed (add missing provider keys)

# Start dev server (prompts tier wizard on first run)
pnpm dev
```

The router starts on `http://localhost:3000` and reads your OpenClaw config automatically.

```bash
pnpm dev          # Dev server with hot reload
pnpm build        # Compile TypeScript
pnpm start        # Run compiled output
pnpm test         # Run all tests
pnpm typecheck    # Type-check
```

---

## `router.config.json`

Optional local config for claw-auto-router-specific settings (not duplicated in OpenClaw config):

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
| `modelTiers` | Explicit tier per model — overrides heuristic scoring. Set by startup wizard. |
| `tierPriority` | Preferred model order within each tier (explicit beats score) |
| `extraProviders` | Providers not in your OpenClaw config (e.g. openrouter, openai-codex) |
| `denylist` | Models to exclude from routing |

---

## API reference

### `POST /v1/chat/completions`

OpenAI-compatible chat completions.

```bash
# Auto-routing
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'

# Explicit model
curl -X POST http://localhost:3000/v1/chat/completions \
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
curl -X POST http://localhost:3000/reload-config

# With admin token:
curl -X POST http://localhost:3000/reload-config \
  -H "Authorization: Bearer your-token"
```

---

## Pointing OpenClaw at claw-auto-router

Add to your `moltbot.json` (or `openclaw.json`):

```json
{
  "models": {
    "providers": {
      "claw-auto-router": {
        "baseUrl": "http://localhost:3000",
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
| `PORT` | `3000` | HTTP port |
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

---

## Docker

```bash
# Start with docker compose
docker compose up

# Manual run (mounts your OpenClaw config read-only)
docker build -t claw-auto-router .
docker run -p 3000:3000 \
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
