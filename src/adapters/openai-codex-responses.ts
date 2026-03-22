import { fetch, type Response } from 'undici'
import type { AdapterRequest, AdapterResponse } from './types.js'
import type { NormalizedModel } from '../providers/types.js'
import type { OpenAIContentPart, OpenAIMessage } from '../router/types.js'
import { resolveModelCredentials } from '../providers/oauth.js'
import { formatOpenAIChunk, parseJsonSse } from './sse.js'

const OPENAI_BETA_HEADER = 'responses=experimental'
const CODEX_USER_AGENT = 'pi (openclaw-model-router)'
const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

interface CodexEvent {
  type?: string
  delta?: string
  response?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      total_tokens?: number
    }
    error?: {
      message?: string
    }
  }
  error?: {
    message?: string
  }
}

export async function callOpenAICodexResponses(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
): Promise<AdapterResponse> {
  const credentials = await resolveModelCredentials(model)
  const accountId = credentials.accountId ?? model.oauthAccountId
  if (credentials.secret === undefined || credentials.secret === '') {
    throw new Error(`No OAuth access token available for provider "${model.providerId}"`)
  }
  if (accountId === undefined || accountId === '') {
    throw new Error('OpenAI Codex OAuth token is missing the ChatGPT account id')
  }

  const endpoint = resolveCodexEndpoint(model.baseUrl)
  const body = buildCodexBody(model, request)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.secret}`,
        'ChatGPT-Account-Id': accountId,
        'OpenAI-Beta': OPENAI_BETA_HEADER,
        originator: 'pi',
        'User-Agent': CODEX_USER_AGENT,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
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

  if (response.status >= 400) {
    return {
      body: await parseErrorBody(response),
      statusCode: response.status,
      headers,
      streaming: false,
    }
  }

  if (request.stream && response.body !== null) {
    return {
      body: null,
      statusCode: response.status,
      headers,
      streaming: true,
      stream: codexStreamToOpenAI(response, model.modelId),
    }
  }

  return {
    body: await codexResponseToOpenAI(response, model.modelId),
    statusCode: response.status,
    headers,
    streaming: false,
  }
}

function buildCodexBody(model: NormalizedModel, request: AdapterRequest): Record<string, unknown> {
  let instructions = 'You are a helpful assistant.'
  const input: unknown[] = []

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content !== '') {
        instructions = message.content
      }
      continue
    }

    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: toCodexUserContent(message),
      })
      continue
    }

    if (message.role === 'assistant') {
      const text = flattenAssistantText(message)
      if (text !== '') {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
    }
  }

  return {
    model: model.modelId,
    store: false,
    stream: true,
    instructions,
    input,
    text: { verbosity: 'medium' },
    include: ['reasoning.encrypted_content'],
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.extra ?? {}),
  }
}

function toCodexUserContent(message: OpenAIMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') {
    return [{ type: 'input_text', text: message.content }]
  }

  if (message.content === null) {
    return [{ type: 'input_text', text: '' }]
  }

  return message.content.flatMap((part) => mapCodexContentPart(part))
}

function mapCodexContentPart(part: OpenAIContentPart): Array<Record<string, unknown>> {
  if (part.type === 'text') {
    return [{ type: 'input_text', text: part.text ?? '' }]
  }

  const imageUrl = part.image_url?.url
  if (imageUrl === undefined || imageUrl === '') {
    return []
  }

  return [{ type: 'input_image', image_url: imageUrl, detail: 'auto' }]
}

function flattenAssistantText(message: OpenAIMessage): string {
  if (typeof message.content === 'string') return message.content
  if (message.content === null) return ''

  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

async function* codexStreamToOpenAI(response: Response, requestedModel: string): AsyncIterable<string> {
  const completionId = `chatcmpl-${Date.now()}`
  yield formatOpenAIChunk(completionId, requestedModel, { role: 'assistant', content: '' }, null)

  for await (const rawEvent of parseJsonSse(response)) {
    const event = rawEvent as CodexEvent
    const type = event.type ?? ''

    if (type === 'error') {
      throw new Error(event.error?.message ?? 'Codex stream error')
    }

    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message ?? 'Codex response failed')
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (event.delta !== undefined && event.delta !== '') {
        yield formatOpenAIChunk(completionId, requestedModel, { content: event.delta }, null)
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.done') {
      yield formatOpenAIChunk(completionId, requestedModel, {}, 'stop')
      yield 'data: [DONE]\n\n'
      return
    }
  }

  yield formatOpenAIChunk(completionId, requestedModel, {}, 'stop')
  yield 'data: [DONE]\n\n'
}

async function codexResponseToOpenAI(
  response: Response,
  requestedModel: string,
): Promise<Record<string, unknown>> {
  const defaultId = `chatcmpl-${Date.now()}`
  let content = ''
  let upstreamId = defaultId
  let upstreamModel = requestedModel
  let usage: NonNullable<CodexEvent['response']>['usage'] | undefined

  for await (const rawEvent of parseJsonSse(response)) {
    const event = rawEvent as CodexEvent
    const type = event.type ?? ''

    if (type === 'error') {
      throw new Error(event.error?.message ?? 'Codex stream error')
    }

    if (type === 'response.failed') {
      throw new Error(event.response?.error?.message ?? 'Codex response failed')
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      content += event.delta ?? ''
      continue
    }

    if (type === 'response.completed' || type === 'response.done') {
      upstreamId = event.response?.id ?? upstreamId
      upstreamModel = event.response?.model ?? upstreamModel
      usage = event.response?.usage
    }
  }

  return {
    id: upstreamId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: upstreamModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    ...(usage !== undefined
      ? {
          usage: {
            prompt_tokens: usage.input_tokens ?? 0,
            completion_tokens: usage.output_tokens ?? 0,
            total_tokens:
              usage.total_tokens ??
              (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          },
        }
      : {}),
  }
}

function resolveCodexEndpoint(baseUrl: string): string {
  const normalized = (baseUrl.trim() === '' ? DEFAULT_CODEX_BASE_URL : baseUrl).replace(/\/+$/, '')

  if (normalized.endsWith('/codex/responses')) {
    return normalized
  }

  if (normalized.endsWith('/codex')) {
    return `${normalized}/responses`
  }

  return `${normalized}/codex/responses`
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: text }
  }
}
