import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../src/server/app.js'
import { ProviderRegistry } from '../../src/providers/registry.js'

const app = buildApp({
  config: {},
  registry: new ProviderRegistry([]),
  logLevel: 'silent',
  decisionLogEnabled: false,
})

describe('GET /stats', () => {
  beforeAll(() => app.ready())
  afterAll(() => app.close())

  it('returns stats shape', async () => {
    const response = await app.inject({ method: 'GET', url: '/stats' })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(typeof body.totalRequests).toBe('number')
    expect(typeof body.successfulRequests).toBe('number')
    expect(typeof body.failedRequests).toBe('number')
    expect(typeof body.fallbackCount).toBe('number')
    expect(typeof body.averageDurationMs).toBe('number')
    expect(Array.isArray(body.recentRequests)).toBe(true)
    expect(typeof body.configStatus).toBe('object')
  })
})
