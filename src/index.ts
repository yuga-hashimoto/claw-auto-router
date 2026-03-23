#!/usr/bin/env node

import { basename } from 'node:path'
import { getHelpText, parseCliArgs } from './cli.js'
import { loadOpenClawConfig } from './config/loader.js'
import { loadRouterConfig, resolveRouterConfigPath } from './config/router-config.js'
import type { RouterConfig } from './config/router-config.js'
import { readDecisionLogEntries, renderDecisionLogEntries } from './decision-log.js'
import { DEFAULT_PORT } from './defaults.js'
import {
  augmentConfigWithOpenClawDiscovery,
  filterUnsupportedProviderWarnings,
  resolveGatewayBackedProviderIds,
} from './openclaw/discovery.js'
import { resolveOpenClawGatewayContext, type OpenClawGatewayContext } from './openclaw/gateway.js'
import { normalizeConfig } from './providers/normalizer.js'
import { isModelAvailable } from './providers/types.js'
import { ProviderRegistry } from './providers/registry.js'
import { buildApp } from './server/app.js'
import {
  getBackgroundServiceStatus,
  installBackgroundService,
  restartBackgroundService,
  startBackgroundService,
  stopBackgroundService,
  uninstallBackgroundService,
  type BackgroundServiceStatus,
} from './service/launchd.js'
import { runSetup } from './setup/command.js'
import { runTierWizard } from './wizard/setup.js'
import { getEnv, getEnvOrDefault, getEnvInt } from './utils/env.js'

function formatTierSummary(tierCounts: Record<'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'CODE', number>): string {
  return `SIMPLE ${tierCounts.SIMPLE}, STANDARD ${tierCounts.STANDARD}, COMPLEX ${tierCounts.COMPLEX}, CODE ${tierCounts.CODE}`
}

function formatPrioritySummary(priorityCounts: Record<'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'CODE', number>): string {
  return `SIMPLE ${priorityCounts.SIMPLE}, STANDARD ${priorityCounts.STANDARD}, COMPLEX ${priorityCounts.COMPLEX}, CODE ${priorityCounts.CODE}`
}

function printBackgroundServiceStatus(status: BackgroundServiceStatus): void {
  console.log('[claw-auto-router] Background service')
  console.log(`  Manager           : ${status.supported ? 'launchd (macOS)' : 'unsupported'}`)
  console.log(`  Label             : ${status.label}`)
  console.log(`  LaunchAgent       : ${status.plistPath}`)
  console.log(`  Installed         : ${status.installed ? 'yes' : 'no'}`)
  console.log(`  Loaded            : ${status.loaded ? 'yes' : 'no'}`)
  console.log(`  Running           : ${status.running ? 'yes' : 'no'}`)
  if (status.pid !== undefined) {
    console.log(`  PID               : ${status.pid}`)
  }
  if (status.command !== undefined) {
    console.log(`  Command           : ${status.command}`)
  }
  console.log(`  Stdout log        : ${status.stdoutPath}`)
  console.log(`  Stderr log        : ${status.stderrPath}`)
  if (status.action !== undefined) {
    console.log(`  Action            : ${status.action}`)
  }
  if (status.detail !== undefined) {
    console.log(`  Detail            : ${status.detail}`)
  }
  if (status.error !== undefined) {
    console.log(`  Error             : ${status.error}`)
  }
}

