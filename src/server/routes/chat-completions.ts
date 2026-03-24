import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AdapterRequest, ThinkingConfig } from '../../adapters/types.js'
import type { RawConfig } from '../../config/schema.js'
import type { RouterConfig } from '../../config/router-config.js'
import { appendDecisionLogEntry, buildDecisionLogEntry } from '../../decision-log.js'
import type { OpenClawGatewayContext } from '../../openclaw/gateway.js'
import type { ProviderRegistry } from '../../providers/registry.js'
import { executeWithFallback } from '../../proxy/fallback.js'
import { resolveClassificationDetail } from '../../router/classifier-resolver.js'
import { route } from '../../router/router.js'
import type { ClassificationDetail, OpenAIMessage, RoutingTier } from '../../router/types.js'
import { buildRoutingControlResponse, resolveRoutingControlCommand, type RoutingControlResolution } from '../../routing-controls.js'
import { resolveSessionKey, type SessionStore } from '../../session-store.js'
import type { StatsCollector } from '../../stats/collector.js'
import { estimateRequestCosts, extractUsageSummary } from '../../stats/costs.js'
import { AllProvidersFailed, NoCandidatesError } from '../../utils/errors.js'

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'function', 'tool']),
  content: z.union([z.string(), z.array(z.unknown()), z.null()]).default(''),
  name: z.string().optional(),
})

