import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'

const tmpDir = join(tmpdir(), `openclaw-reload-test-${Date.now()}`)
mkdirSync(tmpDir, { recursive: true })

const configPath = join(tmpDir, 'test-config.json')
writeFileSync(
  configPath,
  JSON.stringify({
    models: {
      providers: {
        nvidia: {
          baseUrl: 'https://example.com',
          apiKey: 'nvapi-test-12345',
          api: 'openai-completions',
          models: [{ id: 'test-model', name: 'Test' }],
        },
      },
    },
  }),
)

const app = buildApp({
  config: {},
  registry: new ProviderRegistry([]),
  logLevel: 'silent',
  configPath,
})

describe('POST /reload-config', () => {
  beforeAll(async () => {
    process.env['OPENCLAW_CONFIG_PATH'] = configPath
    await app.ready()
  })

  afterAll(async () => {
    delete process.env['OPENCLAW_CONFIG_PATH']
    await app.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reloads and returns ok with model counts', async () => {
    const response = await app.inject({ method: 'POST', url: '/reload-config' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.models).toBeGreaterThan(0)
    expect(body.resolvable).toBeGreaterThan(0)
    expect(body.path).toBe(configPath)
  })

  it('uses the startup config path even when OPENCLAW_CONFIG_PATH is unset', async () => {
    delete process.env['OPENCLAW_CONFIG_PATH']

    const response = await app.inject({ method: 'POST', url: '/reload-config' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.ok).toBe(true)
    expect(body.path).toBe(configPath)

    process.env['OPENCLAW_CONFIG_PATH'] = configPath
  })

  it('requires admin token when configured', async () => {
    const tokenApp = buildApp({
      config: {},
      registry: new ProviderRegistry([]),
      logLevel: 'silent',
      adminToken: 'secret-token',
    })
    await tokenApp.ready()

    const unauthorizedRes = await tokenApp.inject({ method: 'POST', url: '/reload-config' })
    expect(unauthorizedRes.statusCode).toBe(401)

    const authorizedRes = await tokenApp.inject({
      method: 'POST',
      url: '/reload-config',
      headers: { Authorization: 'Bearer secret-token' },
    })
    // May be 500 (config path not set) or 200 — but NOT 401
    expect(authorizedRes.statusCode).not.toBe(401)

    await tokenApp.close()
  })
})