function printSetupSummary(result: Awaited<ReturnType<typeof runSetup>>): void {
  console.log('[claw-auto-router] Setup summary')
  if (result.mode === 'clean-setup') {
    console.log('[claw-auto-router] Mode')
    console.log('  clean-setup      : existing claw-auto-router setup was rebuilt from scratch')
  }
  console.log('[claw-auto-router] OpenClaw integration')
  console.log(`  Config path       : ${result.openClawConfigPath}`)
  console.log(`  Router model      : ${result.routerRef}`)
  console.log(`  Provider action   : ${result.openClawChanges.providerAction}`)
  console.log(
    `  Primary model     : ${result.openClawChanges.primaryBefore ?? '(unset)'} -> ${result.openClawChanges.primaryAfter}`,
  )
  console.log(
    `  Fallbacks         : ${result.openClawChanges.fallbacksBefore.length} -> ${result.openClawChanges.fallbacksAfter.length}`,
  )
  if (result.openClawObservedState !== undefined) {
    console.log(
      `  OpenClaw sees     : ${result.openClawObservedState.resolvedDefault ?? result.openClawObservedState.defaultModel ?? '(unknown)'}`,
    )
  }

  console.log('[claw-auto-router] Router configuration')
  console.log(`  Router config     : ${result.routerConfigPath}`)
  console.log(`  Base URL          : ${result.routerBaseUrl}`)
  console.log(`  Tier assignments  : ${result.routerConfigSummary.totalAssigned}`)
  console.log(`  Tier breakdown    : ${formatTierSummary(result.routerConfigSummary.tierCounts)}`)
  console.log(`  Priority rules    : ${formatPrioritySummary(result.routerConfigSummary.priorityCounts)}`)
  console.log(
    `  Routing mode      : ${
      result.routerConfigSummary.classificationMode === 'ai' ? 'RouterAI classifier' : 'Deterministic heuristics'
    }`,
  )
  if (result.routerConfigSummary.routerAIModel !== undefined) {
    console.log(`  RouterAI model    : ${result.routerConfigSummary.routerAIModel}`)
  }

  console.log('[claw-auto-router] Router runtime')
  console.log(`  Running now       : ${result.routerRuntime.running ? 'yes' : 'no'}`)
  console.log(`  Health endpoint   : ${result.routerRuntime.healthUrl}`)
  console.log(`  Models endpoint   : ${result.routerRuntime.modelsUrl}`)
  if (result.routerRuntime.running) {
    console.log(
      `  Health check      : ${result.routerRuntime.healthStatus ?? 'ok'} ` +
        `(${result.routerRuntime.totalModels ?? 0} models, ${result.routerRuntime.resolvableModels ?? 0} executable)`,
    )
  } else {
    console.log(`  Health check      : ${result.routerRuntime.error ?? 'not reachable'}`)
  }

  if (result.backgroundService !== undefined) {
    printBackgroundServiceStatus(result.backgroundService)
  }

  if (result.backupPath !== undefined) {
    console.log(`[claw-auto-router] Backup created : ${result.backupPath}`)
  }
  if (result.inferredUpstreamFromFallbacks) {
    console.log(
      '[claw-auto-router] Note: OpenClaw already pointed at the router, so the upstream primary was inferred from the first non-router fallback.',
    )
  }

  console.log('[claw-auto-router] How to test')
  if (!result.routerRuntime.running && result.backgroundService?.supported !== true) {
    console.log(`  Start router      : ${result.suggestedStartCommand}`)
  }
  if (result.backgroundService?.supported === true) {
    console.log('  Service status    : claw-auto-router service status')
    if (!result.backgroundService.running) {
      console.log('  Service start     : claw-auto-router service start')
    }
  }
  console.log(`  Health check      : curl ${result.routerRuntime.healthUrl}`)
  console.log(`  Model list        : curl ${result.routerRuntime.modelsUrl}`)
  console.log('  Decision logs     : claw-auto-router logs --limit 20')
  console.log(`  OpenClaw check    : openclaw models status --json`)
}

function getCommandName(): string {
  const invoked = basename(process.argv[1] ?? '')
  if (invoked === '' || invoked === 'index.js') {
    return 'claw-auto-router'
  }

  return invoked
}

function getRouterSelfRef(routerConfig: RouterConfig): string | undefined {
  const integration = routerConfig.openClawIntegration
  if (integration === undefined) {
    return undefined
  }

  return `${integration.providerId}/${integration.modelId}`
}

