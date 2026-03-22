import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedModel } from '../../../src/providers/types.js'

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}))

vi.mock('undici', () => ({
  fetch: fetchMock,
}))

import { resolveModelCredentials } from '../../../src/providers/oauth.js'

const baseCodexModel: NormalizedModel = {
  id: 'openai-codex/gpt-5.4',
  providerId: 'openai-codex',
  modelId: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  apiKeyResolution: { status: 'resolved', key: 'expired-token' },
  reasoning: true,
  supportsImages: true,
  contextWindow: 272000,
  maxTokens: 128000,
  authMode: 'oauth',
  authProfileId: 'openai-codex:default',
  oauthRefreshToken: 'refresh-token',
  oauthExpiresAt: Date.now() - 1,
}

describe('resolveModelCredentials', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('refreshes OpenAI Codex OAuth credentials and extracts the account id from the refreshed token', async () => {
    const payload = {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-123',
      },
    }
    const accessToken = [
      'header',
      Buffer.from(JSON.stringify(payload)).toString('base64url'),
      'signature',
    ].join('.')

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: 'refresh-token-2',
        expires_in: 3600,
      }),
    })

    const resolved = await resolveModelCredentials(baseCodexModel)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(resolved.secret).toBe(accessToken)
    expect(resolved.accountId).toBe('account-123')
  })
})
