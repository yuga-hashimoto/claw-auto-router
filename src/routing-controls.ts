import type { ThinkingConfig } from './adapters/types.js'
import type { ProviderRegistry } from './providers/registry.js'
import type { NormalizedModel } from './providers/types.js'
import type { RoutingTier } from './router/types.js'

export type RoutingControlAction =
  | { type: 'set-model'; model: NormalizedModel }
  | { type: 'clear-model' }
  | { type: 'set-tier'; tier: RoutingTier }
  | { type: 'clear-tier' }
  | { type: 'set-thinking'; thinking: ThinkingConfig }
  | { type: 'clear-thinking' }
  | { type: 'clear-all' }

export interface RoutingControlResolution {
  action: RoutingControlAction
  userMessage: string
}

const TIER_NAMES: RoutingTier[] = ['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE']
const MODEL_SET_RE = /^(?:\/)?(?:use|switch to|route to|set model to|prefer model)\s+(.+)$/i
const MODEL_CLEAR_RE = /^(?:\/)?(?:use auto(?: again)?|back to auto|reset model|clear model|default model)$/i
const ALL_CLEAR_RE = /^(?:\/)?(?:reset routing|clear routing|reset router)$/i
const TIER_SET_RE = /^(?:\/)?(?:prefer|use|switch to)\s+(simple|standard|complex|code)(?:\s+(?:tier|mode|model|models))?$/i
const TIER_CLEAR_RE = /^(?:\/)?(?:clear tier|reset tier|default tier)$/i
const THINKING_SET_RE = /^(?:\/)?thinking\s+(on|off|low|medium|high|budget\s+\d+|interleaved)$/i
const THINKING_CLEAR_RE = /^(?:\/)?(?:thinking off|clear thinking|reset thinking)$/i

export function resolveRoutingControlCommand(
  userMessage: string,
  registry: ProviderRegistry,
): RoutingControlResolution | undefined {
  const trimmed = normalizeCommand(userMessage)
  if (trimmed === '' || trimmed.length > 120) {
    return undefined
  }

  if (ALL_CLEAR_RE.test(trimmed)) {
    return { action: { type: 'clear-all' }, userMessage: trimmed }
  }

  if (MODEL_CLEAR_RE.test(trimmed)) {
    return { action: { type: 'clear-model' }, userMessage: trimmed }
  }

  if (TIER_CLEAR_RE.test(trimmed)) {
    return { action: { type: 'clear-tier' }, userMessage: trimmed }
  }

  if (THINKING_CLEAR_RE.test(trimmed)) {
    return { action: { type: 'clear-thinking' }, userMessage: trimmed }
  }

  const tierMatch = trimmed.match(TIER_SET_RE)
  if (tierMatch?.[1] !== undefined) {
    const tier = normalizeTier(tierMatch[1])
    if (tier !== undefined) {
      return { action: { type: 'set-tier', tier }, userMessage: trimmed }
    }
  }

  const thinkingMatch = trimmed.match(THINKING_SET_RE)
  if (thinkingMatch?.[1] !== undefined) {
    const thinking = normalizeThinking(thinkingMatch[1])
    if (thinking !== undefined) {
      return { action: { type: 'set-thinking', thinking }, userMessage: trimmed }
    }
  }

  const modelMatch = trimmed.match(MODEL_SET_RE)
  if (modelMatch?.[1] !== undefined) {
    const query = modelMatch[1].trim()
    if (query.toLowerCase() === 'auto') {
      return { action: { type: 'clear-model' }, userMessage: trimmed }
    }

    const model = findModel(query, registry)
    if (model !== undefined) {
      return { action: { type: 'set-model', model }, userMessage: trimmed }
    }
  }

  return undefined
}

