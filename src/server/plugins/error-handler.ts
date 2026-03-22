import type { FastifyInstance, FastifyError } from 'fastify'
import { NoCandidatesError, AllProvidersFailed, ConfigError } from '../../utils/errors.js'

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: Error | FastifyError, _request, reply) => {
    if (error instanceof NoCandidatesError) {
      return reply.status(503).send({
        error: { message: error.message, type: 'no_candidates', code: 503 },
      })
    }

    if (error instanceof AllProvidersFailed) {
      return reply.status(502).send({
        error: {
          message: error.message,
          type: 'all_providers_failed',
          code: 502,
          attempts: error.attempts.length,
        },
      })
    }

    if (error instanceof ConfigError) {
      return reply.status(500).send({
        error: { message: error.message, type: 'config_error', code: 500 },
      })
    }

    // Fastify validation errors
    if ('statusCode' in error && typeof error.statusCode === 'number') {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: 'validation_error', code: error.statusCode },
      })
    }

    app.log.error(error, 'Unhandled error')
    return reply.status(500).send({
      error: { message: 'Internal server error', type: 'internal_error', code: 500 },
    })
  })
}
