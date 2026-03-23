import { describe, it, expect } from 'vitest'
import { buildCandidateChain } from '../../../src/router/chain-builder.js'
import { ProviderRegistry } from '../../../src/providers/registry.js'
import type { NormalizedModel } from '../../../src/providers/types.js'
import type { RawConfig } from '../../../src/config/schema.js'

const makeModel = (id: string, resolved = true): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'p',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: resolved
    ? { status: 'resolved', key: 'key' }
    : { status: 'env_missing', envVar: 'FOO_API_KEY' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
})

const models = [
  makeModel('kimi-coding/k2p5'),
  makeModel('nvidia/qwen/qwen3.5-397b-a17b'),
  makeModel('zai/glm-4.7'),
  makeModel('qwen-portal/coder-model', false), // unresolved
]

const config: RawConfig = {
  agents: {
    defaults: {
      model: {
        primary: 'kimi-coding/k2p5',
        fallbacks: [
          'openrouter/auto', // phantom
          'nvidia/qwen/qwen3.5-397b-a17b',
          'qwen-portal/coder-model', // unresolved
          'zai/glm-4.7',
        ],
      },
    },
  },
}

describe('buildCandidateChain', () => {
  const registry = new ProviderRegistry(models)

  it('puts primary first', () => {
    const chain = buildCandidateChain(undefined, config, registry)
    expect(chain[0]?.model.id).toBe('kimi-coding/k2p5')
  })

  it('skips phantom refs (openrouter/auto)', () => {
    const chain = buildCandidateChain(undefined, config, registry)
    expect(chain.every((c) => c.model.id !== 'openrouter/auto')).toBe(true)
  })

  it('skips unresolved providers', () => {
    const chain = buildCandidateChain(undefined, config, registry)
    expect(chain.every((c) => c.model.apiKeyResolution.status === 'resolved')).toBe(true)
  })

  it('respects fallback ordering', () => {
    const chain = buildCandidateChain(undefined, config, registry)
    const ids = chain.map((c) => c.model.id)
    const nvidiaIdx = ids.indexOf('nvidia/qwen/qwen3.5-397b-a17b')
    const zaiIdx = ids.indexOf('zai/glm-4.7')
    expect(nvidiaIdx).toBeLessThan(zaiIdx)
  })

  it('prepends explicit model to front', () => {
    const chain = buildCandidateChain('nvidia/qwen/qwen3.5-397b-a17b', config, registry)
    expect(chain[0]?.model.id).toBe('nvidia/qwen/qwen3.5-397b-a17b')
  })

  it('does not duplicate models', () => {
    // kimi-coding/k2p5 is both in explicit and primary
    const chain = buildCandidateChain('kimi-coding/k2p5', config, registry)
    const ids = chain.map((c) => c.model.id)
    const count = ids.filter((id) => id === 'kimi-coding/k2p5').length
    expect(count).toBe(1)
  })

  it('returns empty when no candidates resolvable', () => {
    const emptyRegistry = new ProviderRegistry([makeModel('foo/bar', false)])
    const chain = buildCandidateChain(undefined, {}, emptyRegistry)
    expect(chain).toHaveLength(0)
  })

  it('uses saved upstream selection instead of the router self-reference', () => {
    const registry = new ProviderRegistry([
      makeModel('claw-auto-router/auto'),
      makeModel('kimi-coding/k2p5'),
      makeModel('nvidia/qwen/qwen3.5-397b-a17b'),
    ])

    const setupConfig: RawConfig = {
      agents: {
        defaults: {
          model: {
            primary: 'claw-auto-router/auto',
            fallbacks: ['kimi-coding/k2p5', 'nvidia/qwen/qwen3.5-397b-a17b'],
          },
        },
      },
    }

    const chain = buildCandidateChain(undefined, setupConfig, registry, 'STANDARD', {
      openClawIntegration: {
        providerId: 'claw-auto-router',
        modelId: 'auto',
        baseUrl: 'http://127.0.0.1:3000',
        upstreamPrimary: 'kimi-coding/k2p5',
        upstreamFallbacks: ['nvidia/qwen/qwen3.5-397b-a17b'],
      },
    })

    expect(chain[0]?.model.id).toBe('kimi-coding/k2p5')
    expect(chain.every((candidate) => candidate.model.id !== 'claw-auto-router/auto')).toBe(true)
  })
})