const ThinkingSchema = z
  .object({
    type: z.enum(['enabled', 'disabled']).optional(),
    enabled: z.boolean().optional(),
    budget_tokens: z.number().int().positive().optional(),
    interleaved: z.boolean().optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .optional()

const ChatCompletionRequestSchema = z
  .object({
    model: z.string().default('auto'),
    messages: z.array(MessageSchema).min(1),
    stream: z.boolean().optional().default(false),
    max_tokens: z.number().optional(),
    temperature: z.number().optional(),
    session_id: z.string().optional(),
    user: z.string().optional(),
    thinking: ThinkingSchema,
    reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  })
  .passthrough()

type ChatRequest = z.infer<typeof ChatCompletionRequestSchema>

interface RouteContext {
  getConfig: () => RawConfig
  getConfigPath: () => string | undefined
  getRegistry: () => ProviderRegistry
  getRouterConfig: () => RouterConfig
  getGatewayContext: () => OpenClawGatewayContext | undefined
  getDecisionLogEnabled: () => boolean
  getSessionStore: () => SessionStore
}

const KNOWN_REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'temperature',
  'session_id',
  'user',
  'thinking',
  'reasoning_effort',
])

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
    const messages = body.messages as OpenAIMessage[]
    const start = Date.now()

    const config = context.getConfig()
    const configPath = context.getConfigPath()
    const registry = context.getRegistry()
    const routerConfig = context.getRouterConfig()
    const gatewayContext = context.getGatewayContext()
    const decisionLogEnabled = context.getDecisionLogEnabled()
    const sessionStore = context.getSessionStore()

    const sessionResolution = resolveSessionKey({
      sessionId: body.session_id,
      user: body.user,
      headers: request.headers,
      messages,
    })
    const sessionOverride = sessionStore.get(sessionResolution.sessionId)
    stats.setRecentOverrides(sessionStore.list())

    const controlResolution = resolveRoutingControlCommand(getLastUserMessageText(messages), registry)
    if (controlResolution !== undefined) {
      applyRoutingControl(sessionStore, sessionResolution.sessionId, controlResolution)
      stats.setRecentOverrides(sessionStore.list())

      return reply.send(
        buildSyntheticControlResponse(
          buildRoutingControlResponse(
            controlResolution,
            sessionResolution.sessionId,
            sessionResolution.derived,
          ),
        ),
      )
    }

    const explicitModelRequested = body.model !== undefined && body.model !== 'auto'
    const effectiveRequestedModel =
      !explicitModelRequested && sessionOverride?.explicitModelId !== undefined
        ? sessionOverride.explicitModelId
        : body.model
    const effectiveThinking = resolveEffectiveThinking(
      body.thinking,
      body.reasoning_effort,
      sessionOverride?.thinking,
    )
    const extra = extractExtraFields(body)

    let classification = await resolveClassificationDetail({
      request: {
        model: effectiveRequestedModel,
        messages,
        stream: body.stream,
      },
      registry,
      routerConfig,
      gatewayContext,
      ...(configPath !== undefined ? { openClawConfigPath: configPath } : {}),
    })
    classification = applyTierOverride(classification, sessionOverride?.forcedTier, explicitModelRequested)

    const routingRequest = {
      model: effectiveRequestedModel,
      messages,
      stream: body.stream,
    }

    const appliedOverride = {
      ...(!explicitModelRequested && sessionOverride?.explicitModelId !== undefined
        ? { explicitModelId: sessionOverride.explicitModelId }
        : {}),
      ...(!explicitModelRequested && sessionOverride?.forcedTier !== undefined
        ? { forcedTier: sessionOverride.forcedTier }
        : {}),
      ...(effectiveThinking?.source === 'session' ? { thinking: effectiveThinking } : {}),
    }
    const overrideApplied = Object.keys(appliedOverride).length > 0
    const overrideSummary = summarizeOverride(appliedOverride, overrideApplied)

    let routeResult:
      | ReturnType<typeof route>
      | undefined

    try {
      routeResult = route(routingRequest, config, registry, routerConfig, classification)

      app.log.debug(
        {
          tier: routeResult.tier,
          winner: routeResult.winner.model.id,
          fallbacks: routeResult.fallbacks.map((fallback) => fallback.model.id),
          sessionId: sessionResolution.sessionId,
          overrideSummary,
        },
        'Routing decision',
      )

      const adapterRequest: AdapterRequest = {
        messages,
        model: routeResult.winner.model.modelId,
        stream: body.stream ?? false,
        ...(configPath !== undefined ? { openClawConfigPath: configPath } : {}),
        openClawGateway: gatewayContext,
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(effectiveThinking !== undefined ? { thinking: effectiveThinking } : {}),
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
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
      const costSummary = estimateRequestCosts({
        resolvedModel: proxyResult.finalModel,
        registry,
        routerConfig,
        usage: extractUsageSummary(proxyResult.response),
      })

      stats.record({
        timestamp: Date.now(),
        requestedModel: body.model,
        resolvedModel: proxyResult.finalModel.id,
        tier: routeResult.tier,
        classifierMode: classification.mode,
        ...(classification.classifierModelId !== undefined
          ? { classifierModelId: classification.classifierModelId }
          : {}),
        attemptCount: proxyResult.attempts.length,
        totalDurationMs: durationMs,
        success: true,
        fallbackUsed: usedFallback,
        ...(costSummary.usage !== undefined
          ? {
              promptTokens: costSummary.usage.promptTokens,
              completionTokens: costSummary.usage.completionTokens,
              totalTokens: costSummary.usage.totalTokens,
            }
          : {}),
        ...(costSummary.estimatedCostUsd !== undefined ? { estimatedCostUsd: costSummary.estimatedCostUsd } : {}),
        ...(costSummary.baselineCostUsd !== undefined ? { baselineCostUsd: costSummary.baselineCostUsd } : {}),
        ...(costSummary.estimatedSavingsUsd !== undefined
          ? { estimatedSavingsUsd: costSummary.estimatedSavingsUsd }
          : {}),
        ...(costSummary.baselineModelId !== undefined ? { baselineModelId: costSummary.baselineModelId } : {}),
        ...(sessionResolution.sessionId !== undefined ? { sessionId: sessionResolution.sessionId } : {}),
        ...(sessionResolution.source !== 'none' ? { sessionSource: sessionResolution.source } : {}),
        ...(overrideApplied ? { overrideApplied: true, overrideSummary } : {}),
        ...(effectiveThinking !== undefined ? { thinking: effectiveThinking } : {}),
      })
      stats.setRecentOverrides(sessionStore.list())

      if (decisionLogEnabled) {
        appendDecisionLogEntry(
          buildDecisionLogEntry({
            requestId: request.id,
            requestedModel: body.model,
            resolvedModel: proxyResult.finalModel.id,
            success: true,
            fallbackUsed: usedFallback,
            stream: body.stream ?? false,
            totalDurationMs: durationMs,
            messageCount: body.messages.length,
            classification: routeResult.decision?.classification ?? classification,
            candidates: routeResult.decision?.candidates ?? [],
            attempts: proxyResult.attempts,
          }),
          configPath,
        )
      }

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

      return reply.send(proxyResult.response)
    } catch (err) {
      const durationMs = Date.now() - start

      if (err instanceof NoCandidatesError) {
        stats.record(
          buildFailureStatsRecord({
            requestedModel: body.model,
            resolvedModel: 'none',
            classification,
            durationMs,
            attemptCount: 0,
            fallbackUsed: false,
            sessionId: sessionResolution.sessionId,
            sessionSource: sessionResolution.source,
            overrideApplied,
            overrideSummary,
            thinking: effectiveThinking,
          }),
        )
        stats.setRecentOverrides(sessionStore.list())
        if (decisionLogEnabled) {
          appendDecisionLogEntry(
            buildDecisionLogEntry({
              requestId: request.id,
              requestedModel: body.model,
              resolvedModel: 'none',
              success: false,
              fallbackUsed: false,
              stream: body.stream ?? false,
              totalDurationMs: durationMs,
              messageCount: body.messages.length,
              classification,
              candidates: [],
              attempts: [],
              error: err.message,
            }),
            configPath,
          )
        }
        return reply.status(503).send({
          error: { message: err.message, type: 'no_candidates', code: 503 },
        })
      }

      if (err instanceof AllProvidersFailed) {
        stats.record(
          buildFailureStatsRecord({
            requestedModel: body.model,
            resolvedModel: err.attempts[err.attempts.length - 1]?.model.id ?? 'unknown',
            classification: routeResult?.decision?.classification ?? classification,
            durationMs,
            attemptCount: err.attempts.length,
            fallbackUsed: err.attempts.length > 1,
            sessionId: sessionResolution.sessionId,
            sessionSource: sessionResolution.source,
            overrideApplied,
            overrideSummary,
            thinking: effectiveThinking,
          }),
        )
        stats.setRecentOverrides(sessionStore.list())
        if (decisionLogEnabled) {
          appendDecisionLogEntry(
            buildDecisionLogEntry({
              requestId: request.id,
              requestedModel: body.model,
              resolvedModel: err.attempts[err.attempts.length - 1]?.model.id ?? 'unknown',
              success: false,
              fallbackUsed: err.attempts.length > 1,
              stream: body.stream ?? false,
              totalDurationMs: durationMs,
              messageCount: body.messages.length,
              classification: routeResult?.decision?.classification ?? classification,
              candidates: routeResult?.decision?.candidates ?? [],
              attempts: err.attempts,
              error: err.message,
            }),
            configPath,
          )
        }
        return reply.status(502).send({
          error: {
            message: err.message,
            type: 'all_providers_failed',
            code: 502,
            attempts: err.attempts.length,
          },
        })
      }

      app.log.error(err, 'Unexpected error in chat completions handler')
      stats.record(
        buildFailureStatsRecord({
          requestedModel: body.model,
          resolvedModel: 'unknown',
          classification: routeResult?.decision?.classification ?? classification,
          durationMs,
          attemptCount: 0,
          fallbackUsed: false,
          sessionId: sessionResolution.sessionId,
          sessionSource: sessionResolution.source,
          overrideApplied,
          overrideSummary,
          thinking: effectiveThinking,
        }),
      )
      stats.setRecentOverrides(sessionStore.list())
      if (decisionLogEnabled) {
        appendDecisionLogEntry(
          buildDecisionLogEntry({
            requestId: request.id,
            requestedModel: body.model,
            resolvedModel: 'unknown',
            success: false,
            fallbackUsed: false,
            stream: body.stream ?? false,
            totalDurationMs: durationMs,
            messageCount: body.messages.length,
            classification: routeResult?.decision?.classification ?? classification,
            candidates: routeResult?.decision?.candidates ?? [],
            attempts: [],
            error: err instanceof Error ? err.message : 'Unexpected internal error',
          }),
          configPath,
        )
      }
      return reply.status(500).send({
        error: { message: 'Internal server error', type: 'internal_error', code: 500 },
      })
    }
  })
}

