import { describe, expect, it } from 'vitest'
import {
  applySetupToOpenClawConfig,
  deriveUpstreamSelection,
} from '../../../src/setup/command.js'
import type { RawConfig } from '../../../src/config/schema.js'
import type { OpenClawIntegration } from '../../../src/config/router-config.js'
import type { NormalizedModel } from '../../../src/providers/types.js'

const makeModel = (id: string): NormalizedModel => ({
  id,
  providerId: id.split('/')[0] ?? 'provider',
  modelId: id.split('/').slice(1).join('/'),
  name: id,
  api: 'openai-completions',
  baseUrl: 'https://example.com/v1',
  apiKeyResolution: { status: 'resolved', key: 'test-key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 8192,
})

describe('deriveUpstreamSelection', () => {
  it('prefers saved upstream selection from router config', () => {
    const result = deriveUpstreamSelection(
      {
        agents: {
          defaults: {
            model: {
              primary: 'claw-auto-router/auto',
              fallbacks: ['nvidia/qwen'],
            },
          },
        },
      },
      {
        openClawIntegration: {
          providerId: 'claw-auto-router',
          modelId: 'auto',
          baseUrl: 'http://127.0.0.1:3000',
          upstreamPrimary: 'kimi-coding/k2p5',
          upstreamFallbacks: ['nvidia/qwen'],
        },
      },
      'claw-auto-router/auto',
    )

    expect(result).toEqual({
      inferredFromFallbacks: false,
      primary: 'kimi-coding/k2p5',
      fallbacks: ['nvidia/qwen'],
    })
  })

  it('infers upstream primary from first non-router fallback when already routed', () => {
    const result = deriveUpstreamSelection(
      {
        agents: {
          defaults: {
            model: {
              primary: 'claw-auto-router/auto',
              fallbacks: ['nvidia/qwen', 'zai/glm'],
            },
          },
        },
      },
      {},
      'claw-auto-router/auto',
    )

    expect(result).toEqual({
      inferredFromFallbacks: true,
      primary: 'nvidia/qwen',
      fallbacks: ['zai/glm'],
    })
  })

  it('ignores saved integration during clean setup and rebuilds from current fallbacks', () => {
    const result = deriveUpstreamSelection(
      {
        agents: {
          defaults: {
            model: {
              primary: 'old-router/auto',
              fallbacks: ['github-copilot/gpt-4o', 'zai/glm-5'],
            },
          },
        },
      },
      {
        openClawIntegration: {
          providerId: 'old-router',
          modelId: 'auto',
          baseUrl: 'http://127.0.0.1:3000',
          upstreamPrimary: 'stale/model',
          upstreamFallbacks: ['stale/fallback'],
        },
      },
      'claw-auto-router/auto',
      {
        ignoreSavedIntegration: true,
        selfRefs: ['old-router/auto'],
      },
    )

    expect(result).toEqual({
      inferredFromFallbacks: true,
      primary: 'github-copilot/gpt-4o',
      fallbacks: ['zai/glm-5'],
    })
  })
})

describe('applySetupToOpenClawConfig', () => {
  it('adds the router provider and redirects OpenClaw primary to it', () => {
    const config = {
      gateway: {
        remote: {
          url: 'wss://gateway.example.test',
        },
      },
      models: {
        providers: {
          nvidia: {
            baseUrl: 'https://integrate.api.nvidia.com/v1',
            apiKey: 'nvapi-test-key',
            api: 'openai-completions',
            models: [{ id: 'qwen/qwen3.5-397b-a17b', name: 'Qwen' }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'nvidia/qwen/qwen3.5-397b-a17b',
            fallbacks: ['zai/glm-4.7'],
          },
        },
      },
    } as RawConfig

    const integration: OpenClawIntegration = {
      providerId: 'claw-auto-router',
      modelId: 'auto',
      baseUrl: 'http://127.0.0.1:3000',
      upstreamPrimary: 'nvidia/qwen/qwen3.5-397b-a17b',
      upstreamFallbacks: ['zai/glm-4.7'],
    }

    const updated = applySetupToOpenClawConfig(config, integration, [
      makeModel('nvidia/qwen/qwen3.5-397b-a17b'),
      makeModel('zai/glm-4.7'),
    ])

    expect(updated.models?.providers['claw-auto-router']).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      apiKey: 'claw-auto-router-local',
      api: 'openai-completions',
      models: [
        {
          id: 'auto',
          name: 'Auto Router',
          api: 'openai-completions',
          contextWindow: 262144,
          maxTokens: 32768,
        },
      ],
    })
    expect(updated.agents?.defaults?.model?.primary).toBe('claw-auto-router/auto')
    expect(updated.agents?.defaults?.model?.fallbacks).toEqual([
      'nvidia/qwen/qwen3.5-397b-a17b',
      'zai/glm-4.7',
    ])
    expect((updated as RawConfig & { gateway?: { mode?: string; remote?: { url?: string } } }).gateway).toEqual({
      mode: 'local',
      remote: {
        url: 'wss://gateway.example.test',
      },
    })
  })

  it('replaces an older router provider during clean setup', () => {
    const config: RawConfig = {
      models: {
        providers: {
          'old-router': {
            baseUrl: 'http://127.0.0.1:3000',
            apiKey: 'claw-auto-router-local',
            api: 'openai-completions',
            models: [{ id: 'auto', name: 'Auto Router' }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'old-router/auto',
            fallbacks: ['openrouter/auto', 'github-copilot/gpt-4o'],
          },
        },
      },
    }

    const integration: OpenClawIntegration = {
      providerId: 'claw-auto-router',
      modelId: 'auto',
      baseUrl: 'http://127.0.0.1:3333',
      upstreamPrimary: 'github-copilot/gpt-4o',
      upstreamFallbacks: ['openrouter/auto'],
    }

    const updated = applySetupToOpenClawConfig(
      config,
      integration,
      [makeModel('github-copilot/gpt-4o'), makeModel('openrouter/auto')],
      {
        previousIntegration: {
          providerId: 'old-router',
          modelId: 'auto',
          baseUrl: 'http://127.0.0.1:3000',
        },
      },
    )

    expect(updated.models?.providers['old-router']).toBeUndefined()
    expect(updated.models?.providers['claw-auto-router']?.baseUrl).toBe('http://127.0.0.1:3333')
    expect(updated.agents?.defaults?.model?.primary).toBe('claw-auto-router/auto')
    expect(updated.agents?.defaults?.model?.fallbacks).toEqual([
      'github-copilot/gpt-4o',
      'openrouter/auto',
    ])
  })

  it('does not override an existing gateway mode', () => {
    const updated = applySetupToOpenClawConfig(
      {
        gateway: {
          mode: 'remote',
        },
      } as RawConfig,
      {
        providerId: 'claw-auto-router',
        modelId: 'auto',
        baseUrl: 'http://127.0.0.1:43123',
      },
      [makeModel('openai-codex/gpt-5.4')],
    )

    expect(
      (updated as RawConfig & { gateway?: { mode?: string } }).gateway?.mode,
    ).toBe('remote')
  })
})
