import Fastify from 'fastify'
import cors from '@fastify/cors'
import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import { ProviderRegistry } from '../providers/registry.js'
import { StatsCollector } from '../stats/collector.js'
import { registerErrorHandler } from './plugins/error-handler.js'
import { registerHealthRoute } from './routes/health.js'
import { registerModelsRoute } from './routes/models.js'
import { registerChatCompletionsRoute } from './routes/chat-completions.js'
import { registerStatsRoute } from './routes/stats.js'
import { registerReloadRoute } from './routes/reload-config.js'

export interface AppOptions {
  config: RawConfig
  registry: ProviderRegistry
  configPath?: string | undefined
  routerConfigPath?: string | undefined
  routerConfig?: RouterConfig | undefined
  logLevel?: string | undefined
  adminToken?: string | undefined
  requestTimeoutMs?: number | undefined
}

export function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? 'info',
    },
  })

  const stats = new StatsCollector()

  // Mutable state container — updated atomically on /reload-config
  const state = {
    config: options.config,
    registry: options.registry,
    configPath: options.configPath,
    routerConfigPath: options.routerConfigPath,
    routerConfig: options.routerConfig ?? {},
  }

  const timeoutMs = options.requestTimeoutMs ?? 30_000

  // Register plugins
  app.register(cors, { origin: true })

  // Register error handler
  registerErrorHandler(app)

  // Routes use getter functions so they always see the current state after reload
  registerHealthRoute(app, () => state.registry)
  registerModelsRoute(app, () => state.registry)
  registerStatsRoute(app, stats)

  registerReloadRoute(app, state, stats, options.adminToken)

  registerChatCompletionsRoute(
    app,
    {
      getConfig: () => state.config,
      getRegistry: () => state.registry,
      getRouterConfig: () => state.routerConfig,
    },
    stats,
    timeoutMs,
  )

  // Log startup info
  app.addHook('onReady', async () => {
    const resolvable = state.registry.resolvable()
    app.log.info(
      {
        totalModels: state.registry.size,
        resolvableModels: resolvable.length,
        resolvableIds: resolvable.map((m) => m.id),
      },
      'Router ready',
    )
  })

  return app
}
