import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import type { NormalizedModel } from '../../src/providers/types.js'
import type { RawConfig } from '../../src/config/schema.js'

// Mock the adapters so we don't hit real network
vi.mock('../../src/adapters/openai-completions.js', () => ({
  callOpenAI: vi.fn().mockResolvedValue({
    body: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1700000000,
      model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    statusCode: 200,
    headers: {},
    streaming: false,
  }),
}))

vi.mock('../../src/adapters/anthropic-messages.js', () => ({
  callAnthropic: vi.fn(),
}))

const makeModel = (id: string): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'p',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'test-key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
})

const config: RawConfig = {
  agents: {
    defaults: {
      model: {
        primary: 'test-provider/primary-model',
        fallbacks: ['test-provider/fallback-model'],
      },
    },
  },
}

const registry = new ProviderRegistry([
  makeModel('test-provider/primary-model'),
  makeModel('test-provider/fallback-model'),
])

const app = buildApp({ config, registry, logLevel: 'silent' })

describe('POST /v1/chat/completions', () => {
  beforeAll(() => app.ready())
  afterAll(() => app.close())

  it('routes auto model to primary and returns OpenAI-compatible response', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.object).toBe('chat.completion')
    expect(body.choices).toHaveLength(1)
    expect(body.choices[0].message.content).toBe('Hello!')
  })

  it('returns 400 for missing messages', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('returns 400 for empty messages array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'auto', messages: [] },
    })
    expect(response.statusCode).toBe(400)
  })

  it('routes explicit model correctly', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'test-provider/fallback-model',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    })
    expect(response.statusCode).toBe(200)
  })
})
