const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const CACHE_SAFETY_WINDOW_MS = 5 * 60 * 1000

interface CachedToken {
  token: string
  expiresAt: number
  baseUrl: string
}

const tokenCache = new Map<string, CachedToken>()

export interface CopilotApiToken {
  token: string
  expiresAt: number
  baseUrl: string
}

export function deriveCopilotApiBaseUrlFromToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed === '') {
    return 'https://api.individual.githubcopilot.com'
  }

  const proxyEp = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i)?.[1]?.trim()
  if (proxyEp === undefined || proxyEp === '') {
    return 'https://api.individual.githubcopilot.com'
  }

  const host = proxyEp.replace(/^https?:\/\//, '').replace(/^proxy\./i, 'api.')
  return host === '' ? 'https://api.individual.githubcopilot.com' : `https://${host}`
}

export async function resolveCopilotApiToken(githubToken: string): Promise<CopilotApiToken> {
  const trimmedToken = githubToken.trim()
  const cached = tokenCache.get(trimmedToken)
  if (cached !== undefined && cached.expiresAt - Date.now() > CACHE_SAFETY_WINDOW_MS) {
    return cached
  }

  const response = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${trimmedToken}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${response.status}`)
  }

  const payload = parseCopilotTokenResponse(await response.json())
  tokenCache.set(trimmedToken, payload)
  return payload
}

function parseCopilotTokenResponse(value: unknown): CachedToken {
  if (value === null || typeof value !== 'object') {
    throw new Error('Unexpected response from GitHub Copilot token endpoint')
  }

  const record = value as Record<string, unknown>
  const rawToken = record.token
  const rawExpiresAt = record.expires_at

  if (typeof rawToken !== 'string' || rawToken.trim() === '') {
    throw new Error('Copilot token response missing token')
  }

  let expiresAt: number
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    expiresAt = rawExpiresAt > 10_000_000_000 ? rawExpiresAt : rawExpiresAt * 1000
  } else if (typeof rawExpiresAt === 'string' && rawExpiresAt.trim() !== '') {
    const parsed = Number.parseInt(rawExpiresAt, 10)
    if (!Number.isFinite(parsed)) {
      throw new Error('Copilot token response has invalid expires_at')
    }
    expiresAt = parsed > 10_000_000_000 ? parsed : parsed * 1000
  } else {
    throw new Error('Copilot token response missing expires_at')
  }

  return {
    token: rawToken,
    expiresAt,
    baseUrl: deriveCopilotApiBaseUrlFromToken(rawToken),
  }
}
