#!/usr/bin/env node

import { basename } from 'node:path'
import { getHelpText, parseCliArgs } from './cli.js'
import { loadOpenClawConfig } from './config/loader.js'
import { loadRouterConfig, resolveRouterConfigPath } from './config/router-config.js'
import type { RouterConfig } from './config/router-config.js'
import { normalizeConfig } from './providers/normalizer.js'
import { ProviderRegistry } from './providers/registry.js'
import { buildApp } from './server/app.js'
import { runSetup } from './setup/command.js'
import { runTierWizard } from './wizard/setup.js'
import { getEnv, getEnvOrDefault, getEnvInt } from './utils/env.js'

function getCommandName(): string {
  const invoked = basename(process.argv[1] ?? '')
  if (invoked === '' || invoked === 'index.js') {
    return 'claw-auto-router'
  }

  return invoked
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2))
  const commandName = getCommandName()

  if (cli.help) {
    console.log(getHelpText(commandName))
    return
  }

  const configPath = cli.configPath ?? getEnv('OPENCLAW_CONFIG_PATH')
  const routerConfigPath = cli.routerConfigPath
  const port = cli.port ?? getEnvInt('PORT', 3000)
  const host = cli.host ?? getEnvOrDefault('HOST', '0.0.0.0')
  const logLevel = cli.logLevel ?? getEnvOrDefault('LOG_LEVEL', 'info')
  const adminToken = cli.adminToken ?? getEnv('ROUTER_ADMIN_TOKEN')
  const requestTimeoutMs = cli.requestTimeoutMs ?? getEnvInt('ROUTER_REQUEST_TIMEOUT_MS', 30_000)

  if (cli.command === 'setup') {
    const setupOptions: Parameters<typeof runSetup>[0] = { port }
    if (configPath !== undefined) {
      setupOptions.configPath = configPath
    }
    if (routerConfigPath !== undefined) {
      setupOptions.routerConfigPath = routerConfigPath
    }
    if (cli.baseUrl !== undefined) {
      setupOptions.baseUrl = cli.baseUrl
    }
    if (cli.providerId !== undefined) {
      setupOptions.providerId = cli.providerId
    }
    if (cli.modelId !== undefined) {
      setupOptions.modelId = cli.modelId
    }

    const result = await runSetup(setupOptions)

    console.log(`[claw-auto-router] OpenClaw config: ${result.openClawConfigPath}`)
    console.log(`[claw-auto-router] Router config  : ${result.routerConfigPath}`)
    console.log(`[claw-auto-router] OpenClaw model : ${result.routerRef}`)
    if (result.backupPath !== undefined) {
      console.log(`[claw-auto-router] Backup created : ${result.backupPath}`)
    }
    if (result.inferredUpstreamFromFallbacks) {
      console.log(
        '[claw-auto-router] Note: OpenClaw already pointed at the router, so the upstream primary was inferred from the first non-router fallback.',
      )
    }
    console.log('[claw-auto-router] Setup complete. Start the router with:')
    console.log(`  ${commandName}`)
    return
  }

  // Load and parse OpenClaw config
  const outcome = loadOpenClawConfig(configPath)
  const resolvedRouterConfigPath = resolveRouterConfigPath(
    routerConfigPath,
    outcome.ok ? outcome.path : configPath,
  )

  // Load router.config.json (extra providers, denylist, tier assignments, etc.)
  let routerConfig: RouterConfig = loadRouterConfig(resolvedRouterConfigPath, outcome.ok ? outcome.path : configPath)

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
    const updatedTiers = await runTierWizard(
      resolvable,
      existingTiers,
      resolvedRouterConfigPath,
    )
    if (updatedTiers !== existingTiers) {
      // Wizard assigned new tiers — reload routerConfig so changes take effect
      routerConfig = loadRouterConfig(resolvedRouterConfigPath, outcome.path)
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
  if (err instanceof Error) {
    console.error(`[claw-auto-router] ${err.message}`)
  } else {
    console.error('Fatal error:', err)
  }
  console.error(getHelpText(getCommandName()))
  process.exit(1)
})
