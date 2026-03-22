import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveApiKey, toEnvVarName, toTokenEnvVarName } from '../../../src/providers/apikey-resolver.js'
import type { RawProvider } from '../../../src/config/schema.js'

const baseProvider: RawProvider = {
  baseUrl: 'https://example.com',
  api: 'openai-completions',
  models: [],
}

describe('toEnvVarName', () => {
  it('converts simple id', () => expect(toEnvVarName('nvidia')).toBe('NVIDIA_API_KEY'))
  it('converts hyphenated id', () => expect(toEnvVarName('kimi-coding')).toBe('KIMI_CODING_API_KEY'))
  it('converts zai', () => expect(toEnvVarName('zai')).toBe('ZAI_API_KEY'))
})

describe('toTokenEnvVarName', () => {
  it('converts qwen-portal', () => expect(toTokenEnvVarName('qwen-portal')).toBe('QWEN_PORTAL_TOKEN'))
  it('converts openai-codex', () => expect(toTokenEnvVarName('openai-codex')).toBe('OPENAI_CODEX_TOKEN'))
  it('converts anthropic', () => expect(toTokenEnvVarName('anthropic')).toBe('ANTHROPIC_TOKEN'))
})

describe('resolveApiKey', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns resolved for literal key in config', () => {
    const result = resolveApiKey('nvidia', { ...baseProvider, apiKey: 'nvapi-abc123' }, undefined)
    expect(result).toEqual({ status: 'resolved', key: 'nvapi-abc123' })
  })

  it('returns oauth for sentinel "qwen-oauth" when no TOKEN set', () => {
    delete process.env['QWEN_PORTAL_TOKEN']
    const result = resolveApiKey(
      'qwen-portal',
      { ...baseProvider, apiKey: 'qwen-oauth' },
      undefined,
    )
    expect(result.status).toBe('oauth')
  })

  it('returns resolved for sentinel "qwen-oauth" when QWEN_PORTAL_TOKEN is set', () => {
    process.env['QWEN_PORTAL_TOKEN'] = 'my-qwen-bearer-token'
    const result = resolveApiKey(
      'qwen-portal',
      { ...baseProvider, apiKey: 'qwen-oauth' },
      undefined,
    )
    expect(result).toEqual({ status: 'resolved', key: 'my-qwen-bearer-token' })
  })

  it('returns oauth when auth profile mode is oauth and no TOKEN set', () => {
    delete process.env['OPENAI_CODEX_TOKEN']
    const result = resolveApiKey('openai-codex', { ...baseProvider }, {
      'openai-codex:default': { provider: 'openai-codex', mode: 'oauth' },
    })
    expect(result.status).toBe('oauth')
  })

  it('returns resolved from TOKEN env var for oauth provider', () => {
    process.env['OPENAI_CODEX_TOKEN'] = 'my-codex-token'
    const result = resolveApiKey('openai-codex', { ...baseProvider }, {
      'openai-codex:default': { provider: 'openai-codex', mode: 'oauth' },
    })
    expect(result).toEqual({ status: 'resolved', key: 'my-codex-token' })
  })

  it('returns resolved from API_KEY env var when no key in config (non-oauth)', () => {
    process.env['ZAI_API_KEY'] = 'secret-zai-key'
    const result = resolveApiKey('zai', { ...baseProvider }, undefined)
    expect(result).toEqual({ status: 'resolved', key: 'secret-zai-key' })
  })

  it('returns env_missing when no key and no env var (non-oauth)', () => {
    delete process.env['KIMI_CODING_API_KEY']
    const result = resolveApiKey('kimi-coding', { ...baseProvider }, undefined)
    expect(result).toEqual({ status: 'env_missing', envVar: 'KIMI_CODING_API_KEY' })
  })

  it('token auth mode (anthropic) resolved via TOKEN env var', () => {
    process.env['ANTHROPIC_TOKEN'] = 'sk-ant-xyz'
    const result = resolveApiKey('anthropic', { ...baseProvider }, {
      'anthropic:default': { provider: 'anthropic', mode: 'token' },
    })
    expect(result).toEqual({ status: 'resolved', key: 'sk-ant-xyz' })
  })
})
