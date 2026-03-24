import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { normalizeConfig } from '../../../src/providers/normalizer.js'
import type { RawConfig } from '../../../src/config/schema.js'

const validConfig: RawConfig = {
  models: {
    providers: {
      nvidia: {
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        apiKey: 'nvapi-testkey',
        api: 'openai-completions',
        models: [
          {
            id: 'qwen/qwen3.5-397b-a17b',
            name: 'Qwen3.5-397B',
            api: 'openai-completions',
            reasoning: false,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
      'kimi-coding': {
        baseUrl: 'https://api.kimi.com/coding/',
        api: 'anthropic-messages',
        models: [
          {
            id: 'k2p5',
            name: 'Kimi for Coding',
            api: 'anthropic-messages',
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 262144,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: 'kimi-coding/k2p5',
        fallbacks: ['nvidia/qwen/qwen3.5-397b-a17b', 'openrouter/auto'],
      },
      models: {
        'kimi-coding/k2p5': { alias: 'Kimi for Coding' },
        'nvidia/qwen/qwen3.5-397b-a17b': { alias: 'qwen3.5-397b' },
      },
    },
  },
}

describe('normalizeConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env['KIMI_CODING_API_KEY']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('produces correct number of providers and models', () => {
    const { providers, models } = normalizeConfig(validConfig)
    expect(providers).toHaveLength(2)
    expect(models).toHaveLength(2)
  })

  it('builds composite IDs correctly including nested slashes', () => {
    const { models } = normalizeConfig(validConfig)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('nvidia/qwen/qwen3.5-397b-a17b')
    expect(ids).toContain('kimi-coding/k2p5')
  })

  it('resolves literal API key', () => {
    const { models } = normalizeConfig(validConfig)
    const nvidiaModel = models.find((m) => m.providerId === 'nvidia')
    expect(nvidiaModel?.apiKeyResolution.status).toBe('resolved')
  })

  it('marks kimi-coding as env_missing when no key available', () => {
    const { models } = normalizeConfig(validConfig)
    const kimiModel = models.find((m) => m.providerId === 'kimi-coding')
    expect(kimiModel?.apiKeyResolution.status).toBe('env_missing')
  })

  it('attaches alias from agents.defaults.models', () => {
    const { models } = normalizeConfig(validConfig)
    const kimiModel = models.find((m) => m.id === 'kimi-coding/k2p5')
    expect(kimiModel?.alias).toBe('Kimi for Coding')
  })

  it('detects supportsImages correctly', () => {
    const { models } = normalizeConfig(validConfig)
    const kimiModel = models.find((m) => m.id === 'kimi-coding/k2p5')
    const nvidiaModel = models.find((m) => m.id === 'nvidia/qwen/qwen3.5-397b-a17b')
    expect(kimiModel?.supportsImages).toBe(true)
    expect(nvidiaModel?.supportsImages).toBe(false)
  })

  it('warns about phantom refs (openrouter/auto not in providers)', () => {
    const { warnings } = normalizeConfig(validConfig)
    expect(warnings.some((w) => w.includes('openrouter/auto'))).toBe(true)
  })

  it('handles empty config gracefully', () => {
    const { providers, models, warnings } = normalizeConfig({})
    expect(providers).toHaveLength(0)
    expect(models).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })
})

describe('normalizeConfig — auto-population', () => {
  it('auto-adds model from fallback ref when provider exists with empty models', () => {
    const config: RawConfig = {
      models: {
        providers: {
          google: {
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'AIzaSy-test-key',
            api: 'openai-completions',
            models: [], // empty — google has no models defined
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'google/gemini-3-flash-preview',
            fallbacks: [],
          },
        },
      },
    }

    const { models, warnings } = normalizeConfig(config)
    const autoAdded = models.find((m) => m.id === 'google/gemini-3-flash-preview')
    expect(autoAdded).toBeDefined()
    expect(autoAdded?.providerId).toBe('google')
    expect(autoAdded?.modelId).toBe('gemini-3-flash-preview')
    expect(autoAdded?.apiKeyResolution.status).toBe('resolved')
    expect(warnings.some((w) => w.includes('Auto-added'))).toBe(true)
  })

  it('uses denylist from routerConfig to skip models', () => {
    const config: RawConfig = {
      models: {
        providers: {
          nvidia: {
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: 'nvapi-test',
            api: 'openai-completions',
            models: [{ id: 'bad-model', name: 'Bad Model' }],
          },
        },
      },
    }

    const { models } = normalizeConfig(config, { denylist: ['nvidia/bad-model'] })
    expect(models.find((m) => m.id === 'nvidia/bad-model')).toBeUndefined()
  })

  it('skips the self-provider configured by setup', () => {
    const config: RawConfig = {
      models: {
        providers: {
          'claw-auto-router': {
            baseUrl: 'http://127.0.0.1:3000',
            apiKey: 'local',
            api: 'openai-completions',
            models: [{ id: 'auto', name: 'Auto Router' }],
          },
          nvidia: {
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: 'nvapi-test',
            api: 'openai-completions',
            models: [{ id: 'qwen', name: 'Qwen' }],
          },
        },
      },
    }

    const { models } = normalizeConfig(config, {
      openClawIntegration: {
        providerId: 'claw-auto-router',
        modelId: 'auto',
        baseUrl: 'http://127.0.0.1:3000',
      },
    })

    expect(models.find((model) => model.id === 'claw-auto-router/auto')).toBeUndefined()
    expect(models.find((model) => model.id === 'nvidia/qwen')).toBeDefined()
  })

  it('marks OpenClaw-backed providers for gateway execution when requested', () => {
    const { models } = normalizeConfig(validConfig, undefined, {
      gatewayBackedProviderIds: ['nvidia', 'kimi-coding'],
      gatewayAvailable: true,
    })

    expect(models.every((model) => model.transport === 'openclaw-gateway')).toBe(true)
    expect(models.every((model) => model.available === true)).toBe(true)
  })

  it('keeps gateway-backed models unavailable until the OpenClaw Gateway is reachable', () => {
    const { models, warnings } = normalizeConfig(validConfig, undefined, {
      gatewayBackedProviderIds: ['nvidia', 'kimi-coding'],
      gatewayAvailable: false,
    })

    expect(models.every((model) => model.available === false)).toBe(true)
    expect(warnings.some((warning) => warning.includes('OpenClaw Gateway is unavailable'))).toBe(true)
  })
})
