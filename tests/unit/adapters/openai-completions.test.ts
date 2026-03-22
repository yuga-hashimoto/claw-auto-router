import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedModel } from '../../../src/providers/types.js'

const { fetchMock, resolveCopilotApiTokenMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolveCopilotApiTokenMock: vi.fn(),
}))

vi.mock('undici', () => ({
  fetch: fetchMock,
}))

vi.mock('../../../src/providers/github-copilot-token.js', () => ({
  resolveCopilotApiToken: resolveCopilotApiTokenMock,
}))

import { callOpenAI } from '../../../src/adapters/openai-completions.js'

const baseModel: NormalizedModel = {
  id: 'github-copilot/gpt-4o',
  providerId: 'github-copilot',
  modelId: 'gpt-4o',
  name: 'GPT-4o',
  api: 'openai-completions',
  baseUrl: 'https://api.business.githubcopilot.com',
  apiKeyResolution: { status: 'resolved', key: 'github-token' },
  reasoning: false,
  supportsImages: true,
  contextWindow: 64000,
  maxTokens: 8192,
}

describe('callOpenAI', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveCopilotApiTokenMock.mockReset()
  })

  it('exchanges GitHub Copilot tokens and adds the IDE headers required by Copilot chat completions', async () => {
    resolveCopilotApiTokenMock.mockResolvedValue({
      token: 'copilot-runtime-token',
      expiresAt: Date.now() + 60_000,
      baseUrl: 'https://api.business.githubcopilot.com',
    })

    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      json: async () => ({ ok: true }),
    })

    await callOpenAI(
      baseModel,
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
        maxTokens: 1,
      },
      30_000,
    )

    expect(resolveCopilotApiTokenMock).toHaveBeenCalledWith('github-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.business.githubcopilot.com/chat/completions')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer copilot-runtime-token',
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.96.2',
      'User-Agent': 'GitHubCopilotChat/0.26.7',
      'Copilot-Integration-Id': 'vscode-chat',
    })
    expect(JSON.parse(String(options.body))).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 1,
    })
  })
})
