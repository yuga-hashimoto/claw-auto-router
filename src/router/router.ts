import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { RoutingRequest, RouteResult } from './types.js'
import { classifyRequest } from './classifier.js'
import { buildCandidateChain } from './chain-builder.js'
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
  const tier = classifyRequest(request)
  const candidates = buildCandidateChain(request.model, config, registry, tier, routerConfig)

  if (candidates.length === 0) {
    throw new NoCandidatesError(request.model)
  }

  const [winner, ...fallbacks] = candidates

  if (winner === undefined) {
    throw new NoCandidatesError(request.model)
  }

  return { winner, fallbacks, tier }
}