function buildFailureStatsRecord(input: {
  requestedModel: string
  resolvedModel: string
  classification: ClassificationDetail
  durationMs: number
  attemptCount: number
  fallbackUsed: boolean
  sessionId?: string | undefined
  sessionSource?: string | undefined
  overrideApplied: boolean
  overrideSummary?: string | undefined
  thinking?: ThinkingConfig | undefined
}) {
  return {
    timestamp: Date.now(),
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    tier: input.classification.tier,
    classifierMode: input.classification.mode,
    ...(input.classification.classifierModelId !== undefined
      ? { classifierModelId: input.classification.classifierModelId }
      : {}),
    attemptCount: input.attemptCount,
    totalDurationMs: input.durationMs,
    success: false,
    fallbackUsed: input.fallbackUsed,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.sessionSource !== undefined && input.sessionSource !== 'none'
      ? { sessionSource: input.sessionSource }
      : {}),
    ...(input.overrideApplied ? { overrideApplied: true, overrideSummary: input.overrideSummary } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
  }
}

function extractExtraFields(body: ChatRequest): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => !KNOWN_REQUEST_FIELDS.has(key)),
  )
}

function applyRoutingControl(
  sessions: SessionStore,
  sessionId: string | undefined,
  resolution: RoutingControlResolution,
): void {
  if (sessionId === undefined) {
    return
  }

  switch (resolution.action.type) {
    case 'set-model':
      sessions.upsert(sessionId, { explicitModelId: resolution.action.model.id })
      return
    case 'clear-model':
      sessions.upsert(sessionId, { explicitModelId: undefined })
      return
    case 'set-tier':
      sessions.upsert(sessionId, { forcedTier: resolution.action.tier })
      return
    case 'clear-tier':
      sessions.upsert(sessionId, { forcedTier: undefined })
      return
    case 'set-thinking':
      sessions.upsert(sessionId, { thinking: resolution.action.thinking })
      return
    case 'clear-thinking':
      sessions.upsert(sessionId, { thinking: undefined })
      return
    case 'clear-all':
      sessions.clear(sessionId)
      return
  }
}

