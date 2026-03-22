import type { FastifyInstance } from 'fastify'
import type { StatsCollector } from '../../stats/collector.js'

export function registerStatsRoute(app: FastifyInstance, stats: StatsCollector): void {
  app.get('/stats', async (_request, reply) => {
    return reply.send(stats.getSummary())
  })
}
