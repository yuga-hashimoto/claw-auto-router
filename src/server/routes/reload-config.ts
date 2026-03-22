import type { FastifyInstance } from 'fastify'
import type { StatsCollector } from '../../stats/collector.js'
import type { RouterConfig } from '../../config/router-config.js'
import { loadOpenClawConfig } from '../../config/loader.js'
import { loadRouterConfig, resolveRouterConfigPath } from '../../config/router-config.js'
import {
  augmentConfigWithOpenClawDiscovery,
  filterUnsupportedProviderWarnings,
  resolveGatewayBackedProviderIds,
} from '../../openclaw/discovery.js'
import { resolveOpenClawGatewayContext, type OpenClawGatewayContext } from '../../openclaw/gateway.js'
import { normalizeConfig } from '../../providers/normalizer.js'
import { ProviderRegistry } from '../../providers/registry.js'
import { getEnv } from '../../utils/env.js'
import type { RawConfig } from '../../config/schema.js'

interface ReloadState {
  config: RawConfig
  registry: ProviderRegistry
  configPath: string | undefined
  routerConfigPath: string | undefined
  routerConfig: RouterConfig
  gatewayContext: OpenClawGatewayContext | undefined
}

export function registerReloadRoute(
  app: FastifyInstance,
  state: ReloadState,
  stats: StatsCollector,
  adminToken?: string | undefined,
): void {
  app.post('/reload-config', async (request, reply) => {
    // Optional admin token guard
    if (adminToken !== undefined) {
      const authHeader = request.headers.authorization ?? ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (token !== adminToken) {
        return reply.status(401).send({ error: 'Unauthorized' })
      }
    }

    const configPath = state.configPath ?? getEnv('OPENCLAW_CONFIG_PATH')
    const outcome = loadOpenClawConfig(configPath)

    if (!outcome.ok) {
      app.log.warn({ error: outcome.error }, 'Config reload failed')
      stats.setConfigStatus({
        loaded: false,
        warnings: [outcome.error],
        lastReloadAt: new Date().toISOString(),
      })
      return reply.status(500).send({
        ok: false,
        error: outcome.error,
        triedPaths: outcome.triedPaths,
      })
    }

    // Also reload router.config.json
    const routerConfigPath = resolveRouterConfigPath(state.routerConfigPath, outcome.path)
    const newRouterConfig = loadRouterConfig(routerConfigPath, outcome.path)
    const gatewayContext = resolveOpenClawGatewayContext(outcome.path)
    const {
      config: discoveredConfig,
      warnings: discoveryWarnings,
    } = augmentConfigWithOpenClawDiscovery(outcome.config, outcome.path)
    const gatewayBackedProviderIds = resolveGatewayBackedProviderIds(outcome.config, discoveredConfig)
    const { providers, models, warnings } = normalizeConfig(discoveredConfig, newRouterConfig, {
      gatewayBackedProviderIds,
      gatewayAvailable: gatewayContext.available,
    })
    const visibleWarnings = filterUnsupportedProviderWarnings(warnings, discoveryWarnings)

    for (const w of gatewayBackedProviderIds.length > 0 ? gatewayContext.warnings : []) {
      app.log.warn(w)
    }
    for (const w of discoveryWarnings) {
      app.log.warn(w)
    }
    for (const w of visibleWarnings) {
      app.log.warn(w)
    }

    // Atomically replace all mutable state
    state.config = discoveredConfig
    state.registry = new ProviderRegistry(models)
    state.configPath = outcome.path
    state.routerConfigPath = routerConfigPath
    state.routerConfig = newRouterConfig
    state.gatewayContext = gatewayContext

    stats.setConfigStatus({
      loaded: true,
      path: outcome.path,
      warnings: [
        ...(gatewayBackedProviderIds.length > 0 ? gatewayContext.warnings : []),
        ...discoveryWarnings,
        ...visibleWarnings,
      ],
      lastReloadAt: new Date().toISOString(),
    })

    app.log.info(
      {
        path: outcome.path,
        providers: providers.length,
        models: models.length,
        resolvable: state.registry.resolvable().length,
      },
      'Config reloaded',
    )

    return reply.send({
      ok: true,
      path: outcome.path,
      providers: providers.length,
      models: models.length,
      resolvable: state.registry.resolvable().length,
      warnings: [
        ...(gatewayBackedProviderIds.length > 0 ? gatewayContext.warnings : []),
        ...discoveryWarnings,
        ...visibleWarnings,
      ],
    })
  })
}
