import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../../src/server/app.js'
import { readDecisionLogEntries } from '../../src/decision-log.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import type { NormalizedModel } from '../../src/providers/types.js'
import type { RawConfig } from '../../src/config/schema.js'

const { callOpenClawGatewayMock } = vi.hoisted(() => ({
  callOpenClawGatewayMock: vi.fn(),
}))

// Mock the gateway adapter so we don't hit real network
vi.mock('../../src/adapters/openclaw-gateway.js', () => ({
  callOpenClawGateway: callOpenClawGatewayMock,
}))

const makeModel = (id: string, overrides: Partial<NormalizedModel> = {}): NormalizedModel => ({
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
  ...overrides,
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

const app = buildApp({ config, registry, logLevel: 'silent', decisionLogEnabled: false })

describe('POST /v1/chat/completions', () => {
  beforeEach(() => {
    callOpenClawGatewayMock.mockReset()

    callOpenClawGatewayMock.mockImplementation(async (model: NormalizedModel, request: { thinking?: unknown }) => ({
      body: {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1700000000,
        model: model.modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: request.thinking !== undefined ? 'Thinking applied' : 'Hello!',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      statusCode: 200,
      headers: {},
      streaming: false,
    }))
  })

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

  it('captures conversation-level model override commands and applies them to later auto-routed requests', async () => {
    const control = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'conversation-1' },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'use fallback model' }],
      },
    })

    expect(control.statusCode).toBe(200)
    expect(control.json().choices[0].message.content).toContain('Routing locked to model test-provider/fallback-model.')
    expect(callOpenClawGatewayMock).not.toHaveBeenCalled()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-session-id': 'conversation-1' },
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello again' }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect((callOpenClawGatewayMock.mock.calls.at(-1)?.[0] as NormalizedModel | undefined)?.id).toBe(
      'test-provider/fallback-model',
    )

    const statsResponse = await app.inject({ method: 'GET', url: '/stats' })
    expect(statsResponse.statusCode).toBe(200)
    expect(statsResponse.json().sessionStats.recentOverrides[0].explicitModelId).toBe(
      'test-provider/fallback-model',
    )
  })

  it('captures conversation-level thinking commands and forwards them to anthropic models', async () => {
    const anthropicConfig: RawConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'anthropic/claude-sonnet-4-6',
            fallbacks: [],
          },
        },
      },
    }

    const anthropicRegistry = new ProviderRegistry([
      makeModel('anthropic/claude-sonnet-4-6', {
        api: 'anthropic-messages',
        reasoning: true,
      }),
    ])

    const anthropicApp = buildApp({
      config: anthropicConfig,
      registry: anthropicRegistry,
      logLevel: 'silent',
      decisionLogEnabled: false,
    })

    await anthropicApp.ready()

    try {
      const control = await anthropicApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'x-session-id': 'conversation-2' },
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'thinking high' }],
        },
      })

      expect(control.statusCode).toBe(200)
      expect(control.json().choices[0].message.content).toContain('Thinking override updated')

      const response = await anthropicApp.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'x-session-id': 'conversation-2' },
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: 'Please solve this carefully.' }],
        },
      })

      expect(response.statusCode).toBe(200)
      expect(callOpenClawGatewayMock.mock.calls).toHaveLength(1)
      const gatewayRequest = callOpenClawGatewayMock.mock.calls[0]?.[1] as
        | { thinking?: { effort?: string; source?: string } }
        | undefined
      expect(gatewayRequest?.thinking).toMatchObject({
        effort: 'high',
        source: 'session',
      })
    } finally {
      await anthropicApp.close()
    }
  })

  it('writes a routing decision log entry when enabled', async () => {
    const tempDir = join(tmpdir(), `chat-log-test-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const configPath = join(tempDir, 'moltbot.json')
    writeFileSync(configPath, '{}\n', 'utf-8')

    const loggingApp = buildApp({
      config,
      registry,
      configPath,
      logLevel: 'silent',
      decisionLogEnabled: true,
    })
    await loggingApp.ready()

    const response = await loggingApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'auto',
        messages: [{ role: 'user', content: 'Please refactor this function.' }],
      },
    })

    expect(response.statusCode).toBe(200)

    const entries = readDecisionLogEntries(5, configPath)
    expect(entries[0]?.classification.tier).toBe('CODE')
    expect(entries[0]?.classification.lastUserMessage).toContain('Please refactor this function.')
    expect(entries[0]?.candidates[0]?.modelId).toBe('test-provider/primary-model')
    expect(entries[0]?.attempts[0]?.modelId).toBe('test-provider/primary-model')

    await loggingApp.close()
    rmSync(tempDir, { recursive: true, force: true })
  })
})
