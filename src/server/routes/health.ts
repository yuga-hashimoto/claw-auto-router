import type { FastifyInstance } from 'fastify'
import type { ProviderRegistry } from '../../providers/registry.js'

export function registerHealthRoute(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
): void {
  app.get('/health', async (_request, reply) => {
    const registry = getRegistry()
    const resolvable = registry.resolvable()
    return reply.send({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      models: {
        total: registry.size,
        resolvable: resolvable.length,
      },
    })
  })
}
