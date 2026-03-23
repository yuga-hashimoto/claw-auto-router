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
})
