import type { ApiKeyResolution } from './types.js'
import type { AuthProfile, RawProvider } from '../config/schema.js'

/** Sentinel pattern: "something-oauth" means the provider uses OAuth, not a real key */
const OAUTH_SENTINEL_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-oauth$/

/**
 * Resolve the API key / bearer token for a provider.
 *
 * Resolution order:
 *   1. Literal key in config (if present and not an OAuth sentinel)
 *   2. OAuth/token provider → check {PROVIDER}_TOKEN env var (static bearer token)
 *   3. api_key provider → check {PROVIDER}_API_KEY env var
 *   4. Unresolvable
 *
 * When discovery imports OAuth credentials from OpenClaw, the current access token
 * is treated like a resolved key here and refreshed later at request time.
 * Users can still override with a static bearer token via env vars such as
 * QWEN_PORTAL_TOKEN or OPENAI_CODEX_TOKEN.
 */
export function resolveApiKey(
  providerId: string,
  rawProvider: RawProvider,
  authProfiles: Record<string, AuthProfile> | undefined,
): ApiKeyResolution {
  const { apiKey } = rawProvider
  const isOAuthSentinel = apiKey !== undefined && OAUTH_SENTINEL_RE.test(apiKey)

  // Step 1: literal key present and not an oauth sentinel
  if (apiKey !== undefined && apiKey.length > 0 && !isOAuthSentinel) {
    return { status: 'resolved', key: apiKey }
  }

  // Step 2: determine if this provider uses OAuth or token auth
  const profileKey = `${providerId}:default`
  const profile = authProfiles?.[profileKey]
  const isOAuth =
    isOAuthSentinel ||
    rawProvider.authMode === 'oauth' ||
    rawProvider.authMode === 'token' ||
    profile?.mode === 'oauth' ||
    profile?.mode === 'token'

  if (isOAuth) {
    // Check for a manually-supplied static token from env
    const tokenEnvVar = toTokenEnvVarName(providerId)
    const token = process.env[tokenEnvVar]
    if (token !== undefined && token.length > 0) {
      return { status: 'resolved', key: token }
    }
    // No token → provider unusable
    return {
      status: 'oauth',
      reason: `Provider "${providerId}" uses OAuth. Set ${tokenEnvVar} to a static bearer token to enable it.`,
    }
  }

  // Step 3: try API key env var
  const apiKeyEnvVar = toEnvVarName(providerId)
  const envValue = process.env[apiKeyEnvVar]
  if (envValue !== undefined && envValue.length > 0) {
    return { status: 'resolved', key: envValue }
  }

  // Step 4: unresolvable
  return { status: 'env_missing', envVar: apiKeyEnvVar }
}

/** "kimi-coding" → "KIMI_CODING_API_KEY" */
export function toEnvVarName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/** "qwen-portal" → "QWEN_PORTAL_TOKEN" */
export function toTokenEnvVarName(providerId: string): string {
  return `${providerId.toUpperCase().replace(/-/g, '_')}_TOKEN`
}