export function buildRoutingControlResponse(
  resolution: RoutingControlResolution,
  sessionId: string | undefined,
  derivedSession: boolean,
): string {
  const scope =
    sessionId === undefined
      ? 'No stable session id was available, so this change only affects the current request.'
      : derivedSession
        ? `Saved for this conversation using a derived session key (${sessionId}).`
        : `Saved for this conversation (${sessionId}).`

  const actionLine = describeAction(resolution.action)
  const hints = [
    'You can say "use auto again" to return to normal routing.',
    'You can say "thinking off" to clear Anthropic thinking overrides.',
  ]

  return [actionLine, scope, ...hints].join('\n')
}

function describeAction(action: RoutingControlAction): string {
  switch (action.type) {
    case 'set-model':
      return `Routing locked to model ${action.model.id}.`
    case 'clear-model':
      return 'Model override cleared. Auto-routing is active again.'
    case 'set-tier':
      return `Routing now prefers the ${action.tier} tier for this conversation.`
    case 'clear-tier':
      return 'Tier override cleared. Normal classification is active again.'
    case 'set-thinking':
      return `Thinking override updated: ${describeThinking(action.thinking)}.`
    case 'clear-thinking':
      return 'Thinking override cleared.'
    case 'clear-all':
      return 'All routing overrides for this conversation were cleared.'
  }
}

function describeThinking(thinking: ThinkingConfig): string {
  const parts = ['enabled']
  if (thinking.effort !== undefined) {
    parts.push(`effort=${thinking.effort}`)
  }
  if (thinking.budgetTokens !== undefined) {
    parts.push(`budget=${thinking.budgetTokens}`)
  }
  if (thinking.interleaved === true) {
    parts.push('interleaved')
  }
  return parts.join(', ')
}

function normalizeCommand(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
}

function normalizeTier(value: string): RoutingTier | undefined {
  const normalized = value.toUpperCase()
  return TIER_NAMES.find((tier) => tier === normalized)
}

function normalizeThinking(value: string): ThinkingConfig | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'off') {
    return undefined
  }
  if (normalized === 'on') {
    return { type: 'enabled', budgetTokens: 4096, effort: 'medium', source: 'command' }
  }
  if (normalized === 'low') {
    return { type: 'enabled', budgetTokens: 2048, effort: 'low', source: 'command' }
  }
  if (normalized === 'medium') {
    return { type: 'enabled', budgetTokens: 4096, effort: 'medium', source: 'command' }
  }
  if (normalized === 'high') {
    return { type: 'enabled', budgetTokens: 8192, effort: 'high', source: 'command' }
  }
  if (normalized === 'interleaved') {
    return { type: 'enabled', budgetTokens: 4096, effort: 'medium', interleaved: true, source: 'command' }
  }

  const budgetMatch = normalized.match(/^budget\s+(\d+)$/)
  if (budgetMatch?.[1] !== undefined) {
    const budgetTokens = Number.parseInt(budgetMatch[1], 10)
    if (!Number.isNaN(budgetTokens) && budgetTokens > 0) {
      return { type: 'enabled', budgetTokens, source: 'command' }
    }
  }

  return undefined
}

function findModel(query: string, registry: ProviderRegistry): NormalizedModel | undefined {
  const direct = registry.lookup(query)
  if (direct !== undefined) {
    return direct
  }

  const normalizedQuery = normalizeLookup(query)
  const models = registry.resolvable()
  const exactMatches = models.filter((model) =>
    [model.id, model.modelId, model.alias, model.name]
      .filter((value): value is string => value !== undefined)
      .some((value) => normalizeLookup(value) === normalizedQuery),
  )
  if (exactMatches.length === 1) {
    return exactMatches[0]
  }

  const partialMatches = models.filter((model) =>
    [model.id, model.modelId, model.alias, model.name]
      .filter((value): value is string => value !== undefined)
      .some((value) => normalizeLookup(value).includes(normalizedQuery)),
  )

  if (partialMatches.length === 1) {
    return partialMatches[0]
  }

  const preferredOpus = partialMatches.find((model) => normalizeLookup(model.name).includes('opus'))
  if (preferredOpus !== undefined) {
    return preferredOpus
  }

  return undefined
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
