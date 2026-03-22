import { loadOpenClawConfig } from './config/loader.js'
import { loadRouterConfig, DEFAULT_ROUTER_CONFIG_PATH } from './config/router-config.js'
import type { RouterConfig } from './config/router-config.js'
import { normalizeConfig } from './providers/normalizer.js'
import { ProviderRegistry } from './providers/registry.js'
import { buildApp } from './server/app.js'
import { runTierWizard } from './wizard/setup.js'
import { getEnv, getEnvOrDefault, getEnvInt } from './utils/env.js'

async function main(): Promise<void> {
  const configPath = getEnv('OPENCLAW_CONFIG_PATH')
  const port = getEnvInt('PORT', 3000)
  const host = getEnvOrDefault('HOST', '0.0.0.0')
  const logLevel = getEnvOrDefault('LOG_LEVEL', 'info')
  const adminToken = getEnv('ROUTER_ADMIN_TOKEN')
  const requestTimeoutMs = getEnvInt('ROUTER_REQUEST_TIMEOUT_MS', 30_000)

  // Load router.config.json (extra providers, denylist, tier assignments, etc.)
  let routerConfig: RouterConfig = loadRouterConfig()

  // Load and parse OpenClaw config
  const outcome = loadOpenClawConfig(configPath)

  let registry: ProviderRegistry
  let rawConfig = outcome.ok ? outcome.config : {}

  if (!outcome.ok) {
    console.warn(`[claw-auto-router] WARNING: ${outcome.error}`)
    console.warn('[claw-auto-router] Starting with no providers. Use POST /reload-config to load.')
    registry = new ProviderRegistry([])
  } else {
    const { providers, models, warnings } = normalizeConfig(outcome.config, routerConfig)

    for (const w of warnings) {
      console.warn(`[claw-auto-router] ${w}`)
    }

    const resolvable = models.filter((m) => m.apiKeyResolution.status === 'resolved')
    console.info(`[claw-auto-router] Loaded config from: ${outcome.path}`)
    console.info(
      `[claw-auto-router] Providers: ${providers.length}, Models: ${models.length}, Resolvable: ${resolvable.length}`,
    )

    if (resolvable.length === 0) {
      console.warn(
        '[claw-auto-router] WARNING: No models with resolved API keys. ' +
          'Set provider env vars or add tokens for OAuth providers.',
      )
    }

    // Run interactive tier wizard for models that lack explicit tier assignments
    const existingTiers = routerConfig.modelTiers ?? {}
    const updatedTiers = await runTierWizard(resolvable, existingTiers, DEFAULT_ROUTER_CONFIG_PATH)
    if (updatedTiers !== existingTiers) {
      // Wizard assigned new tiers — reload routerConfig so changes take effect
      routerConfig = loadRouterConfig()
    }

    registry = new ProviderRegistry(models)
  }

  const app = buildApp({
    config: rawConfig,
    registry,
    routerConfig,
    logLevel,
    adminToken,
    requestTimeoutMs,
  })

  try {
    await app.listen({ port, host })
  } catch (err) {
    app.log.error(err, 'Failed to start server')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
