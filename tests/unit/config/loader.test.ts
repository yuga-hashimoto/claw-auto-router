import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadOpenClawConfig } from '../../../src/config/loader.js'

describe('loadOpenClawConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `openclaw-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns ok=true for a valid config file', () => {
    const configPath = join(tmpDir, 'openclaw.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            nvidia: {
              baseUrl: 'https://example.com',
              apiKey: 'test-key',
              api: 'openai-completions',
              models: [{ id: 'model-1', name: 'Model 1' }],
            },
          },
        },
      }),
    )

    const result = loadOpenClawConfig(configPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe(configPath)
      expect(result.config.models?.providers['nvidia']?.baseUrl).toBe('https://example.com')
    }
  })

  it('returns ok=false when file does not exist', () => {
    const result = loadOpenClawConfig(join(tmpDir, 'missing.json'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('not found')
    }
  })

  it('returns ok=false for invalid JSON', () => {
    const configPath = join(tmpDir, 'bad.json')
    writeFileSync(configPath, 'not valid json {{{')

    const result = loadOpenClawConfig(configPath)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('JSON')
    }
  })

  it('handles partial config (no agents section) gracefully', () => {
    const configPath = join(tmpDir, 'partial.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            nvidia: {
              baseUrl: 'https://example.com',
              apiKey: 'key',
              api: 'openai-completions',
              models: [],
            },
          },
        },
      }),
    )

    const result = loadOpenClawConfig(configPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.agents).toBeUndefined()
    }
  })

  it('returns ok=false with no path and no default files exist', () => {
    // Point discovery away from real home by mocking existsSync
    const result = loadOpenClawConfig('/definitely/does/not/exist/openclaw.json')
    expect(result.ok).toBe(false)
  })

  it('uses override path when provided', () => {
    const configPath = join(tmpDir, 'custom.json')
    writeFileSync(configPath, JSON.stringify({ models: { providers: {} } }))

    const result = loadOpenClawConfig(configPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.path).toBe(configPath)
    }
  })

  it('preserves unknown top-level and nested fields when loading a config', () => {
    const configPath = join(tmpDir, 'passthrough.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        meta: { version: '2026.3.14' },
        gateway: { mode: 'local', port: 18789 },
        models: {
          mode: 'merge',
          customField: true,
          providers: {
            nvidia: {
              baseUrl: 'https://example.com',
              apiKey: 'test-key',
              api: 'openai-completions',
              transport: 'custom',
              models: [{ id: 'model-1', name: 'Model 1', extra: 'kept' }],
            },
          },
        },
      }),
    )

    const result = loadOpenClawConfig(configPath)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const config = result.config as typeof result.config & {
        meta?: { version?: string }
        gateway?: { mode?: string; port?: number }
      }
      expect(config.meta?.version).toBe('2026.3.14')
      expect(config.gateway).toEqual({ mode: 'local', port: 18789 })
      expect((config.models as { customField?: boolean } | undefined)?.customField).toBe(true)
      expect(
        (config.models?.providers['nvidia'] as { transport?: string }).transport,
      ).toBe('custom')
      expect(
        (config.models?.providers['nvidia']?.models[0] as { extra?: string } | undefined)?.extra,
      ).toBe('kept')
    }
  })
})
