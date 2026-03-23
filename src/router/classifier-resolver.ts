import type { RouterConfig } from '../config/router-config.js'
import type { OpenClawGatewayContext } from '../openclaw/gateway.js'
import { isModelAvailable } from '../providers/types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { executeOne } from '../proxy/executor.js'
import type { AdapterRequest } from '../adapters/types.js'
import { classifyRequestDetailed } from './classifier.js'
import type { ClassificationDetail, OpenAIContentPart, OpenAIMessage, RoutingRequest, RoutingTier } from './types.js'

const DEFAULT_ROUTER_AI_TIMEOUT_MS = 8_000
const ROUTER_AI_MAX_TOKENS = 96
const MAX_ROUTER_AI_MESSAGES = 8
const MAX_ROUTER_AI_CHARS = 6_000

const ROUTER_AI_SYSTEM_PROMPT = [
  'You are RouterAI for an LLM model router.',
  'Choose exactly one tier for the conversation: SIMPLE, STANDARD, COMPLEX, or CODE.',
  'Definitions:',
  '- SIMPLE: greetings, quick factual Q&A, one-liners, lightweight lookups.',
  '- STANDARD: normal assistant work, explanations, drafting, everyday chat tasks.',
  '- COMPLEX: deep reasoning, long-context analysis, architecture, research, comparisons, multi-step planning.',
  '- CODE: coding, debugging, refactoring, stack traces, tests, patches, PR review, scripts.',
  'Rules:',
  '- Prefer CODE when the user is asking to write, debug, review, or explain code.',
  '- Prefer COMPLEX when the request needs analysis, tradeoffs, large context, or deeper reasoning.',
  '- Prefer SIMPLE only when the request is clearly lightweight.',
  '- Otherwise choose STANDARD.',
  'Return strict JSON only in this exact shape: {"tier":"SIMPLE|STANDARD|COMPLEX|CODE","reason":"short explanation"}',
].join('\n')

interface ResolveClassificationOptions {
  request: RoutingRequest
  registry: ProviderRegistry
  routerConfig: RouterConfig
  gatewayContext?: OpenClawGatewayContext | undefined
  openClawConfigPath?: string | undefined
}

interface ParsedRouterAIResponse {
  tier: RoutingTier
  reason?: string | undefined
}

export async function resolveClassificationDetail(
  options: ResolveClassificationOptions,
): Promise<ClassificationDetail> {
  const heuristic = classifyRequestDetailed(options.request)
  const routerAI = options.routerConfig.routerAI

  if (routerAI?.mode !== 'ai') {
    return heuristic
  }

  if (options.request.model !== undefined && options.request.model !== 'auto') {
    return withHeuristicFallback(
      heuristic,
      'Explicit model request bypassed RouterAI classification; keeping heuristic context only.',
    )
  }

  if (routerAI.model === undefined || routerAI.model.trim() === '') {
    return withHeuristicFallback(heuristic, 'RouterAI is enabled but no classifier model is configured.')
  }

  const classifierModel = options.registry.lookup(routerAI.model)
  if (classifierModel === undefined) {
    return withHeuristicFallback(
      heuristic,
      `RouterAI model "${routerAI.model}" was not found in the current model registry.`,
    )
  }

  if (!isModelAvailable(classifierModel)) {
    return withHeuristicFallback(
      heuristic,
      `RouterAI model "${classifierModel.id}" is not available right now, so heuristics were used instead.`,
    )
  }

  const adapterRequest: AdapterRequest = {
    model: classifierModel.modelId,
    stream: false,
    maxTokens: ROUTER_AI_MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: 'system', content: ROUTER_AI_SYSTEM_PROMPT },
      { role: 'user', content: buildRouterAIUserPrompt(options.request, heuristic) },
    ],
    ...(options.openClawConfigPath !== undefined ? { openClawConfigPath: options.openClawConfigPath } : {}),
    ...(options.gatewayContext !== undefined ? { openClawGateway: options.gatewayContext } : {}),
  }

  const timeoutMs = routerAI.timeoutMs ?? DEFAULT_ROUTER_AI_TIMEOUT_MS
  const { attempt, result } = await executeOne(classifierModel, adapterRequest, timeoutMs)
  if (result === undefined) {
    return withHeuristicFallback(
      heuristic,
      `RouterAI classification failed on ${classifierModel.id}${formatAttemptFailure(attempt)}.`,
    )
  }

  const responseText = extractAssistantText(result.response)
  const parsed = parseRouterAIResponse(responseText)
  if (parsed === undefined) {
    return withHeuristicFallback(
      heuristic,
      `RouterAI returned an unreadable classification on ${classifierModel.id}; heuristics were used instead.`,
    )
  }

  return {
    tier: parsed.tier,
    totalTokens: heuristic.totalTokens,
    lastUserMessage: heuristic.lastUserMessage,
    reasons: [
      `RouterAI classified this request with ${classifierModel.id}`,
      ...(parsed.reason !== undefined ? [`Model rationale: ${parsed.reason}`] : [`Model returned ${parsed.tier}`]),
      `Heuristic baseline was ${heuristic.tier}`,
    ],
    mode: 'ai',
    classifierModelId: classifierModel.id,
  }
}

