import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'
import type { NormalizedModel } from '../../src/providers/types.js'

const makeModel = (id: string, resolved = true): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'p',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: resolved
    ? { status: 'resolved', key: 'key' }
    : { status: 'env_missing', envVar: 'MISSING_API_KEY' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
})

const registry = new ProviderRegistry([
  makeModel('nvidia/qwen/model', true),
  makeModel('zai/glm-4.7', false), // unresolved — should not appear
])

const app = buildApp({ config: {}, registry, logLevel: 'silent' })

describe('GET /v1/models', () => {
  beforeAll(() => app.ready())
  afterAll(() => app.close())

  it('returns only resolvable models', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('nvidia/qwen/model')
    expect(body.data[0].owned_by).toBe('nvidia')
  })
})
