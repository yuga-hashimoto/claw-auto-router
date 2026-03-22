import { fetch, type Response } from 'undici'
import type { AdapterRequest, AdapterResponse } from './types.js'
import type { NormalizedModel } from '../providers/types.js'
import type { OpenAIContentPart, OpenAIMessage } from '../router/types.js'
import { resolveModelCredentials } from '../providers/oauth.js'
import { formatOpenAIChunk, parseJsonSse } from './sse.js'

const GEMINI_CLI_HEADERS = {
  'User-Agent': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'X-Goog-Api-Client': 'gl-node/22.17.0',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }),
}

const ANTIGRAVITY_HEADERS = {
  'User-Agent': 'antigravity/1.18.4 darwin/arm64',
}

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.'

const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]

interface GoogleCliResponseEnvelope {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      cachedContentTokenCount?: number
      totalTokenCount?: number
      thoughtsTokenCount?: number
    }
  }
}

export async function callGoogleGeminiCli(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
): Promise<AdapterResponse> {
  const credentials = await resolveModelCredentials(model)
  if (credentials.secret === undefined || credentials.secret === '') {
    throw new Error(`No OAuth access token available for provider "${model.providerId}"`)
  }
  if (credentials.projectId === undefined || credentials.projectId === '') {
    throw new Error(`Provider "${model.providerId}" is missing the Google project id`)
  }

  const isAntigravity = model.providerId === 'google-antigravity'
  const body = buildGoogleCliBody(request, credentials.projectId, isAntigravity)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response | undefined
  try {
    const endpoints = isAntigravity
      ? Array.from(new Set([model.baseUrl, ...ANTIGRAVITY_ENDPOINT_FALLBACKS]))
      : [model.baseUrl]

    for (const endpoint of endpoints) {
      response = await fetch(resolveGoogleCliEndpoint(endpoint), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credentials.secret}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(isAntigravity ? ANTIGRAVITY_HEADERS : GEMINI_CLI_HEADERS),
          ...(needsAntigravityAnthropicBeta(model) ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
        },
        body: JSON.stringify({
          ...body,
          model: model.modelId,
        }),
        signal: controller.signal,
      })

      if (!isAntigravity || (response.status !== 403 && response.status !== 404)) {
        break
      }
    }
  } finally {
    clearTimeout(timeout)
  }

  if (response === undefined) {
    throw new Error(`No upstream response received for provider "${model.providerId}"`)
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
      stream: googleCliStreamToOpenAI(response, model.modelId),
    }
  }

  return {
    body: await googleCliResponseToOpenAI(response, model.modelId),
    statusCode: response.status,
    headers,
    streaming: false,
  }
}

function buildGoogleCliBody(
  request: AdapterRequest,
  projectId: string,
  isAntigravity: boolean,
): Record<string, unknown> {
  const systemInstruction = buildSystemInstruction(request.messages, isAntigravity)

  return {
    project: projectId,
    request: {
      contents: toGoogleContents(request.messages),
      ...(systemInstruction !== undefined ? { systemInstruction } : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      },
    },
    ...(isAntigravity ? { requestType: 'agent' } : {}),
    userAgent: isAntigravity ? 'antigravity' : 'pi-coding-agent',
    requestId: `${isAntigravity ? 'agent' : 'pi'}-${Date.now()}`,
  }
}

function buildSystemInstruction(
  messages: OpenAIMessage[],
  isAntigravity: boolean,
): { role?: 'user'; parts: Array<{ text: string }> } | undefined {
  const systemTexts = messages.flatMap((message) =>
    message.role === 'system' && typeof message.content === 'string' && message.content !== ''
      ? [message.content]
      : [],
  )

  if (systemTexts.length === 0 && !isAntigravity) {
    return undefined
  }

  const parts = [
    ...(isAntigravity
      ? [
          { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
          { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        ]
      : []),
    ...systemTexts.map((text) => ({ text })),
  ]

  return isAntigravity ? { role: 'user', parts } : { parts }
}

function toGoogleContents(
  messages: OpenAIMessage[],
): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue

    const parts = toGoogleParts(message)
    if (parts.length === 0) continue

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts,
    })
  }

  return contents
}

