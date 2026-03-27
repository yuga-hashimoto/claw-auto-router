import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { NormalizedModel } from '../../../src/providers/types.js'

const spawn = vi.fn()
const fetchMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn,
}))

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

const model: NormalizedModel = {
  id: 'zai/glm-4.7',
  providerId: 'zai',
  modelId: 'glm-4.7',
  name: 'GLM-4.7',
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'test-key' },
  reasoning: true,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 8192,
}

describe('callOpenClawGateway', () => {
  beforeEach(() => {
    spawn.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the OpenClaw Gateway HTTP endpoint for standard requests', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          model: 'openclaw/main',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )

    const { callOpenClawGateway } = await import('../../../src/adapters/openclaw-gateway.js')
    const response = await callOpenClawGateway(
      model,
      {
        messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
        model: model.modelId,
        stream: false,
        maxTokens: 64,
        temperature: 0,
        extra: { top_p: 0.9 },
      },
      5_000,
      {
        available: true,
        agentId: 'main',
        url: 'ws://127.0.0.1:18789',
        token: 'token-value',
        password: 'password-value',
        warnings: [],
      },
    )

    expect(response.statusCode).toBe(200)
    expect(response.streaming).toBe(false)
    expect(response.body.choices[0].message.content).toBe('OK')
    expect(spawn).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:18789/v1/chat/completions')
    expect((init.headers as Record<string, string>)['x-openclaw-model']).toBe('zai/glm-4.7')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer password-value')

    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'openclaw/main',
      stream: false,
      max_tokens: 64,
      temperature: 0,
      top_p: 0.9,
    })
    expect(body.messages).toEqual([{ role: 'user', content: 'Reply with exactly OK.' }])
  })

  it('falls back to the agent bridge when thinking overrides are present', async () => {
    const child = new MockChildProcess()
    spawn.mockReturnValue(child)

    const { callOpenClawGateway } = await import('../../../src/adapters/openclaw-gateway.js')
    const promise = callOpenClawGateway(
      model,
      {
        messages: [{ role: 'user', content: 'Please think carefully.' }],
        model: model.modelId,
        stream: false,
        thinking: { type: 'enabled', effort: 'high', budgetTokens: 8192, source: 'request' },
      },
      5_000,
      {
        available: true,
        agentId: 'main',
        url: 'ws://127.0.0.1:18789',
        warnings: [],
      },
    )

    process.nextTick(() => {
      child.stdout.emit('data', '{"runId":"router_test","result":{"payloads":[{"text":"OK"}]}}')
      child.emit('close', 0)
    })

    const response = await promise

    expect(response.statusCode).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = spawn.mock.calls[0]?.[1] as string[]
    const paramsIndex = args.indexOf('--params')
    const params = JSON.parse(args[paramsIndex + 1] ?? '{}') as Record<string, unknown>
    expect(params['thinking']).toBe('high')
  })

  it('falls back to the agent bridge when the gateway HTTP endpoint is disabled', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Not Found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const child = new MockChildProcess()
    spawn.mockReturnValue(child)

    const { callOpenClawGateway } = await import('../../../src/adapters/openclaw-gateway.js')
    const promise = callOpenClawGateway(
      model,
      {
        messages: [{ role: 'user', content: 'Hello' }],
        model: model.modelId,
        stream: false,
      },
      5_000,
      {
        available: true,
        agentId: 'main',
        url: 'ws://127.0.0.1:18789',
        warnings: [],
      },
    )

    process.nextTick(() => {
      child.stdout.emit('data', '{"runId":"router_test","result":{"payloads":[{"text":"Fallback OK"}]}}')
      child.emit('close', 0)
    })

    const response = await promise

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(response.body.choices[0].message.content).toBe('Fallback OK')
  })
})
