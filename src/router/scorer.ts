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
  return explainCandidateScore(model, tier, configPosition, modelTiers).score
}

export function explainCandidateScore(
  model: NormalizedModel,
  tier: RoutingTier,
  configPosition: number,
  modelTiers?: Record<string, RoutingTier>,
): { score: number; reasons: string[] } {
  // Explicit tier assignment overrides heuristics
  const assignedTier = modelTiers?.[model.id]
  if (assignedTier !== undefined) {
    if (assignedTier === tier) {
      return {
        score: 500 + (100 - configPosition),
        reasons: [
          `Explicit tier assignment matches ${tier}`,
          `Config order base score ${100 - configPosition}`,
        ],
      }
    } else {
      return {
        score: -500 + (100 - configPosition),
        reasons: [
          `Explicit tier assignment prefers ${assignedTier}, so this model is deprioritized for ${tier}`,
          `Config order base score ${100 - configPosition}`,
        ],
      }
    }
  }

  // Heuristic scoring for unassigned models
  // Base score: position in config (primary gets 100, fallback[0] gets 99, etc.)
  const base = 100 - configPosition
  let bonus = 0
  const reasons = [`Config order base score ${base}`]

  const nameMatches = (re: RegExp): boolean =>
    re.test(model.name) || re.test(model.modelId)

  switch (tier) {
    case 'CODE':
      if (model.reasoning) {
        bonus += 30
        reasons.push('+30 reasoning model bonus for CODE')
      }
      if (nameMatches(CODER_MODEL_RE)) {
        bonus += 25
        reasons.push('+25 coder-model keyword bonus for CODE')
      }
      if (nameMatches(SMALL_MODEL_RE)) {
        bonus -= 10
        reasons.push('-10 small/fast model penalty for CODE')
      }
      break

    case 'COMPLEX':
      if (model.reasoning) {
        bonus += 25
        reasons.push('+25 reasoning model bonus for COMPLEX')
      }
      if (model.contextWindow >= 200_000) {
        bonus += 20
        reasons.push('+20 very large context window bonus for COMPLEX')
      } else if (model.contextWindow >= 100_000) {
        bonus += 10
        reasons.push('+10 large context window bonus for COMPLEX')
      }
      if (nameMatches(SMALL_MODEL_RE)) {
        bonus -= 15
        reasons.push('-15 small/fast model penalty for COMPLEX')
      }
      break

    case 'SIMPLE':
      if (nameMatches(SMALL_MODEL_RE)) {
        bonus += 25
        reasons.push('+25 fast/small model bonus for SIMPLE')
      }
      if (model.reasoning) {
        bonus -= 10
        reasons.push('-10 reasoning overhead penalty for SIMPLE')
      }
      if (model.contextWindow >= 200_000) {
        bonus -= 5
        reasons.push('-5 oversized context penalty for SIMPLE')
      }
      break

    case 'STANDARD':
      reasons.push('STANDARD keeps pure config order without heuristic bonuses')
      break
  }

  if (bonus === 0 && tier !== 'STANDARD') {
    reasons.push('No tier-specific bonuses or penalties applied')
  }

  return { score: base + bonus, reasons }
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