async function isRouterResponding(port: number): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
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
  const port = cli.port ?? getEnvInt('PORT', DEFAULT_PORT)
  const host = cli.host ?? getEnvOrDefault('HOST', '0.0.0.0')
  const logLevel = cli.logLevel ?? getEnvOrDefault('LOG_LEVEL', 'info')
  const adminToken = cli.adminToken ?? getEnv('ROUTER_ADMIN_TOKEN')
  const requestTimeoutMs = cli.requestTimeoutMs ?? getEnvInt('ROUTER_REQUEST_TIMEOUT_MS', 30_000)

  if (cli.command === 'logs') {
    const entries = readDecisionLogEntries(cli.limit ?? 20, configPath)
    if (cli.json) {
      console.log(JSON.stringify(entries, null, 2))
    } else {
      console.log(renderDecisionLogEntries(entries))
    }
    return
  }

  if (cli.command === 'service') {
    const serviceOptions = {
      ...(configPath !== undefined ? { configPath } : {}),
      ...(routerConfigPath !== undefined ? { routerConfigPath } : {}),
      port,
      host,
      logLevel,
      ...(adminToken !== undefined ? { adminToken } : {}),
      requestTimeoutMs,
    }

    const status =
      cli.serviceAction === 'install'
        ? installBackgroundService({
            ...serviceOptions,
            startMode: (await isRouterResponding(port)) ? 'never' : 'always',
          })
        : cli.serviceAction === 'start'
          ? startBackgroundService()
          : cli.serviceAction === 'stop'
            ? stopBackgroundService()
            : cli.serviceAction === 'restart'
              ? restartBackgroundService()
              : cli.serviceAction === 'uninstall'
                ? uninstallBackgroundService()
                : getBackgroundServiceStatus()

    printBackgroundServiceStatus(status)
    return
  }

  if (cli.command === 'setup' || cli.command === 'clean-setup') {
    const setupOptions: Parameters<typeof runSetup>[0] = {
      port,
      host,
      logLevel,
      ...(adminToken !== undefined ? { adminToken } : {}),
      requestTimeoutMs,
    }
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
    if (cli.command === 'clean-setup') {
      setupOptions.resetExisting = true
    }

    const result = await runSetup(setupOptions)
    printSetupSummary(result)
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
  let gatewayContext: OpenClawGatewayContext | undefined

  if (!outcome.ok) {
    console.warn(`[claw-auto-router] WARNING: ${outcome.error}`)
    console.warn('[claw-auto-router] Starting with no providers. Use POST /reload-config to load.')
    registry = new ProviderRegistry([])
  } else {
    gatewayContext = resolveOpenClawGatewayContext(outcome.path)
    const {
      config: discoveredConfig,
      warnings: discoveryWarnings,
    } = augmentConfigWithOpenClawDiscovery(outcome.config, outcome.path)
    const gatewayBackedProviderIds = resolveGatewayBackedProviderIds(outcome.config, discoveredConfig)
    const { providers, models, warnings } = normalizeConfig(discoveredConfig, routerConfig, {
      gatewayBackedProviderIds,
      gatewayAvailable: gatewayContext.available,
    })
    const routerSelfRef = getRouterSelfRef(routerConfig)
    const visibleWarnings = filterUnsupportedProviderWarnings(warnings, discoveryWarnings).filter(
      (warning) => routerSelfRef === undefined || !warning.startsWith(`Phantom ref "${routerSelfRef}"`),
    )

    for (const w of gatewayBackedProviderIds.length > 0 ? gatewayContext.warnings : []) {
      console.warn(`[claw-auto-router] ${w}`)
    }
    for (const w of discoveryWarnings) {
      console.warn(`[claw-auto-router] ${w}`)
    }
    for (const w of visibleWarnings) {
      console.warn(`[claw-auto-router] ${w}`)
    }

    const resolvable = models.filter((m) => isModelAvailable(m))
    console.info(`[claw-auto-router] Loaded config from: ${outcome.path}`)
    console.info(
      `[claw-auto-router] Providers: ${providers.length}, Models: ${models.length}, Resolvable: ${resolvable.length}`,
    )

    if (resolvable.length === 0) {
      console.warn(
        '[claw-auto-router] WARNING: No executable models are currently available. ' +
          'Start the OpenClaw Gateway or set direct-provider env vars, then reload the router config.',
      )
    }

    // Run interactive tier wizard for models that lack explicit tier assignments
    const existingTiers = routerConfig.modelTiers ?? {}
    const updatedTiers = await runTierWizard(
      resolvable,
      existingTiers,
      resolvedRouterConfigPath,
      { interactive: false },
    )
    if (updatedTiers !== existingTiers) {
      // Wizard assigned new tiers — reload routerConfig so changes take effect
      routerConfig = loadRouterConfig(resolvedRouterConfigPath, outcome.path)
    }

    rawConfig = discoveredConfig
    registry = new ProviderRegistry(models)
  }

  const app = buildApp({
    config: rawConfig,
    registry,
    ...(outcome.ok ? { configPath: outcome.path } : configPath !== undefined ? { configPath } : {}),
    routerConfigPath: resolvedRouterConfigPath,
    routerConfig,
    gatewayContext,
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
