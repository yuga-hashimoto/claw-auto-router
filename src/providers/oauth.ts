import { fetch } from 'undici'
import type { NormalizedModel } from './types.js'

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
const GOOGLE_GEMINI_CLIENT_SECRET = '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'
const GOOGLE_ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const GOOGLE_ANTIGRAVITY_CLIENT_SECRET = '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'
const QWEN_PORTAL_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_PORTAL_TOKEN_URL = 'https://chat.qwen.ai/api/v1/oauth2/token'
const MINIMAX_PORTAL_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113'
const REFRESH_SKEW_MS = 5 * 60 * 1000

interface CachedOAuthCredential {
  secret: string
  refreshToken?: string | undefined
  expiresAt?: number | undefined
  projectId?: string | undefined
  accountId?: string | undefined
}

export interface ResolvedModelCredentials {
  secret?: string | undefined
  projectId?: string | undefined
  accountId?: string | undefined
}

const oauthCache = new Map<string, CachedOAuthCredential>()
const refreshInFlight = new Map<string, Promise<CachedOAuthCredential>>()

export async function resolveModelCredentials(
  model: NormalizedModel,
): Promise<ResolvedModelCredentials> {
  const fallbackSecret =
    model.apiKeyResolution.status === 'resolved' ? model.apiKeyResolution.key : undefined

  if (model.authMode !== 'oauth' || model.authProfileId === undefined) {
    return {
      secret: fallbackSecret,
      ...(model.oauthProjectId !== undefined ? { projectId: model.oauthProjectId } : {}),
      ...(model.oauthAccountId !== undefined ? { accountId: model.oauthAccountId } : {}),
    }
  }

  const cached = oauthCache.get(model.authProfileId)
  if (cached !== undefined && !shouldRefresh(cached.expiresAt)) {
    return {
      secret: cached.secret,
      ...(cached.projectId !== undefined ? { projectId: cached.projectId } : {}),
      ...(cached.accountId !== undefined ? { accountId: cached.accountId } : {}),
    }
  }

  const current: CachedOAuthCredential = {
    secret: cached?.secret ?? fallbackSecret ?? '',
    refreshToken: cached?.refreshToken ?? model.oauthRefreshToken,
    expiresAt: cached?.expiresAt ?? model.oauthExpiresAt,
    projectId: cached?.projectId ?? model.oauthProjectId,
    accountId: cached?.accountId ?? model.oauthAccountId,
  }

  if (!shouldRefresh(current.expiresAt) && current.secret !== '') {
    oauthCache.set(model.authProfileId, current)
    return {
      secret: current.secret,
      ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
      ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
    }
  }

  if (current.refreshToken === undefined || current.refreshToken.trim() === '') {
    return {
      secret: current.secret !== '' ? current.secret : undefined,
      ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
      ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
    }
  }

  const inFlight = refreshInFlight.get(model.authProfileId)
  if (inFlight !== undefined) {
    const refreshed = await inFlight
    return {
      secret: refreshed.secret,
      ...(refreshed.projectId !== undefined ? { projectId: refreshed.projectId } : {}),
      ...(refreshed.accountId !== undefined ? { accountId: refreshed.accountId } : {}),
    }
  }

  const refreshPromise = refreshOAuthCredential(model, current)
  refreshInFlight.set(model.authProfileId, refreshPromise)

  try {
    const refreshed = await refreshPromise
    oauthCache.set(model.authProfileId, refreshed)
    return {
      secret: refreshed.secret,
      ...(refreshed.projectId !== undefined ? { projectId: refreshed.projectId } : {}),
      ...(refreshed.accountId !== undefined ? { accountId: refreshed.accountId } : {}),
    }
  } catch (error) {
    const canUseCachedSecret = current.secret !== '' && !shouldRefresh(current.expiresAt)
    if (canUseCachedSecret) {
      console.warn(
        `[claw-auto-router] OAuth refresh for "${model.providerId}" failed; falling back to cached access token.`,
      )
      oauthCache.set(model.authProfileId, current)
      return {
        secret: current.secret,
        ...(current.projectId !== undefined ? { projectId: current.projectId } : {}),
        ...(current.accountId !== undefined ? { accountId: current.accountId } : {}),
      }
    }

    throw error
  } finally {
    refreshInFlight.delete(model.authProfileId)
  }
}

