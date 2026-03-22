import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedModel } from '../../../src/providers/types.js'

const { fetchMock, resolveModelCredentialsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolveModelCredentialsMock: vi.fn(),
}))

vi.mock('undici', () => ({
  fetch: fetchMock,
}))

vi.mock('../../../src/providers/oauth.js', () => ({
  resolveModelCredentials: resolveModelCredentialsMock,
}))

import { callOpenAICodexResponses } from '../../../src/adapters/openai-codex-responses.js'

const baseModel: NormalizedModel = {
  id: 'openai-codex/gpt-5.4',
  providerId: 'openai-codex',
  modelId: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
  apiKeyResolution: { status: 'resolved', key: 'token' },
  reasoning: true,
  supportsImages: true,
  contextWindow: 272000,
  maxTokens: 128000,
  authMode: 'oauth',
  authProfileId: 'openai-codex:default',
  oauthAccountId: 'account-123',
}

describe('callOpenAICodexResponses', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveModelCredentialsMock.mockReset()
  })

  it('calls the Codex responses endpoint and converts SSE back into an OpenAI chat completion', async () => {
    resolveModelCredentialsMock.mockResolvedValue({
      secret: 'codex-token',
      accountId: 'account-123',
    })

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"type":"response.output_text.delta","delta":"Hello"}',
              '',
              'data: {"type":"response.completed","response":{"id":"resp_123","model":"gpt-5.4","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
              '',
            ].join('\n'),
          ),
        )
        controller.close()
      },
    })

    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: stream,
    })

    const result = await callOpenAICodexResponses(
      baseModel,
      {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
      30_000,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer codex-token',
      'ChatGPT-Account-Id': 'account-123',
      'OpenAI-Beta': 'responses=experimental',
    })
    expect(result.body).toMatchObject({
      id: 'resp_123',
      model: 'gpt-5.4',
      choices: [{ message: { content: 'Hello' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })
  })
})
