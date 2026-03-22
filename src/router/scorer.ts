import type { NormalizedModel } from '../providers/types.js'
import type { RoutingTier } from './types.js'

/** Keywords that suggest a model is fast/cheap/small */
const SMALL_MODEL_RE = /\b(flash|mini|small|micro|lite|fast|light|haiku|turbo)\b/i

/** Keywords that suggest a model specializes in coding */
const CODER_MODEL_RE = /\b(cod(er|ing|e)|devstral|deepseek|starcoder|phind)\b/i

/**
 * Score a model candidate for a given tier and config position.
 *
 * Returns a higher number = better match for the given tier.
 * Config position (0 = primary) provides the base ordering from OpenClaw config,
 * which tier-specific bonuses can override.
 *
 * Explicit tier assignments (modelTiers) always override heuristic scoring:
 *   - Model assigned to this tier     → +500 (always wins among unassigned)
 *   - Model assigned to another tier  → -500 (pushed to bottom, still usable as fallback)
 *   - No assignment                   → heuristic scoring below
 *
 * Heuristic design goals:
 *   CODE    → prefer reasoning=true, prefer coders, penalize tiny models
 *   COMPLEX → prefer reasoning=true, prefer large context window, penalize small models
 *   SIMPLE  → prefer small/fast models, penalize heavyweight reasoning models
 *   STANDARD→ pure config order (no bonuses)
 */
export function scoreCandidate(
  model: NormalizedModel,
  tier: RoutingTier,
  configPosition: number,
  modelTiers?: Record<string, RoutingTier>,
): number {
  // Explicit tier assignment overrides heuristics
  const assignedTier = modelTiers?.[model.id]
  if (assignedTier !== undefined) {
    if (assignedTier === tier) {
      return 500 + (100 - configPosition) // explicit match: always wins
    } else {
      return -500 + (100 - configPosition) // wrong tier: pushed to bottom but kept as fallback
    }
  }

  // Heuristic scoring for unassigned models
  // Base score: position in config (primary gets 100, fallback[0] gets 99, etc.)
  const base = 100 - configPosition
  let bonus = 0

  const nameMatches = (re: RegExp): boolean =>
    re.test(model.name) || re.test(model.modelId)

  switch (tier) {
    case 'CODE':
      if (model.reasoning) bonus += 30
      if (nameMatches(CODER_MODEL_RE)) bonus += 25
      if (nameMatches(SMALL_MODEL_RE)) bonus -= 10 // small models for code tend to be weaker
      break

    case 'COMPLEX':
      if (model.reasoning) bonus += 25
      if (model.contextWindow >= 200_000) bonus += 20
      else if (model.contextWindow >= 100_000) bonus += 10
      if (nameMatches(SMALL_MODEL_RE)) bonus -= 15 // complex tasks need full-power models
      break

    case 'SIMPLE':
      if (nameMatches(SMALL_MODEL_RE)) bonus += 25 // fast/cheap is fine for simple tasks
      if (model.reasoning) bonus -= 10 // reasoning overhead not needed
      if (model.contextWindow >= 200_000) bonus -= 5 // overkill
      break

    case 'STANDARD':
      // No bonuses — respect pure config order
      break
  }

  return base + bonus
}

/** Score and sort candidates for a given tier (highest score first) */
export function rankCandidates<T extends { model: NormalizedModel; position: number }>(
  candidates: T[],
  tier: RoutingTier,
  modelTiers?: Record<string, RoutingTier>,
): T[] {
  return [...candidates].sort(
    (a, b) =>
      scoreCandidate(b.model, tier, b.position, modelTiers) -
      scoreCandidate(a.model, tier, a.position, modelTiers),
  )
}
