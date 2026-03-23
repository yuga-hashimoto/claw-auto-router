import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { isModelAvailable } from '../providers/types.js'
import type { RouteCandidate, RoutingTier } from './types.js'
import { rankCandidates } from './scorer.js'

/**
 * Build an ordered list of routing candidates for the given tier.
 *
 * Phase 1: collect candidates from config chain (explicit → primary → fallbacks → last-resort)
 * Phase 2: score and re-rank by tier using heuristics (reasoning, context window, model name)
 *
 * Explicit model requests always stay at position 0 regardless of score.
 */
export function buildCandidateChain(
  requestedModel: string | undefined,
  config: RawConfig,
  registry: ProviderRegistry,
  tier: RoutingTier = 'STANDARD',
  routerConfig?: RouterConfig,
): RouteCandidate[] {
  const configCandidates: RouteCandidate[] = []
  const seen = new Set<string>()
  const integration = routerConfig?.openClawIntegration
  const selfRef =
    integration !== undefined ? `${integration.providerId}/${integration.modelId}` : undefined
  const primary = integration?.upstreamPrimary ?? config.agents?.defaults?.model?.primary
  const fallbacks = integration?.upstreamFallbacks ?? config.agents?.defaults?.model?.fallbacks ?? []

  function tryAdd(ref: string, reason: string): void {
    if (selfRef !== undefined && ref === selfRef) return
    if (seen.has(ref)) return
    const model = registry.lookup(ref)
    if (model === undefined) return // phantom ref
    if (!isModelAvailable(model)) return
    seen.add(ref)
    configCandidates.push({
      model,
      position: configCandidates.length,
      configPosition: configCandidates.length,
      reason,
    })
  }

  // 1. Explicit model request (not "auto") — always goes first, bypasses scoring
  let explicitCandidate: RouteCandidate | undefined
  if (requestedModel !== undefined && requestedModel !== 'auto') {
    const model = registry.lookup(requestedModel)
    if (model !== undefined && isModelAvailable(model)) {
      explicitCandidate = {
        model,
        position: 0,
        configPosition: -1,
        reason: 'explicitly requested by caller',
      }
      seen.add(model.id)
    }
  }

  // 2. Primary model from config
  if (primary !== undefined) {
    tryAdd(primary, 'primary model from OpenClaw config')
  }

  // 3. Fallbacks from config (in declared order)
  for (const ref of fallbacks) {
    tryAdd(ref, 'fallback from OpenClaw config')
  }

  // 4. Any other resolvable model as last resort
  for (const model of registry.resolvable()) {
    if (selfRef !== undefined && model.id === selfRef) continue
    if (!seen.has(model.id)) {
      seen.add(model.id)
      configCandidates.push({
        model,
        position: configCandidates.length,
        configPosition: configCandidates.length,
        reason: 'last-resort candidate',
      })
    }
  }

  // Phase 2: rank the config candidates by tier score
  // The position field reflects config order and is used as the tiebreaker base score
  const modelTiers = routerConfig?.modelTiers
  const ranked = rankCandidates(configCandidates, tier, modelTiers)

  // Phase 3: apply tierPriority overrides — listed models are always first
  const priorityList = routerConfig?.tierPriority?.[tier] ?? []
  const reordered = applyTierPriority(ranked, priorityList)

  // Re-assign positions after final ordering
  const reranked = reordered.map((c, i) => ({ ...c, position: i }))

  // Prepend explicit model if present (always wins position 0)
  if (explicitCandidate !== undefined) {
    return [explicitCandidate, ...reranked.map((c, i) => ({ ...c, position: i + 1 }))]
  }

  return reranked
}

/**
 * Reorder candidates so that models listed in `priority` come first (in order),
 * followed by remaining candidates in their existing order.
 */
function applyTierPriority<T extends { model: { id: string } }>(
  candidates: T[],
  priority: string[],
): T[] {
  if (priority.length === 0) return candidates
  const prioritySet = new Set(priority)
  const prioritized = priority
    .map((id) => candidates.find((c) => c.model.id === id))
    .filter((c): c is T => c !== undefined)
  const rest = candidates.filter((c) => !prioritySet.has(c.model.id))
  return [...prioritized, ...rest]
}
