import type { FastifyInstance } from 'fastify'
import type { StatsCollector } from '../../stats/collector.js'
import type { RouterConfig } from '../../config/router-config.js'
import { loadOpenClawConfig } from '../../config/loader.js'
import { loadRouterConfig, resolveRouterConfigPath } from '../../config/router-config.js'
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
    const { providers, models, warnings } = normalizeConfig(outcome.config, newRouterConfig)

    for (const w of warnings) {
      app.log.warn(w)
    }

    // Atomically replace all mutable state
    state.config = outcome.config
    state.registry = new ProviderRegistry(models)
    state.configPath = outcome.path
    state.routerConfigPath = routerConfigPath
    state.routerConfig = newRouterConfig

    stats.setConfigStatus({
      loaded: true,
      path: outcome.path,
      warnings,
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
      warnings,
    })
  })
}
