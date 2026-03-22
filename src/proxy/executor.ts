import type { NormalizedModel } from '../providers/types.js'
import type { AdapterRequest } from '../adapters/types.js'
import type { ProxyAttempt, ProxyResult } from './types.js'
import { callOpenAI } from '../adapters/openai-completions.js'
import { callAnthropic } from '../adapters/anthropic-messages.js'
import { callOpenAICodexResponses } from '../adapters/openai-codex-responses.js'
import { callGoogleGeminiCli } from '../adapters/google-gemini-cli.js'
import { callOpenClawGateway } from '../adapters/openclaw-gateway.js'

/** HTTP status codes that should trigger a fallback retry */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

export interface ExecuteResult {
  attempt: ProxyAttempt
  result?: ProxyResult
}

/**
 * Execute a single provider attempt.
 * Returns the attempt record and result on success, or just the attempt on failure.
 */
export async function executeOne(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
): Promise<ExecuteResult> {
  const start = Date.now()

  try {
    const adapterResponse =
      model.transport === 'openclaw-gateway'
        ? await callOpenClawGateway(model, request, timeoutMs, request.openClawGateway)
        : model.api === 'anthropic-messages'
        ? await callAnthropic(model, request, timeoutMs)
        : model.api === 'openai-codex-responses'
          ? await callOpenAICodexResponses(model, request, timeoutMs)
          : model.api === 'google-gemini-cli'
            ? await callGoogleGeminiCli(model, request, timeoutMs)
            : await callOpenAI(model, request, timeoutMs)

    const durationMs = Date.now() - start

    const isSuccess = adapterResponse.statusCode >= 200 && adapterResponse.statusCode < 300

    if (!isSuccess) {
      return {
        attempt: {
          model,
          durationMs,
          success: false,
          statusCode: adapterResponse.statusCode,
          error: `HTTP ${adapterResponse.statusCode}`,
        },
      }
    }

    return {
      attempt: {
        model,
        durationMs,
        success: true,
        statusCode: adapterResponse.statusCode,
      },
      result: {
        response: adapterResponse.body,
        attempts: [], // populated by fallback executor
        finalModel: model,
        streaming: adapterResponse.streaming,
        // Pass stream through on the result object if present
        ...( adapterResponse.stream !== undefined ? { stream: adapterResponse.stream } : {}),
      },
    }
  } catch (err) {
    const durationMs = Date.now() - start
    const isTimeout = err instanceof Error && err.name === 'AbortError'
    return {
      attempt: {
        model,
        durationMs,
        success: false,
        error: isTimeout ? 'Request timed out' : String(err),
      },
    }
  }
}

/** Whether a failed attempt should trigger a fallback */
export function isRetryable(attempt: ProxyAttempt): boolean {
  if (attempt.success) return false
  if (attempt.statusCode === undefined) return true // network error
  return RETRYABLE_STATUS_CODES.has(attempt.statusCode)
}
