import { describe, it, expect } from 'vitest'
import { route } from '../../../src/router/router.js'
import { ProviderRegistry } from '../../../src/providers/registry.js'
import { NoCandidatesError } from '../../../src/utils/errors.js'
import type { NormalizedModel } from '../../../src/providers/types.js'
import type { RawConfig } from '../../../src/config/schema.js'

const makeModel = (id: string): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'p',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
})

const models = [makeModel('kimi-coding/k2p5'), makeModel('nvidia/qwen/model')]

const config: RawConfig = {
  agents: {
    defaults: {
      model: {
        primary: 'kimi-coding/k2p5',
        fallbacks: ['nvidia/qwen/model'],
      },
    },
  },
}

const registry = new ProviderRegistry(models)

describe('route', () => {
  it('returns winner and fallbacks', () => {
    const result = route({ messages: [{ role: 'user', content: 'Hello' }] }, config, registry)
    expect(result.winner.model.id).toBe('kimi-coding/k2p5')
    expect(result.fallbacks[0]?.model.id).toBe('nvidia/qwen/model')
    expect(result.decision?.classification.tier).toBe(result.tier)
    expect(result.decision?.candidates[0]?.modelId).toBe('kimi-coding/k2p5')
  })

  it('includes tier in result', () => {
    const result = route({ messages: [{ role: 'user', content: 'Hello' }] }, config, registry)
    expect(['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE']).toContain(result.tier)
  })

  it('throws NoCandidatesError when no resolvable models', () => {
    const emptyRegistry = new ProviderRegistry([])
    expect(() =>
      route({ messages: [{ role: 'user', content: 'hi' }] }, {}, emptyRegistry),
    ).toThrow(NoCandidatesError)
  })

  it('respects explicit model selection', () => {
    const result = route(
      { model: 'nvidia/qwen/model', messages: [{ role: 'user', content: 'hi' }] },
      config,
      registry,
    )
    expect(result.winner.model.id).toBe('nvidia/qwen/model')
    expect(result.decision?.candidates[0]?.explicit).toBe(true)
  })

  it('falls back to primary when model=auto', () => {
    const result = route(
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      config,
      registry,
    )
    expect(result.winner.model.id).toBe('kimi-coding/k2p5')
  })
})