function withHeuristicFallback(base: ClassificationDetail, reason: string): ClassificationDetail {
  return {
    ...base,
    reasons: [reason, ...base.reasons],
  }
}

function formatAttemptFailure(attempt: { statusCode?: number | undefined; error?: string | undefined }): string {
  if (attempt.statusCode !== undefined) {
    return ` (HTTP ${attempt.statusCode})`
  }

  if (attempt.error !== undefined && attempt.error !== '') {
    return ` (${attempt.error})`
  }

  return ''
}

function buildRouterAIUserPrompt(request: RoutingRequest, heuristic: ClassificationDetail): string {
  const conversation = serializeConversation(request.messages)

  return [
    'Classify this conversation for model routing.',
    `Requested model: ${request.model ?? 'auto'}`,
    `Approx conversation size: ${heuristic.totalTokens} tokens`,
    '',
    'Conversation:',
    conversation === '' ? '(no message text)' : conversation,
  ].join('\n')
}

function serializeConversation(messages: OpenAIMessage[]): string {
  const recentMessages = messages.slice(-MAX_ROUTER_AI_MESSAGES)
  const omittedCount = Math.max(messages.length - recentMessages.length, 0)
  const rendered = recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${renderContent(message.content)}`)
    .join('\n\n')

  const withPrefix =
    omittedCount > 0
      ? `[${omittedCount} earlier message(s) omitted for brevity]\n\n${rendered}`
      : rendered

  if (withPrefix.length <= MAX_ROUTER_AI_CHARS) {
    return withPrefix
  }

  return `${withPrefix.slice(0, MAX_ROUTER_AI_CHARS - 3)}...`
}

function renderContent(content: string | OpenAIContentPart[] | null): string {
  if (content === null) {
    return '(no content)'
  }

  if (typeof content === 'string') {
    return content.trim() === '' ? '(empty text)' : content
  }

  const pieces = content.map((part) => renderContentPart(part)).filter((part) => part !== '')
  return pieces.length > 0 ? pieces.join(' ') : '(non-text content only)'
}

function renderContentPart(part: OpenAIContentPart): string {
  if (part.type === 'text') {
    return part.text?.trim() === '' || part.text === undefined ? '' : part.text
  }

  if (part.type === 'image_url') {
    return '[image]'
  }

  return ''
}

function extractAssistantText(responseBody: unknown): string {
  if (typeof responseBody !== 'object' || responseBody === null) {
    return ''
  }

  const body = responseBody as {
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> | null }
    }>
  }

  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter((part) => part !== '')
      .join(' ')
      .trim()
  }

  return ''
}

function parseRouterAIResponse(raw: string): ParsedRouterAIResponse | undefined {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')

  const jsonCandidate = extractJsonObject(cleaned)
  if (jsonCandidate !== undefined) {
    try {
      const parsed = JSON.parse(jsonCandidate) as { tier?: string; reason?: string }
      const tier = normalizeTier(parsed.tier)
      if (tier !== undefined) {
        return {
          tier,
          ...(typeof parsed.reason === 'string' && parsed.reason.trim() !== ''
            ? { reason: truncateReason(parsed.reason) }
            : {}),
        }
      }
    } catch {
      // Fall through to regex parsing below.
    }
  }

  const matchedTier = cleaned.match(/\b(SIMPLE|STANDARD|COMPLEX|CODE)\b/i)
  const tier = normalizeTier(matchedTier?.[1])
  if (tier === undefined) {
    return undefined
  }

  return { tier }
}

function extractJsonObject(value: string): string | undefined {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return undefined
  }

  return value.slice(start, end + 1)
}

function normalizeTier(value: string | undefined): RoutingTier | undefined {
  switch (value?.toUpperCase()) {
    case 'SIMPLE':
      return 'SIMPLE'
    case 'STANDARD':
      return 'STANDARD'
    case 'COMPLEX':
      return 'COMPLEX'
    case 'CODE':
      return 'CODE'
    default:
      return undefined
  }
}

function truncateReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, ' ').trim()
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`
}
