import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { NormalizedModel } from '../../../src/providers/types.js'

const spawn = vi.fn()

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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('forwards thinking overrides as OpenClaw thinking levels', async () => {
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
    expect(spawn).toHaveBeenCalledTimes(1)
    const args = spawn.mock.calls[0]?.[1] as string[]
    expect(args).toBeDefined()
    const paramsIndex = args.indexOf('--params')
    expect(paramsIndex).toBeGreaterThanOrEqual(0)
    const params = JSON.parse(args[paramsIndex + 1] ?? '{}') as Record<string, unknown>
    expect(params['thinking']).toBe('high')
  })

  it('omits thinking when no override is provided', async () => {
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
      child.stdout.emit('data', '{"runId":"router_test","result":{"payloads":[{"text":"OK"}]}}')
      child.emit('close', 0)
    })

    await promise

    const args = spawn.mock.calls[0]?.[1] as string[]
    const paramsIndex = args.indexOf('--params')
    const params = JSON.parse(args[paramsIndex + 1] ?? '{}') as Record<string, unknown>
    expect(params).not.toHaveProperty('thinking')
  })
})
