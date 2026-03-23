import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveClassificationDetail } from '../../../src/router/classifier-resolver.js'
import { ProviderRegistry } from '../../../src/providers/registry.js'
import type { NormalizedModel } from '../../../src/providers/types.js'

vi.mock('../../../src/proxy/executor.js', () => ({
  executeOne: vi.fn(),
}))

import { executeOne } from '../../../src/proxy/executor.js'

const makeModel = (id: string): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'provider',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com/v1',
  apiKeyResolution: { status: 'resolved', key: 'test-key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 8192,
})

describe('resolveClassificationDetail', () => {
  const mockExecuteOne = vi.mocked(executeOne)
  const classifierModel = makeModel('google/gemini-3-flash-preview')
  const registry = new ProviderRegistry([classifierModel])

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses heuristics when RouterAI is disabled', async () => {
    const detail = await resolveClassificationDetail({
      request: { messages: [{ role: 'user', content: 'Hello there' }] },
      registry,
      routerConfig: {},
    })

    expect(detail.mode).toBe('heuristic')
    expect(detail.tier).toBe('SIMPLE')
    expect(mockExecuteOne).not.toHaveBeenCalled()
  })

  it('uses RouterAI when configured and the classifier returns valid JSON', async () => {
    mockExecuteOne.mockResolvedValueOnce({
      attempt: { model: classifierModel, durationMs: 120, success: true, statusCode: 200 },
      result: {
        response: {
          choices: [
            {
              message: {
                content: '{"tier":"CODE","reason":"The user asked for a refactor."}',
              },
            },
          ],
        },
        attempts: [],
        finalModel: classifierModel,
        streaming: false,
      },
    })

    const detail = await resolveClassificationDetail({
      request: { messages: [{ role: 'user', content: 'Please refactor this function for me' }] },
      registry,
      routerConfig: {
        routerAI: {
          mode: 'ai',
          model: classifierModel.id,
          timeoutMs: 4000,
        },
      },
    })

    expect(detail.mode).toBe('ai')
    expect(detail.tier).toBe('CODE')
    expect(detail.classifierModelId).toBe(classifierModel.id)
    expect(detail.reasons[0]).toContain(classifierModel.id)
  })

  it('falls back to heuristics when RouterAI fails', async () => {
    mockExecuteOne.mockResolvedValueOnce({
      attempt: {
        model: classifierModel,
        durationMs: 500,
        success: false,
        statusCode: 503,
      },
    })

    const detail = await resolveClassificationDetail({
      request: { messages: [{ role: 'user', content: 'Compare these two system designs' }] },
      registry,
      routerConfig: {
        routerAI: {
          mode: 'ai',
          model: classifierModel.id,
          timeoutMs: 4000,
        },
      },
    })

    expect(detail.mode).toBe('heuristic')
    expect(detail.tier).toBe('COMPLEX')
    expect(detail.reasons[0]).toContain('RouterAI classification failed')
  })
})
