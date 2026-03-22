import { describe, expect, it } from 'vitest'
import type { RawConfig } from '../../../src/config/schema.js'
import {
  coerceDiscoveredApi,
  mergeDiscoveryIntoConfig,
  resolveConfiguredCompositeId,
  type OpenClawDiscoverySnapshot,
} from '../../../src/openclaw/discovery.js'

describe('resolveConfiguredCompositeId', () => {
  it('maps OpenClaw list keys back to configured OpenRouter refs when the model id was normalized', () => {
    expect(
      resolveConfiguredCompositeId('openrouter/free', [
        'openrouter/openrouter/free',
        'openrouter/auto',
      ]),
    ).toBe('openrouter/openrouter/free')
  })

  it('keeps the original key when there is no unique configured match', () => {
    expect(
      resolveConfiguredCompositeId('openrouter/auto', [
        'openrouter/auto',
        'openrouter/openrouter/free',
      ]),
    ).toBe('openrouter/auto')
  })
})

describe('coerceDiscoveredApi', () => {
  it('treats GitHub Copilot as OpenAI-compatible chat completions for routing', () => {
    expect(coerceDiscoveredApi('github-copilot', undefined)).toBe('openai-completions')
  })

  it('maps OpenClaw-specific provider transports to router adapters', () => {
    expect(coerceDiscoveredApi('openai-codex', 'openai-codex-responses')).toBe('openai-codex-responses')
    expect(coerceDiscoveredApi('google-antigravity', 'anthropic-messages')).toBe('google-gemini-cli')
  })

  it('falls back to a placeholder OpenAI transport for unknown provider APIs so Gateway delegation can still use them', () => {
    expect(coerceDiscoveredApi('minimax-portal', 'some-future-api')).toBe('openai-completions')
  })
})

describe('mergeDiscoveryIntoConfig', () => {
  it('merges discovered providers, fills in missing models, and replaces oauth sentinels with runtime secrets', () => {
    const config: RawConfig = {
      models: {
        providers: {
          'qwen-portal': {
            baseUrl: 'https://portal.qwen.ai/v1',
            apiKey: 'qwen-oauth',
            api: 'openai-completions',
            models: [{ id: 'coder-model', name: 'Qwen Coder' }],
          },
        },
      },
    }

    const snapshot: OpenClawDiscoverySnapshot = {
      providers: {
        'qwen-portal': {
          baseUrl: 'https://portal.qwen.ai/v1',
          apiKey: 'qwen-access-token',
          api: 'openai-completions',
          authMode: 'oauth',
          authProfileId: 'qwen-portal:default',
          oauthRefreshToken: 'qwen-refresh-token',
          oauthExpiresAt: 123456,
          models: [{ id: 'vision-model', name: 'Qwen Vision' }],
        },
        'github-copilot': {
          baseUrl: 'https://api.business.githubcopilot.com',
          apiKey: 'github-token',
          api: 'openai-completions',
          models: [],
        },
      },
      models: [
        {
          compositeId: 'github-copilot/gpt-4o',
          name: 'GPT-4o',
          input: ['text', 'image'],
          contextWindow: 64000,
        },
      ],
      warnings: [],
    }

    const merged = mergeDiscoveryIntoConfig(config, snapshot)

    expect(merged.models?.providers['qwen-portal']?.apiKey).toBe('qwen-access-token')
    expect(merged.models?.providers['qwen-portal']?.authMode).toBe('oauth')
    expect(merged.models?.providers['qwen-portal']?.authProfileId).toBe('qwen-portal:default')
    expect(merged.models?.providers['qwen-portal']?.oauthRefreshToken).toBe('qwen-refresh-token')
    expect(merged.models?.providers['qwen-portal']?.models.map((model) => model.id)).toEqual([
      'coder-model',
      'vision-model',
    ])
    expect(merged.models?.providers['github-copilot']).toEqual({
      baseUrl: 'https://api.business.githubcopilot.com',
      apiKey: 'github-token',
      api: 'openai-completions',
      models: [
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          input: ['text', 'image'],
          contextWindow: 64000,
          maxTokens: 8192,
        },
      ],
    })
  })
})
