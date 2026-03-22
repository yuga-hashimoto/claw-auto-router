import { fetch, type Response } from 'undici'
import type { AdapterRequest, AdapterResponse } from './types.js'
import type { NormalizedModel } from '../providers/types.js'
import type { OpenAIMessage } from '../router/types.js'

const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicContentBlock {
  type: 'text' | 'image'
  text?: string
  source?: { type: 'base64'; media_type: string; data: string }
}

interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  system?: string
  temperature?: number
  stream?: boolean
}

/**
 * Translate an OpenAI-format request to Anthropic Messages API format.
 */
function toAnthropicRequest(model: NormalizedModel, request: AdapterRequest): AnthropicRequest {
  let systemPrompt: string | undefined
  const messages: AnthropicMessage[] = []

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      systemPrompt = typeof msg.content === 'string' ? msg.content : ''
      continue
    }

    if (msg.role === 'user' || msg.role === 'assistant') {
      const content = extractAnthropicContent(msg)
      messages.push({ role: msg.role, content })
    }
    // Skip 'function' and 'tool' roles — not supported in v1
  }

  return {
    model: model.modelId,
    messages,
    max_tokens: request.maxTokens ?? model.maxTokens,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.stream ? { stream: true } : {}),
  }
}

function extractAnthropicContent(msg: OpenAIMessage): string | AnthropicContentBlock[] {
  if (typeof msg.content === 'string') return msg.content
  if (msg.content === null) return ''

  const blocks: AnthropicContentBlock[] = []
  for (const part of msg.content) {
    if (part.type === 'text' && part.text !== undefined) {
      blocks.push({ type: 'text', text: part.text })
    }
    // image_url parts are skipped in v1 — would need base64 conversion for Anthropic
  }
  return blocks.length === 1 && blocks[0] !== undefined ? blocks[0].text ?? '' : blocks
}

/**
 * Translate an Anthropic Messages response back to OpenAI format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOpenAIResponse(anthropicResponse: any, requestId: string): any {
  const content = anthropicResponse?.content?.[0]
  const text = content?.type === 'text' ? content.text : ''

  return {
    id: anthropicResponse?.id ?? requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse?.model ?? 'unknown',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(anthropicResponse?.stop_reason),
      },
    ],
    usage: anthropicResponse?.usage
      ? {
          prompt_tokens: anthropicResponse.usage.input_tokens ?? 0,
          completion_tokens: anthropicResponse.usage.output_tokens ?? 0,
          total_tokens:
            (anthropicResponse.usage.input_tokens ?? 0) +
            (anthropicResponse.usage.output_tokens ?? 0),
        }
      : undefined,
  }
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
      return 'length'
    default:
      return 'stop'
  }
}

/**
 * Anthropic Messages adapter.
 * Translates OpenAI request format → Anthropic Messages API → back to OpenAI response format.
 */
export async function callAnthropic(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
): Promise<AdapterResponse> {
  const apiKey =
    model.apiKeyResolution.status === 'resolved' ? model.apiKeyResolution.key : undefined

  const anthropicBody = toAnthropicRequest(model, request)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${model.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...(apiKey !== undefined ? { 'x-api-key': apiKey } : {}),
      },
      body: JSON.stringify(anthropicBody),
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
      stream: anthropicSseToOpenAI(response),
    }
  }

  const anthropicResponse: unknown = await response.json()
  const openAIResponse = toOpenAIResponse(anthropicResponse, `chatcmpl-${Date.now()}`)

  return {
    body: openAIResponse,
    statusCode: response.status,
    headers,
    streaming: false,
  }
}

/**
 * Translate Anthropic SSE stream to OpenAI SSE format.
 *
 * Anthropic events: content_block_delta, message_start, message_stop, etc.
 * OpenAI events: data: {"choices":[{"delta":{"content":"..."}}]}
 */
async function* anthropicSseToOpenAI(response: Response): AsyncIterable<string> {
  if (response.body === null) return

  const decoder = new TextDecoder()
  let buffer = ''
  const completionId = `chatcmpl-${Date.now()}`

  // Yield initial role chunk
  yield formatOpenAIChunk(completionId, { role: 'assistant', content: '' }, null)

  for await (const rawChunk of response.body) {
    buffer += decoder.decode(rawChunk as Uint8Array, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        yield 'data: [DONE]\n\n'
        return
      }

      try {
        const event = JSON.parse(data)
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield formatOpenAIChunk(completionId, { content: event.delta.text }, null)
        } else if (event.type === 'message_stop') {
          yield formatOpenAIChunk(completionId, {}, 'stop')
          yield 'data: [DONE]\n\n'
          return
        }
      } catch {
        // Skip malformed SSE events
      }
    }
  }

  yield 'data: [DONE]\n\n'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatOpenAIChunk(id: string, delta: Record<string, any>, finishReason: string | null): string {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'unknown',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
