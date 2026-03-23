import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeWithFallback } from '../../../src/proxy/fallback.js'
import { AllProvidersFailed } from '../../../src/utils/errors.js'
import type { NormalizedModel } from '../../../src/providers/types.js'
import type { RouteResult } from '../../../src/router/types.js'
import type { AdapterRequest } from '../../../src/adapters/types.js'

// Mock the executor module
vi.mock('../../../src/proxy/executor.js', () => ({
  executeOne: vi.fn(),
  isRetryable: vi.fn(),
}))

import { executeOne, isRetryable } from '../../../src/proxy/executor.js'

const makeModel = (id: string): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'p',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
})

const model1 = makeModel('kimi-coding/k2p5')
const model2 = makeModel('nvidia/qwen/model')

const routeResult: RouteResult = {
  winner: { model: model1, position: 0, configPosition: 0, reason: 'primary' },
  fallbacks: [{ model: model2, position: 1, configPosition: 1, reason: 'fallback' }],
  tier: 'STANDARD',
}

const adapterRequest: AdapterRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  model: 'kimi-coding/k2p5',
  stream: false,
}

describe('executeWithFallback', () => {
  const mockExecuteOne = vi.mocked(executeOne)
  const mockIsRetryable = vi.mocked(isRetryable)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns result from winner on first success', async () => {
    const successResult = {
      response: { choices: [] },
      attempts: [],
      finalModel: model1,
      streaming: false,
    }
    mockExecuteOne.mockResolvedValueOnce({
      attempt: { model: model1, durationMs: 100, success: true, statusCode: 200 },
      result: successResult,
    })

    const result = await executeWithFallback(routeResult, adapterRequest, { timeoutMs: 5000 })
    expect(result.finalModel.id).toBe('kimi-coding/k2p5')
    expect(result.attempts).toHaveLength(1)
  })

  it('falls back to second model when first fails with retryable error', async () => {
    const failAttempt = { model: model1, durationMs: 100, success: false, statusCode: 503 }
    const successResult = {
      response: { choices: [] },
      attempts: [],
      finalModel: model2,
      streaming: false,
    }

    mockExecuteOne
      .mockResolvedValueOnce({ attempt: failAttempt })
      .mockResolvedValueOnce({
        attempt: { model: model2, durationMs: 200, success: true, statusCode: 200 },
        result: successResult,
      })

    mockIsRetryable.mockReturnValueOnce(true)

    const result = await executeWithFallback(routeResult, adapterRequest, { timeoutMs: 5000 })
    expect(result.finalModel.id).toBe('nvidia/qwen/model')
    expect(result.attempts).toHaveLength(2)
  })

  it('throws AllProvidersFailed when all candidates fail', async () => {
    const failAttempt1 = { model: model1, durationMs: 100, success: false, statusCode: 503 }
    const failAttempt2 = { model: model2, durationMs: 100, success: false, statusCode: 503 }

    mockExecuteOne
      .mockResolvedValueOnce({ attempt: failAttempt1 })
      .mockResolvedValueOnce({ attempt: failAttempt2 })

    mockIsRetryable.mockReturnValue(true)

    await expect(
      executeWithFallback(routeResult, adapterRequest, { timeoutMs: 5000 }),
    ).rejects.toThrow(AllProvidersFailed)
  })

  it('stops fallback on non-retryable error', async () => {
    const failAttempt = { model: model1, durationMs: 100, success: false, statusCode: 400 }

    mockExecuteOne.mockResolvedValueOnce({ attempt: failAttempt })
    mockIsRetryable.mockReturnValueOnce(false)

    await expect(
      executeWithFallback(routeResult, adapterRequest, { timeoutMs: 5000 }),
    ).rejects.toThrow(AllProvidersFailed)

    expect(mockExecuteOne).toHaveBeenCalledTimes(1)
  })

  it('calls onAttempt callback for each attempt', async () => {
    const onAttempt = vi.fn()
    const successResult = {
      response: {},
      attempts: [],
      finalModel: model1,
      streaming: false,
    }
    mockExecuteOne.mockResolvedValueOnce({
      attempt: { model: model1, durationMs: 100, success: true },
      result: successResult,
    })

    await executeWithFallback(routeResult, adapterRequest, { timeoutMs: 5000, onAttempt })
    expect(onAttempt).toHaveBeenCalledTimes(1)
  })
})
