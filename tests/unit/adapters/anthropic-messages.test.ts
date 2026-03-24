import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedModel } from '../../../src/providers/types.js'

const { fetchMock, resolveModelCredentialsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolveModelCredentialsMock: vi.fn(),
}))

vi.mock('undici', () => ({
  fetch: fetchMock,
}))

vi.mock('../../../src/providers/oauth.js', () => ({
  resolveModelCredentials: resolveModelCredentialsMock,
}))

import { callAnthropic } from '../../../src/adapters/anthropic-messages.js'

const adaptiveModel: NormalizedModel = {
  id: 'anthropic/claude-sonnet-4-6',
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  apiKeyResolution: { status: 'resolved', key: 'anthropic-key' },
  reasoning: true,
  supportsImages: true,
  contextWindow: 200000,
  maxTokens: 64000,
}

const classicModel: NormalizedModel = {
  ...adaptiveModel,
  id: 'anthropic/claude-sonnet-4-5',
  modelId: 'claude-sonnet-4-5-20250929',
  name: 'Claude Sonnet 4.5',
}

describe('callAnthropic', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveModelCredentialsMock.mockReset()
    resolveModelCredentialsMock.mockResolvedValue({
      secret: 'anthropic-api-key',
    })
  })

  it('uses adaptive thinking for Claude 4.6 models and extracts text content after thinking blocks', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      json: async () => ({
        id: 'msg_123',
        model: 'claude-sonnet-4-6',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'Final answer' },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      }),
    })

    const result = await callAnthropic(
      adaptiveModel,
      {
        model: adaptiveModel.modelId,
        messages: [{ role: 'user', content: 'Solve this carefully.' }],
        stream: false,
        temperature: 0.2,
        thinking: { type: 'enabled', effort: 'high', budgetTokens: 8192 },
      },
      30_000,
    )

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(options.body))

    expect(body).toMatchObject({
      model: 'claude-sonnet-4-6',
      thinking: { type: 'adaptive', effort: 'high' },
    })
    expect(body).not.toHaveProperty('temperature')
    expect(result.body.choices[0].message.content).toBe('Final answer')
  })

  it('uses enabled thinking budgets and the interleaved beta header for earlier Claude models', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      json: async () => ({
        id: 'msg_456',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input_tokens: 12, output_tokens: 6 },
      }),
    })

    await callAnthropic(
      classicModel,
      {
        model: classicModel.modelId,
        messages: [{ role: 'user', content: 'Think out loud.' }],
        stream: false,
        maxTokens: 6000,
        thinking: { type: 'enabled', budgetTokens: 5000, interleaved: true },
      },
      30_000,
    )

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(options.body))

    expect(options.headers).toMatchObject({
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    })
    expect(body).toMatchObject({
      thinking: { type: 'enabled', budget_tokens: 5000 },
      max_tokens: 6000,
    })
  })
})
