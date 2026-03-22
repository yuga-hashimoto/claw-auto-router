import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { AdapterRequest, AdapterResponse } from './types.js'
import { formatOpenAIChunk } from './sse.js'
import type { OpenAIMessage } from '../router/types.js'
import type { NormalizedModel } from '../providers/types.js'
import type { OpenClawGatewayContext } from '../openclaw/gateway.js'

const HISTORY_CONTEXT_MARKER = '[Chat messages since your last reply - for context]'
const CURRENT_MESSAGE_MARKER = '[Current message - respond to this]'
const IMAGE_ONLY_USER_MESSAGE = 'User sent image(s) with no text.'

type AgentFinalPayload = {
  runId?: string
  result?: {
    payloads?: Array<{ text?: string }>
  }
}

type GatewayAttachment = {
  type: 'image'
  mimeType: string
  content: string
}

export async function callOpenClawGateway(
  model: NormalizedModel,
  request: AdapterRequest,
  timeoutMs: number,
  gateway: OpenClawGatewayContext | undefined,
): Promise<AdapterResponse> {
  try {
    if (gateway?.available !== true) {
      throw new GatewayPromptError('OpenClaw Gateway is unavailable')
    }

    const prompt = buildGatewayPrompt(request.messages)
    const runId = `router_${randomUUID()}`
    const payload = await runGatewayCall(
      {
        message: prompt.message,
        agentId: gateway.agentId,
        model: model.id,
        sessionKey: buildSessionKey(gateway.agentId, runId),
        deliver: false,
        bestEffortDeliver: false,
        idempotencyKey: runId,
        ...(prompt.extraSystemPrompt !== undefined ? { extraSystemPrompt: prompt.extraSystemPrompt } : {}),
        ...(prompt.attachments.length > 0 ? { attachments: prompt.attachments } : {}),
      },
      timeoutMs,
      request.openClawConfigPath,
    )

    const finalRunId = payload.runId ?? runId
    const content = extractAgentResponseText(payload.result)

    if (!request.stream) {
      return {
        body: buildChatCompletionBody(finalRunId, model.id, content),
        statusCode: 200,
        headers: {},
        streaming: false,
      }
    }

    return {
      body: null,
      statusCode: 200,
      headers: {},
      streaming: true,
      stream: buildSyntheticStream(finalRunId, model.id, content),
    }
  } catch (error) {
    const { statusCode, message } = normalizeGatewayError(error)
    return {
      body: {
        error: {
          message,
          type: 'gateway_error',
          code: statusCode,
        },
      },
      statusCode,
      headers: {},
      streaming: false,
    }
  }
}

async function runGatewayCall(
  params: Record<string, unknown>,
  timeoutMs: number,
  configPath?: string,
): Promise<AgentFinalPayload> {
  const args = [
    'gateway',
    'call',
    'agent',
    '--json',
    '--expect-final',
    '--timeout',
    String(timeoutMs),
    '--params',
    JSON.stringify(params),
  ]

  return await new Promise<AgentFinalPayload>((resolve, reject) => {
    const child = spawn('openclaw', args, {
      env: {
        ...process.env,
        ...(configPath !== undefined ? { OPENCLAW_CONFIG_PATH: configPath } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      reject(new GatewayCliError(error.message))
    })
    child.on('close', (code) => {
      const payload =
        parseJsonFromText<AgentFinalPayload>(stdout) ??
        parseJsonFromText<AgentFinalPayload>(stderr)

      if (code === 0 && payload !== undefined) {
        resolve(payload)
        return
      }

      reject(
        new GatewayCliError(
          extractGatewayCliMessage(stderr) ??
            extractGatewayCliMessage(stdout) ??
            `OpenClaw gateway call failed with exit code ${code ?? 'unknown'}`,
        ),
      )
    })
  })
}

async function* buildSyntheticStream(id: string, model: string, content: string): AsyncIterable<string> {
  yield formatOpenAIChunk(id, model, { role: 'assistant' }, null)
  if (content !== '') {
    yield formatOpenAIChunk(id, model, { content }, null)
  }
  yield formatOpenAIChunk(id, model, {}, 'stop')
  yield 'data: [DONE]\n\n'
}

function buildSessionKey(agentId: string, runId: string): string {
  return `agent:${agentId}:claw-auto-router:${runId}`
}

function buildChatCompletionBody(id: string, model: string, content: string) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

function extractAgentResponseText(result: AgentFinalPayload['result'] | undefined): string {
  const payloads = result?.payloads
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return 'No response from OpenClaw.'
  }

  const text = payloads
    .map((payload) => (typeof payload?.text === 'string' ? payload.text : ''))
    .filter((value) => value !== '')
    .join('\n\n')

  return text === '' ? 'No response from OpenClaw.' : text
}

function parseJsonFromText<T>(text: string): T | undefined {
  const firstBrace = text.indexOf('{')
  if (firstBrace === -1) {
    return undefined
  }

  try {
    return JSON.parse(text.slice(firstBrace)) as T
  } catch {
    return undefined
  }
}

function extractGatewayCliMessage(text: string): string | undefined {
  const trimmed = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop()

  return trimmed === undefined ? undefined : trimmed
}

function normalizeGatewayError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof GatewayPromptError) {
    return { statusCode: 400, message: error.message }
  }

  if (error instanceof GatewayCliError) {
    const message = error.message
    if (message.includes('invalid agent params') || message.includes('invalid request')) {
      return { statusCode: 400, message }
    }
    if (message.includes('Unauthorized')) {
      return { statusCode: 401, message }
    }
    if (message.includes('Forbidden')) {
      return { statusCode: 403, message }
    }
    return { statusCode: 502, message }
  }

  if (error instanceof Error) {
    return { statusCode: 502, message: error.message }
  }

  return { statusCode: 502, message: 'OpenClaw Gateway request failed' }
}

class GatewayCliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayCliError'
  }
}

class GatewayPromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayPromptError'
  }
}

function buildGatewayPrompt(messages: OpenAIMessage[]): {
  message: string
  extraSystemPrompt?: string | undefined
  attachments: GatewayAttachment[]
} {
  const active = resolveActiveTurn(messages)
  const systemParts: string[] = []
  const conversationEntries: Array<{ sender: string; body: string; role: 'user' | 'assistant' | 'tool' }> = []

  for (const [index, message] of messages.entries()) {
    const normalizedRole = normalizeRole(message.role)
    if (normalizedRole === undefined) {
      continue
    }

    const text = extractTextContent(message.content).trim()
    const hasImages = extractImageUrls(message.content).length > 0

    if (message.role === 'system') {
      if (text !== '') {
        systemParts.push(text)
      }
      continue
    }

    const body =
      normalizedRole === 'user' && index === active.activeUserMessageIndex && text === '' && hasImages
        ? IMAGE_ONLY_USER_MESSAGE
        : text

    if (body === '') {
      continue
    }

    conversationEntries.push({
      role: normalizedRole,
      sender:
        normalizedRole === 'assistant'
          ? 'Assistant'
          : normalizedRole === 'tool'
            ? message.name?.trim() ? `Tool:${message.name.trim()}` : 'Tool'
            : 'User',
      body,
    })
  }

  const activeUserMessage =
    active.activeUserMessageIndex >= 0 ? messages[active.activeUserMessageIndex] : undefined
  const attachments = activeUserMessage !== undefined ? buildGatewayAttachments(activeUserMessage.content) : []

  return {
    message: buildConversationPrompt(conversationEntries),
    ...(systemParts.length > 0 ? { extraSystemPrompt: systemParts.join('\n\n') } : {}),
    attachments,
  }
}

function buildConversationPrompt(
  entries: Array<{ sender: string; body: string; role: 'user' | 'assistant' | 'tool' }>,
): string {
  if (entries.length === 0) {
    return ''
  }

  let currentIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const role = entries[index]?.role
    if (role === 'user' || role === 'tool') {
      currentIndex = index
      break
    }
  }

  if (currentIndex < 0) {
    currentIndex = entries.length - 1
  }

  const current = entries[currentIndex]
  if (current === undefined) {
    return ''
  }

  const formatEntry = (entry: { sender: string; body: string }) => `${entry.sender}: ${entry.body}`
  const currentMessage = formatEntry(current)
  const history = entries.slice(0, currentIndex).map(formatEntry).join('\n')

  if (history === '') {
    return current.body
  }

  return [HISTORY_CONTEXT_MARKER, history, '', CURRENT_MESSAGE_MARKER, currentMessage].join('\n')
}

function resolveActiveTurn(messages: OpenAIMessage[]): { activeUserMessageIndex: number } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) {
      continue
    }
    const role = normalizeRole(message.role)
    if (role === 'user') {
      return { activeUserMessageIndex: index }
    }
    if (role === 'tool') {
      return { activeUserMessageIndex: -1 }
    }
  }

  return { activeUserMessageIndex: -1 }
}

function buildGatewayAttachments(content: OpenAIMessage['content']): GatewayAttachment[] {
  const urls = extractImageUrls(content)
  return urls.map((url, index) => {
    const parsed = parseDataImage(url)
    if (parsed === undefined) {
      throw new GatewayPromptError(
        `Only data:image URLs are supported when routing through OpenClaw Gateway (image ${index + 1}).`,
      )
    }

    return {
      type: 'image',
      mimeType: parsed.mimeType,
      content: parsed.base64,
    }
  })
}

function parseDataImage(url: string): { mimeType: string; base64: string } | undefined {
  const match = url.match(/^data:(image\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/)
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined
  }

  return {
    mimeType: match[1],
    base64: match[2],
  }
}

function extractTextContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content
    .map((part) => (part.type === 'text' ? part.text ?? '' : ''))
    .filter((value) => value !== '')
    .join('\n')
}

function extractImageUrls(content: OpenAIMessage['content']): string[] {
  if (!Array.isArray(content)) {
    return []
  }

  return content
    .map((part) => (part.type === 'image_url' ? normalizeString(part.image_url?.url) : undefined))
    .filter((value): value is string => value !== undefined)
}

function normalizeRole(role: OpenAIMessage['role']): 'user' | 'assistant' | 'tool' | undefined {
  if (role === 'user' || role === 'assistant' || role === 'tool') {
    return role
  }

  if (role === 'function') {
    return 'tool'
  }

  return undefined
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
