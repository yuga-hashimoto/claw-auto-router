import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { RawConfig } from '../../config/schema.js'
import type { RouterConfig } from '../../config/router-config.js'
import type { OpenClawGatewayContext } from '../../openclaw/gateway.js'
import type { ProviderRegistry } from '../../providers/registry.js'
import type { StatsCollector } from '../../stats/collector.js'
import { route } from '../../router/router.js'
import { executeWithFallback } from '../../proxy/fallback.js'
import type { AdapterRequest } from '../../adapters/types.js'
import type { OpenAIMessage } from '../../router/types.js'
import { NoCandidatesError, AllProvidersFailed } from '../../utils/errors.js'

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'function', 'tool']),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).default(''),
  name: z.string().optional(),
})

const ChatCompletionRequestSchema = z.object({
  model: z.string().default('auto'),
  messages: z.array(MessageSchema).min(1),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
})

type ChatRequest = z.infer<typeof ChatCompletionRequestSchema>

interface RouteContext {
  getConfig: () => RawConfig
  getConfigPath: () => string | undefined
  getRegistry: () => ProviderRegistry
  getRouterConfig: () => RouterConfig
  getGatewayContext: () => OpenClawGatewayContext | undefined
}

export function registerChatCompletionsRoute(
  app: FastifyInstance,
  context: RouteContext,
  stats: StatsCollector,
  timeoutMs: number,
): void {
  app.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseResult = ChatCompletionRequestSchema.safeParse(request.body)
    if (!parseResult.success) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request body',
          type: 'invalid_request_error',
          code: 400,
          details: parseResult.error.issues,
        },
      })
    }

    const body: ChatRequest = parseResult.data
    const start = Date.now()

    const config = context.getConfig()
    const configPath = context.getConfigPath()
    const registry = context.getRegistry()
    const routerConfig = context.getRouterConfig()
    const gatewayContext = context.getGatewayContext()

    const routingRequest = {
      model: body.model,
      messages: body.messages as OpenAIMessage[],
      stream: body.stream,
    }

    try {
      const routeResult = route(routingRequest, config, registry, routerConfig)

      app.log.debug(
        {
          tier: routeResult.tier,
          winner: routeResult.winner.model.id,
          fallbacks: routeResult.fallbacks.map((f) => f.model.id),
        },
        'Routing decision',
      )

      const adapterRequest: AdapterRequest = {
        messages: body.messages as OpenAIMessage[],
        model: routeResult.winner.model.modelId,
        stream: body.stream ?? false,
        ...(configPath !== undefined ? { openClawConfigPath: configPath } : {}),
        openClawGateway: gatewayContext,
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      }

      const proxyResult = await executeWithFallback(routeResult, adapterRequest, {
        timeoutMs,
        onAttempt: (attempt) => {
          if (!attempt.success) {
            app.log.warn(
              { model: attempt.model.id, status: attempt.statusCode, error: attempt.error },
              'Provider attempt failed',
            )
          }
        },
      })

      const durationMs = Date.now() - start
      const usedFallback = proxyResult.attempts.length > 1

      stats.record({
        timestamp: Date.now(),
        requestedModel: body.model,
        resolvedModel: proxyResult.finalModel.id,
        tier: routeResult.tier,
        attemptCount: proxyResult.attempts.length,
        totalDurationMs: durationMs,
        success: true,
        fallbackUsed: usedFallback,
      })

      // Streaming response
      if (proxyResult.streaming && proxyResult.stream !== undefined) {
        reply.raw.setHeader('Content-Type', 'text/event-stream')
        reply.raw.setHeader('Cache-Control', 'no-cache')
        reply.raw.setHeader('Connection', 'keep-alive')
        reply.raw.setHeader('X-Accel-Buffering', 'no')

        for await (const chunk of proxyResult.stream) {
          reply.raw.write(chunk)
        }
        reply.raw.end()
        return
      }

      // Non-streaming response
      return reply.send(proxyResult.response)

    } catch (err) {
      const durationMs = Date.now() - start

      if (err instanceof NoCandidatesError) {
        stats.record({
          timestamp: Date.now(),
          requestedModel: body.model,
          resolvedModel: 'none',
          tier: 'STANDARD',
          attemptCount: 0,
          totalDurationMs: durationMs,
          success: false,
          fallbackUsed: false,
        })
        return reply.status(503).send({
          error: { message: err.message, type: 'no_candidates', code: 503 },
        })
      }

      if (err instanceof AllProvidersFailed) {
        stats.record({
          timestamp: Date.now(),
          requestedModel: body.model,
          resolvedModel: err.attempts[err.attempts.length - 1]?.model.id ?? 'unknown',
          tier: 'STANDARD',
          attemptCount: err.attempts.length,
          totalDurationMs: durationMs,
          success: false,
          fallbackUsed: err.attempts.length > 1,
        })
        return reply.status(502).send({
          error: {
            message: err.message,
            type: 'all_providers_failed',
            code: 502,
            attempts: err.attempts.length,
          },
        })
      }

      // Unexpected error
      app.log.error(err, 'Unexpected error in chat completions handler')
      stats.record({
        timestamp: Date.now(),
        requestedModel: body.model,
        resolvedModel: 'unknown',
        tier: 'STANDARD',
        attemptCount: 0,
        totalDurationMs: durationMs,
        success: false,
        fallbackUsed: false,
      })
      return reply.status(500).send({
        error: { message: 'Internal server error', type: 'internal_error', code: 500 },
      })
    }
  })
}
