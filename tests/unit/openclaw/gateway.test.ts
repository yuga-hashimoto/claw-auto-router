import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const spawnSync = vi.fn()

vi.mock('node:child_process', () => ({
  spawnSync,
}))

describe('resolveOpenClawGatewayContext', () => {
  const originalEnv = process.env
  let tmpDir: string

  beforeEach(() => {
    process.env = { ...originalEnv }
    tmpDir = mkdtempSync(join(tmpdir(), 'openclaw-gateway-test-'))
    spawnSync.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('derives agentId and env-backed gateway token from the raw OpenClaw config', async () => {
    process.env['REMOTE_GATEWAY_TOKEN'] = 'secret-token'
    const configPath = join(tmpDir, 'moltbot.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: 'main' },
            { id: 'codex', default: true },
          ],
        },
        gateway: {
          remote: {
            token: '${REMOTE_GATEWAY_TOKEN}',
          },
        },
      }),
    )

    spawnSync.mockReturnValue({
      status: 0,
      stdout: 'banner\n{"rpc":{"ok":true,"url":"ws://127.0.0.1:18789"}}',
    })

    const { resolveOpenClawGatewayContext } = await import('../../../src/openclaw/gateway.js')
    const result = resolveOpenClawGatewayContext(configPath)

    expect(result.available).toBe(true)
    expect(result.agentId).toBe('codex')
    expect(result.token).toBe('secret-token')
    expect(result.url).toBe('ws://127.0.0.1:18789')
  })

  it('disables pinned remote WSS gateways until fingerprint-aware transport is implemented', async () => {
    const configPath = join(tmpDir, 'moltbot.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: {
          remote: {
            tlsFingerprint: 'sha256:test',
          },
        },
      }),
    )

    spawnSync.mockReturnValue({
      status: 0,
      stdout: '{"rpc":{"ok":true,"url":"wss://gateway.example.test"}}',
    })

    const { resolveOpenClawGatewayContext } = await import('../../../src/openclaw/gateway.js')
    const result = resolveOpenClawGatewayContext(configPath)

    expect(result.available).toBe(false)
    expect(result.warnings.some((warning) => warning.includes('TLS fingerprint pinning'))).toBe(true)
  })
})
