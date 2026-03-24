import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import type { NormalizedModel } from '../../src/providers/types.js'
import type { RawConfig } from '../../src/config/schema.js'

const { callOpenAIMock } = vi.hoisted(() => ({
  callOpenAIMock: vi.fn(),
}))

vi.mock('../../src/adapters/openai-completions.js', () => ({
  callOpenAI: callOpenAIMock,
}))

vi.mock('../../src/adapters/anthropic-messages.js', () => ({
  callAnthropic: vi.fn(),
}))

function makeModel(id: string, inputCost: number, outputCost: number): NormalizedModel {
  return {
    id,
    providerId: id.split('/')[0] ?? 'provider',
    modelId: id.split('/').slice(1).join('/'),
    name: id,
    api: 'openai-completions',
    baseUrl: 'https://example.com',
    apiKeyResolution: { status: 'resolved', key: 'test-key' },
    reasoning: false,
    supportsImages: false,
    contextWindow: 128000,
    maxTokens: 4096,
    cost: {
      input: inputCost,
      output: outputCost,
    },
  }
}

const config: RawConfig = {
  agents: {
    defaults: {
      model: {
        primary: 'test-provider/cheap-model',
        fallbacks: ['test-provider/expensive-model'],
      },
    },
  },
}

const app = buildApp({
  config,
  registry: new ProviderRegistry([
    makeModel('test-provider/cheap-model', 0.5, 2),
    makeModel('test-provider/expensive-model', 3, 12),
  ]),
  routerConfig: {
    dashboard: {
      baselineModel: 'test-provider/expensive-model',
      refreshSeconds: 9,
    },
  },
  logLevel: 'silent',
  decisionLogEnabled: false,
})

describe('dashboard and stats integration', () => {
  beforeEach(() => {
    callOpenAIMock.mockReset()
    callOpenAIMock.mockImplementation(async (model: NormalizedModel) => ({
      body: {
        id: 'chatcmpl-dashboard',
        object: 'chat.completion',
        created: 1700000000,
        model: model.modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Dashboard ready' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000 },
      },
      statusCode: 200,
      headers: {},
      streaming: false,
    }))
  })

  beforeAll(() => app.ready())
  afterAll(() => app.close())

  it('surfaces estimated spend, savings, and the live dashboard page', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    })

    expect(response.statusCode).toBe(200)

    const statsResponse = await app.inject({ method: 'GET', url: '/stats' })
    expect(statsResponse.statusCode).toBe(200)
    expect(statsResponse.json().costSummary).toMatchObject({
      baselineModelId: 'test-provider/expensive-model',
      meteredRequests: 1,
    })
    expect(statsResponse.json().costSummary.estimatedCostUsd).toBeGreaterThan(0)
    expect(statsResponse.json().costSummary.estimatedSavingsUsd).toBeGreaterThan(0)

    const dashboardResponse = await app.inject({ method: 'GET', url: '/dashboard' })
    expect(dashboardResponse.statusCode).toBe(200)
    expect(dashboardResponse.body).toContain('Auto-refresh every 9s')
    expect(dashboardResponse.body).toContain('Estimated Spend')
    expect(dashboardResponse.body).toContain('Provider Usage')
    expect(dashboardResponse.body).toContain('test-provider/cheap-model')
  })
})
