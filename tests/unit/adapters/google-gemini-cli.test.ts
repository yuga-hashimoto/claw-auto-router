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

import { callGoogleGeminiCli } from '../../../src/adapters/google-gemini-cli.js'

const baseModel: NormalizedModel = {
  id: 'google-antigravity/gemini-3.1-pro-preview',
  providerId: 'google-antigravity',
  modelId: 'gemini-3.1-pro-preview',
  name: 'Gemini 3.1 Pro Preview',
  api: 'google-gemini-cli',
  baseUrl: 'https://cloudcode-pa.googleapis.com',
  apiKeyResolution: { status: 'resolved', key: 'access-token' },
  reasoning: true,
  supportsImages: true,
  contextWindow: 1_048_576,
  maxTokens: 8192,
  authMode: 'oauth',
  authProfileId: 'google-antigravity:default',
  oauthProjectId: 'project-123',
}

describe('callGoogleGeminiCli', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    resolveModelCredentialsMock.mockReset()
  })

  it('calls the Cloud Code Assist SSE endpoint and converts chunks into an OpenAI chat completion', async () => {
    resolveModelCredentialsMock.mockResolvedValue({
      secret: 'google-access-token',
      projectId: 'project-123',
    })

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hello from Google"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":4,"cachedContentTokenCount":1,"totalTokenCount":10}}}',
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

    const result = await callGoogleGeminiCli(
      baseModel,
      {
        model: 'gemini-3.1-pro-preview',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
      30_000,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
    expect(options.headers).toMatchObject({
      Authorization: 'Bearer google-access-token',
      Accept: 'text/event-stream',
    })
    expect(result.body).toMatchObject({
      model: 'gemini-3.1-pro-preview',
      choices: [{ message: { content: 'Hello from Google' } }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 10 },
    })
  })
})
