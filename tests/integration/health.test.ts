import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import type { NormalizedModel } from '../../src/providers/types.js'

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

const registry = new ProviderRegistry([makeModel('test-provider/test-model')])

const app = buildApp({
  config: {},
  registry,
  logLevel: 'silent',
  decisionLogEnabled: false,
})

describe('GET /health', () => {
  beforeAll(() => app.ready())
  afterAll(() => app.close())

  it('returns 200 with status ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(body.models.resolvable).toBe(1)
  })
})