function applyTierOverride(
  classification: ClassificationDetail,
  forcedTier: RoutingTier | undefined,
  explicitModelRequested: boolean,
): ClassificationDetail {
  if (forcedTier === undefined || explicitModelRequested) {
    return classification
  }

  return {
    ...classification,
    tier: forcedTier,
    reasons: [
      `Conversation override forced the ${forcedTier} tier`,
      ...classification.reasons,
    ],
  }
}

function resolveEffectiveThinking(
  requestThinking: ChatRequest['thinking'],
  reasoningEffort: ChatRequest['reasoning_effort'],
  sessionThinking: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  const explicit = normalizeThinkingConfig(requestThinking)
  if (explicit !== undefined) {
    return { ...explicit, source: 'request' }
  }

  if (reasoningEffort !== undefined) {
    return mapReasoningEffortToThinking(reasoningEffort)
  }

  return sessionThinking !== undefined ? { ...sessionThinking, source: 'session' } : undefined
}

function normalizeThinkingConfig(input: ChatRequest['thinking']): ThinkingConfig | undefined {
  if (input === undefined) {
    return undefined
  }

  if (input.type === 'disabled' || input.enabled === false) {
    return undefined
  }

  if (
    input.type === 'enabled' ||
    input.enabled === true ||
    input.budget_tokens !== undefined ||
    input.interleaved === true ||
    input.effort !== undefined
  ) {
    return {
      type: 'enabled',
      ...(input.budget_tokens !== undefined ? { budgetTokens: input.budget_tokens } : {}),
      ...(input.interleaved !== undefined ? { interleaved: input.interleaved } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    }
  }

  return undefined
}

function mapReasoningEffortToThinking(effort: 'low' | 'medium' | 'high'): ThinkingConfig {
  return {
    type: 'enabled',
    effort,
    budgetTokens: effort === 'low' ? 2_048 : effort === 'medium' ? 4_096 : 8_192,
    source: 'reasoning_effort',
  }
}

function summarizeOverride(
  override:
    | {
        explicitModelId?: string | undefined
        forcedTier?: RoutingTier | undefined
        thinking?: ThinkingConfig | undefined
      }
    | undefined,
  applied: boolean,
): string | undefined {
  if (!applied || override === undefined) {
    return undefined
  }

  const parts: string[] = []
  if (override.explicitModelId !== undefined) {
    parts.push(`model=${override.explicitModelId}`)
  }
  if (override.forcedTier !== undefined) {
    parts.push(`tier=${override.forcedTier}`)
  }
  if (override.thinking !== undefined) {
    parts.push('thinking=on')
  }

  return parts.length > 0 ? parts.join(', ') : undefined
}

function getLastUserMessageText(messages: OpenAIMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      return renderMessageContent(message.content)
    }
  }

  return ''
}

function renderMessageContent(message: string | OpenAIMessage['content']): string {
  if (message === null) {
    return ''
  }

  if (typeof message === 'string') {
    return message
  }

  return message
    .map((part) => {
      if (part.type === 'text') {
        return part.text ?? ''
      }

      if (part.type === 'image_url') {
        return '[image]'
      }

      return ''
    })
    .join(' ')
}

function buildSyntheticControlResponse(content: string) {
  return {
    id: `chatcmpl-control-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'claw-auto-router/control',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  }
}
