import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { RoutingRequest, RouteResult } from './types.js'
import { classifyRequestDetailed } from './classifier.js'
import { buildCandidateChain } from './chain-builder.js'
import { explainCandidateScore } from './scorer.js'
import { NoCandidatesError } from '../utils/errors.js'

/**
 * Route a request to the best available model.
 *
 * v2 algorithm:
 *   1. Classify request into SIMPLE | STANDARD | COMPLEX | CODE
 *   2. Build candidate pool from config (primary → fallbacks → last-resort)
 *   3. Score and rank candidates by tier heuristics (reasoning, context window, model name)
 *   4. Return winner (highest score) + remaining as ordered fallbacks
 *
 * Explicit model requests always bypass scoring and go to position 0.
 */
export function route(
  request: RoutingRequest,
  config: RawConfig,
  registry: ProviderRegistry,
  routerConfig?: RouterConfig,
): RouteResult {
  const classification = classifyRequestDetailed(request)
  const candidates = buildCandidateChain(request.model, config, registry, classification.tier, routerConfig)

  if (candidates.length === 0) {
    throw new NoCandidatesError(request.model)
  }

  const [winner, ...fallbacks] = candidates

  if (winner === undefined) {
    throw new NoCandidatesError(request.model)
  }

  const decision = {
    requestedModel: request.model,
    classification,
    candidates: candidates.map((candidate) => {
      const explicit = candidate.reason === 'explicitly requested by caller'
      const scoreExplanation = explicit
        ? {
            score: undefined,
            reasons: ['Explicit model request bypassed routing heuristics'],
          }
        : explainCandidateScore(
            candidate.model,
            classification.tier,
            candidate.configPosition,
            routerConfig?.modelTiers,
          )

      return {
        modelId: candidate.model.id,
        modelName: candidate.model.name,
        finalPosition: candidate.position,
        configPosition: candidate.configPosition,
        sourceReason: candidate.reason,
        ...(scoreExplanation.score !== undefined ? { score: scoreExplanation.score } : {}),
        scoreReasons: scoreExplanation.reasons,
        explicit,
        ...(candidate.model.transport !== undefined ? { transport: candidate.model.transport } : {}),
      }
    }),
  }

  return { winner, fallbacks, tier: classification.tier, decision }
}
