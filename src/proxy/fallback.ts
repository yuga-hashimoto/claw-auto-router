import type { RouteResult } from '../router/types.js'
import type { AdapterRequest } from '../adapters/types.js'
import type { ProxyAttempt, ProxyResult } from './types.js'
import { executeOne, isRetryable } from './executor.js'
import { AllProvidersFailed } from '../utils/errors.js'

export interface FallbackOptions {
  timeoutMs: number
  onAttempt?: (attempt: ProxyAttempt) => void
}

/**
 * Execute the routing result with fallback support.
 *
 * Tries winner first, then each fallback in order.
 * Stops on first success or non-retryable error.
 * Throws AllProvidersFailed if all candidates are exhausted.
 */
export async function executeWithFallback(
  routeResult: RouteResult,
  request: AdapterRequest,
  options: FallbackOptions,
): Promise<ProxyResult> {
  const candidates = [routeResult.winner, ...routeResult.fallbacks]
  const allAttempts: ProxyAttempt[] = []

  for (const candidate of candidates) {
    const { attempt, result } = await executeOne(candidate.model, request, options.timeoutMs)
    allAttempts.push(attempt)
    options.onAttempt?.(attempt)

    if (result !== undefined) {
      return { ...result, attempts: allAttempts }
    }

    // Non-retryable errors stop the fallback chain (e.g. 400 bad request = caller's fault)
    if (!isRetryable(attempt)) {
      throw new AllProvidersFailed(allAttempts)
    }

    // Continue to next fallback
  }

  throw new AllProvidersFailed(allAttempts)
}