function toGoogleParts(message: OpenAIMessage): Array<Record<string, unknown>> {
  if (typeof message.content === 'string') {
    return message.content === '' ? [] : [{ text: message.content }]
  }

  if (message.content === null) {
    return []
  }

  return message.content.flatMap((part) => mapGoogleContentPart(part))
}

function mapGoogleContentPart(part: OpenAIContentPart): Array<Record<string, unknown>> {
  if (part.type === 'text') {
    return part.text !== undefined && part.text !== '' ? [{ text: part.text }] : []
  }

  const imageUrl = part.image_url?.url
  if (imageUrl === undefined || imageUrl === '') {
    return []
  }

  const parsed = parseDataUrl(imageUrl)
  if (parsed !== undefined) {
    return [
      {
        inlineData: {
          mimeType: parsed.mimeType,
          data: parsed.data,
        },
      },
    ]
  }

  return [{ text: `Image URL: ${imageUrl}` }]
}

async function* googleCliStreamToOpenAI(
  response: Response,
  requestedModel: string,
): AsyncIterable<string> {
  const completionId = `chatcmpl-${Date.now()}`
  yield formatOpenAIChunk(completionId, requestedModel, { role: 'assistant', content: '' }, null)

  for await (const rawEvent of parseJsonSse(response)) {
    const envelope = rawEvent as GoogleCliResponseEnvelope
    const responseData = envelope.response
    const candidate = responseData?.candidates?.[0]

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined && part.text !== '') {
        yield formatOpenAIChunk(completionId, requestedModel, { content: part.text }, null)
      }
    }

    if (candidate?.finishReason !== undefined) {
      yield formatOpenAIChunk(completionId, requestedModel, {}, mapGoogleFinishReason(candidate.finishReason))
      yield 'data: [DONE]\n\n'
      return
    }
  }

  yield formatOpenAIChunk(completionId, requestedModel, {}, 'stop')
  yield 'data: [DONE]\n\n'
}

async function googleCliResponseToOpenAI(
  response: Response,
  requestedModel: string,
): Promise<Record<string, unknown>> {
  let content = ''
  let finishReason = 'stop'
  let usage: NonNullable<GoogleCliResponseEnvelope['response']>['usageMetadata'] | undefined

  for await (const rawEvent of parseJsonSse(response)) {
    const envelope = rawEvent as GoogleCliResponseEnvelope
    const responseData = envelope.response
    const candidate = responseData?.candidates?.[0]

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text !== undefined) {
        content += part.text
      }
    }

    if (candidate?.finishReason !== undefined) {
      finishReason = mapGoogleFinishReason(candidate.finishReason)
    }

    if (responseData?.usageMetadata !== undefined) {
      usage = responseData.usageMetadata
    }
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason,
      },
    ],
    ...(usage !== undefined
      ? {
          usage: {
            prompt_tokens:
              (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0),
            completion_tokens:
              (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
            total_tokens: usage.totalTokenCount ?? 0,
          },
        }
      : {}),
  }
}

function resolveGoogleCliEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`
}

function needsAntigravityAnthropicBeta(model: NormalizedModel): boolean {
  return model.providerId === 'google-antigravity' && model.modelId.startsWith('claude-') && model.reasoning
}

function mapGoogleFinishReason(reason: string): string {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length'
    default:
      return 'stop'
  }
}

function parseDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url)
  if (match === null) {
    return undefined
  }

  const mimeType = match[1]
  const data = match[2]
  if (mimeType === undefined || data === undefined) {
    return undefined
  }

  return { mimeType, data }
}

async function parseErrorBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: text }
  }
}