async function refreshOAuthCredential(
  model: NormalizedModel,
  current: CachedOAuthCredential,
): Promise<CachedOAuthCredential> {
  const refreshToken = current.refreshToken
  if (refreshToken === undefined || refreshToken.trim() === '') {
    throw new Error(`OAuth refresh token is missing for provider "${model.providerId}"`)
  }

  switch (model.providerId) {
    case 'openai-codex': {
      const payload = await postFormJson<{
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }>(OPENAI_CODEX_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      })

      const accessToken = payload.access_token?.trim()
      const expiresIn = payload.expires_in
      if (accessToken === undefined || accessToken === '') {
        throw new Error('OpenAI Codex OAuth refresh returned no access_token')
      }
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error('OpenAI Codex OAuth refresh returned an invalid expires_in')
      }

      return {
        secret: accessToken,
        refreshToken: payload.refresh_token?.trim() || refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
        accountId: current.accountId ?? extractOpenAIAccountId(accessToken) ?? undefined,
      }
    }

    case 'google-gemini-cli':
    case 'google-antigravity': {
      const { clientId, clientSecret } =
        model.providerId === 'google-antigravity'
          ? {
              clientId: GOOGLE_ANTIGRAVITY_CLIENT_ID,
              clientSecret: GOOGLE_ANTIGRAVITY_CLIENT_SECRET,
            }
          : {
              clientId: GOOGLE_GEMINI_CLIENT_ID,
              clientSecret: GOOGLE_GEMINI_CLIENT_SECRET,
            }

      const payload = await postFormJson<{
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }>(GOOGLE_TOKEN_URL, {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      })

      const accessToken = payload.access_token?.trim()
      const expiresIn = payload.expires_in
      if (accessToken === undefined || accessToken === '') {
        throw new Error(`Google OAuth refresh returned no access_token for "${model.providerId}"`)
      }
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error(`Google OAuth refresh returned an invalid expires_in for "${model.providerId}"`)
      }

      return {
        secret: accessToken,
        refreshToken: payload.refresh_token?.trim() || refreshToken,
        expiresAt: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
        projectId: current.projectId,
      }
    }

    case 'qwen-portal': {
      const response = await fetch(QWEN_PORTAL_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: QWEN_PORTAL_CLIENT_ID,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        if (response.status === 400) {
          throw new Error(
            'Qwen OAuth refresh token is invalid or expired. Run `openclaw models auth login --provider qwen-portal --set-default` and try again.',
          )
        }
        throw new Error(
          `Qwen OAuth refresh failed (${response.status})${errorText !== '' ? `: ${errorText}` : ''}`,
        )
      }

      const payload = (await response.json()) as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }

      const accessToken = payload.access_token?.trim()
      const expiresIn = payload.expires_in
      if (accessToken === undefined || accessToken === '') {
        throw new Error('Qwen OAuth refresh returned no access_token')
      }
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error('Qwen OAuth refresh returned an invalid expires_in')
      }

      return {
        secret: accessToken,
        refreshToken: payload.refresh_token?.trim() || refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      }
    }

    case 'minimax-portal': {
      const tokenBaseUrl = model.baseUrl.replace(/\/anthropic\/?$/, '')
      const payload = await postFormJson<{
        access_token?: string
        refresh_token?: string
        expired_in?: number
        expires_in?: number
      }>(`${tokenBaseUrl}/oauth/token`, {
        grant_type: 'refresh_token',
        client_id: MINIMAX_PORTAL_CLIENT_ID,
        refresh_token: refreshToken,
      })

      const accessToken = payload.access_token?.trim()
      const expiresIn = payload.expires_in ?? payload.expired_in
      if (accessToken === undefined || accessToken === '') {
        throw new Error('MiniMax OAuth refresh returned no access_token')
      }
      if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error('MiniMax OAuth refresh returned an invalid expires_in')
      }

      return {
        secret: accessToken,
        refreshToken: payload.refresh_token?.trim() || refreshToken,
        expiresAt: Date.now() + expiresIn * 1000,
      }
    }

    default:
      return current
  }
}

async function postFormJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(`${url} responded with ${response.status}${errorText !== '' ? `: ${errorText}` : ''}`)
  }

  return (await response.json()) as T
}

function shouldRefresh(expiresAt: number | undefined): boolean {
  return expiresAt !== undefined && Date.now() + REFRESH_SKEW_MS >= expiresAt
}

function extractOpenAIAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload?.['https://api.openai.com/auth']
  const accountId =
    auth !== undefined && typeof auth === 'object'
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : undefined
  return typeof accountId === 'string' && accountId !== '' ? accountId : undefined
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | undefined {
  const parts = accessToken.split('.')
  if (parts.length !== 3) {
    return undefined
  }

  try {
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf-8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}
