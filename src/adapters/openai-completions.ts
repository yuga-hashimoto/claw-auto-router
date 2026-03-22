import { fetch, type Response } from 'undici'
import type { AdapterRequest, AdapterResponse } from './types.js'
import type { NormalizedModel } from '../providers/types.js'
import { resolveCopilotApiToken } from '../providers/github-copilot-token.js'
import { resolveModelCredentials } from '../providers/oauth.js'

/**
 * OpenAI-compatible adapter.
 * Proxies the request with minimal transformation — just sets the correct
 * Authorization header and model field.
 */
export async function callOpenAI(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
): Promise<AdapterResponse> {
  const credentials = await resolveModelCredentials(model)
  let apiKey = credentials.secret
  let baseUrl = model.baseUrl
  const extraHeaders: Record<string, string> = {}

  if (model.providerId === 'github-copilot' && apiKey !== undefined) {
    const copilotToken = await resolveCopilotApiToken(apiKey)
    apiKey = copilotToken.token
    baseUrl = copilotToken.baseUrl
    extraHeaders['Editor-Version'] = 'vscode/1.96.2'
    extraHeaders['User-Agent'] = 'GitHubCopilotChat/0.26.7'
    extraHeaders['Copilot-Integration-Id'] = 'vscode-chat'
  }

  const body = {
    model: model.modelId,
    messages: request.messages,
    stream: request.stream,
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...request.extra,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
        ...(apiKey !== undefined ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  if (request.stream && response.body !== null) {
    return {
      body: null,
      statusCode: response.status,
      headers,
      streaming: true,
      stream: sseStream(response),
    }
  }

  const responseBody: unknown = await response.json()
  return {
    body: responseBody,
    statusCode: response.status,
    headers,
    streaming: false,
  }
}

/** Convert a fetch Response into an async iterable of raw SSE lines */
async function* sseStream(response: Response): AsyncIterable<string> {
  if (response.body === null) return

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim().length > 0) {
        yield line + '\n'
      }
    }
  }

  if (buffer.trim().length > 0) {
    yield buffer + '\n'
  }
}
