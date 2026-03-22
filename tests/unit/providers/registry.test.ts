import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '../../../src/providers/registry.js'
import type { NormalizedModel } from '../../../src/providers/types.js'

const makeModel = (overrides: Partial<NormalizedModel> & { id: string }): NormalizedModel => ({
  id: overrides.id,
  providerId: overrides.id.split('/')[0] ?? 'unknown',
  modelId: overrides.id.split('/').slice(1).join('/'),
  name: overrides.name ?? overrides.id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'test-key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
  ...overrides,
})

const models: NormalizedModel[] = [
  makeModel({ id: 'nvidia/qwen/qwen3.5-397b-a17b', alias: 'qwen3.5-397b' }),
  makeModel({ id: 'kimi-coding/k2p5', alias: 'Kimi for Coding' }),
  makeModel({ id: 'zai/glm-4.7', apiKeyResolution: { status: 'env_missing', envVar: 'ZAI_API_KEY' } }),
]

describe('ProviderRegistry', () => {
  const registry = new ProviderRegistry(models)

  it('looks up by composite ID', () => {
    const model = registry.lookup('nvidia/qwen/qwen3.5-397b-a17b')
    expect(model?.id).toBe('nvidia/qwen/qwen3.5-397b-a17b')
  })

  it('looks up by alias (case-insensitive)', () => {
    const model = registry.lookup('qwen3.5-397b')
    expect(model?.id).toBe('nvidia/qwen/qwen3.5-397b-a17b')

    const model2 = registry.lookup('kimi for coding')
    expect(model2?.id).toBe('kimi-coding/k2p5')
  })

  it('returns undefined for unknown ref', () => {
    expect(registry.lookup('openrouter/auto')).toBeUndefined()
  })

  it('resolvable() returns only models with resolved API keys', () => {
    const resolvable = registry.resolvable()
    expect(resolvable).toHaveLength(2)
    expect(resolvable.every((m) => m.apiKeyResolution.status === 'resolved')).toBe(true)
  })

  it('all() returns all models', () => {
    expect(registry.all()).toHaveLength(3)
  })

  it('size is correct', () => {
    expect(registry.size).toBe(3)
  })
})
