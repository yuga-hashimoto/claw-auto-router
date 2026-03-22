import type { FastifyInstance } from 'fastify'
import type { ProviderRegistry } from '../../providers/registry.js'

export function registerModelsRoute(
  app: FastifyInstance,
  getRegistry: () => ProviderRegistry,
): void {
  app.get('/v1/models', async (_request, reply) => {
    const registry = getRegistry()
    const models = registry.resolvable()
    const data = models.map((m) => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.providerId,
      permission: [],
      root: m.id,
      parent: null,
    }))

    return reply.send({ object: 'list', data })
  })
}
