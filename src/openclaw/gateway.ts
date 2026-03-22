import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export interface OpenClawGatewayContext {
  available: boolean
  agentId: string
  url?: string | undefined
  token?: string | undefined
  password?: string | undefined
  tlsFingerprint?: string | undefined
  warnings: string[]
}

interface GatewayStatusPayload {
  rpc?: {
    ok?: boolean
    url?: string
  }
  gateway?: {
    probeUrl?: string
  }
}

const DEFAULT_AGENT_ID = 'main'

export function resolveOpenClawGatewayContext(configPath?: string): OpenClawGatewayContext {
  const warnings: string[] = []
  const rawConfig = readRawJsonFile(configPath)
  const status = runGatewayStatus(configPath)

  const url = normalizeString(status?.rpc?.url) ?? normalizeString(status?.gateway?.probeUrl)
  const token = normalizeString(process.env.OPENCLAW_GATEWAY_TOKEN) ?? resolveGatewaySecret(rawConfig, 'token')
  const password =
    normalizeString(process.env.OPENCLAW_GATEWAY_PASSWORD) ?? resolveGatewaySecret(rawConfig, 'password')
  const agentId = resolveDefaultAgentId(rawConfig)
  const tlsFingerprint = resolveGatewayTlsFingerprint(rawConfig)
  const fingerprintPinnedRemote = tlsFingerprint !== undefined && url !== undefined && url.startsWith('wss://')
  const available = status?.rpc?.ok === true && url !== undefined && !fingerprintPinnedRemote

  if (fingerprintPinnedRemote) {
    warnings.push(
      'Gateway TLS fingerprint pinning is configured. claw-auto-router expects a CA-trusted WSS endpoint or local loopback WS today.',
    )
  } else if (!available) {
    warnings.push(
      'OpenClaw Gateway is not reachable right now. Imported OpenClaw models will stay hidden until the gateway comes back.',
    )
  } else if (url === undefined) {
    warnings.push('OpenClaw Gateway is reachable, but its WebSocket URL could not be determined.')
  }

  return {
    available,
    agentId,
    ...(url !== undefined ? { url } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(tlsFingerprint !== undefined ? { tlsFingerprint } : {}),
    warnings,
  }
}

function runGatewayStatus(configPath?: string): GatewayStatusPayload | undefined {
  const result = spawnSync('openclaw', ['gateway', 'status', '--json', '--timeout', '5000'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(configPath !== undefined ? { OPENCLAW_CONFIG_PATH: configPath } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return undefined
  }

  return parseJsonFromCommandOutput<GatewayStatusPayload>(result.stdout)
}

function parseJsonFromCommandOutput<T>(stdout: string): T | undefined {
  const firstBrace = stdout.indexOf('{')
  if (firstBrace === -1) {
    return undefined
  }

  try {
    return JSON.parse(stdout.slice(firstBrace)) as T
  } catch {
    return undefined
  }
}

function readRawJsonFile(path?: string): unknown {
  if (path === undefined || !existsSync(path)) {
    return undefined
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return undefined
  }
}

function resolveGatewaySecret(rawConfig: unknown, field: 'token' | 'password'): string | undefined {
  const gateway = getRecord(rawConfig)?.['gateway']
  const gatewayRecord = getRecord(gateway)
  const remote = getRecord(gatewayRecord?.['remote'])
  const auth = getRecord(gatewayRecord?.['auth'])

  return (
    resolveSecretInput(remote?.[field]) ??
    resolveSecretInput(auth?.[field])
  )
}

function resolveGatewayTlsFingerprint(rawConfig: unknown): string | undefined {
  const gateway = getRecord(rawConfig)?.['gateway']
  const remote = getRecord(getRecord(gateway)?.['remote'])
  return normalizeString(remote?.['tlsFingerprint'])
}

function resolveDefaultAgentId(rawConfig: unknown): string {
  const override =
    normalizeString(process.env.ROUTER_OPENCLAW_AGENT_ID) ?? normalizeString(process.env.OPENCLAW_AGENT_ID)
  if (override !== undefined) {
    return override
  }

  const agents = getRecord(rawConfig)?.['agents']
  const list = getRecord(agents)?.['list']
  if (Array.isArray(list)) {
    const defaultEntry = list.find(
      (entry) => getRecord(entry)?.['default'] === true && normalizeString(getRecord(entry)?.['id']) !== undefined,
    )
    const firstEntry = list.find((entry) => normalizeString(getRecord(entry)?.['id']) !== undefined)
    return (
      normalizeString(getRecord(defaultEntry)?.['id']) ??
      normalizeString(getRecord(firstEntry)?.['id']) ??
      DEFAULT_AGENT_ID
    )
  }

  return DEFAULT_AGENT_ID
}

function resolveSecretInput(value: unknown): string | undefined {
  const normalized = normalizeString(value)
  if (normalized !== undefined) {
    const envMatch = normalized.match(/^\$\{([A-Z][A-Z0-9_]*)\}$/)
    if (envMatch?.[1] !== undefined) {
      return normalizeString(process.env[envMatch[1]])
    }
    return normalized
  }

  const record = getRecord(value)
  if (record?.['source'] === 'env' && typeof record['id'] === 'string') {
    return normalizeString(process.env[record['id']])
  }

  return undefined
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }

  return value as Record<string, unknown>
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
