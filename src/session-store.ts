import { createHash } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { ThinkingConfig } from './adapters/types.js'
import type { OpenAIMessage, OpenAIContentPart, RoutingTier } from './router/types.js'

const MAX_SESSION_OVERRIDES = 200

export interface SessionRoutingPreferences {
  explicitModelId?: string | undefined
  forcedTier?: RoutingTier | undefined
  thinking?: ThinkingConfig | undefined
  updatedAt: number
}

export interface SessionKeyResolution {
  sessionId?: string | undefined
  source: 'body.session_id' | 'body.user' | 'header' | 'conversation-fingerprint' | 'none'
  derived: boolean
}

export interface SessionSummary {
  sessionId: string
  explicitModelId?: string | undefined
  forcedTier?: RoutingTier | undefined
  thinking?: ThinkingConfig | undefined
  updatedAt: string
}

export class SessionStore {
  private readonly entries = new Map<string, SessionRoutingPreferences>()

  get(sessionId: string | undefined): SessionRoutingPreferences | undefined {
    if (sessionId === undefined) {
      return undefined
    }

    return this.entries.get(sessionId)
  }

  upsert(sessionId: string, update: Partial<Omit<SessionRoutingPreferences, 'updatedAt'>>): SessionRoutingPreferences {
    const existing = this.entries.get(sessionId)
    const next: SessionRoutingPreferences = {
      ...existing,
      ...update,
      updatedAt: Date.now(),
    }

    if (next.explicitModelId === undefined && next.forcedTier === undefined && next.thinking === undefined) {
      this.entries.delete(sessionId)
      return next
    }

    this.entries.set(sessionId, next)
    this.prune()
    return next
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  list(limit = 20): SessionSummary[] {
    return Array.from(this.entries.entries())
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, limit)
      .map(([sessionId, value]) => ({
        sessionId,
        ...(value.explicitModelId !== undefined ? { explicitModelId: value.explicitModelId } : {}),
        ...(value.forcedTier !== undefined ? { forcedTier: value.forcedTier } : {}),
        ...(value.thinking !== undefined ? { thinking: value.thinking } : {}),
        updatedAt: new Date(value.updatedAt).toISOString(),
      }))
  }

  get size(): number {
    return this.entries.size
  }

  private prune(): void {
    if (this.entries.size <= MAX_SESSION_OVERRIDES) {
      return
    }

    const oldest = Array.from(this.entries.entries())
      .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
      .slice(0, this.entries.size - MAX_SESSION_OVERRIDES)

    for (const [sessionId] of oldest) {
      this.entries.delete(sessionId)
    }
  }
}

export function resolveSessionKey(input: {
  sessionId?: string | undefined
  user?: string | undefined
  headers?: IncomingHttpHeaders | undefined
  messages: OpenAIMessage[]
}): SessionKeyResolution {
  const fromBodySession = normalizeSessionValue(input.sessionId)
  if (fromBodySession !== undefined) {
    return { sessionId: fromBodySession, source: 'body.session_id', derived: false }
  }

  const fromBodyUser = normalizeSessionValue(input.user)
  if (fromBodyUser !== undefined) {
    return { sessionId: fromBodyUser, source: 'body.user', derived: false }
  }

  const headerCandidates = [
    input.headers?.['x-router-session-id'],
    input.headers?.['x-session-id'],
    input.headers?.['x-openclaw-session-id'],
    input.headers?.['x-openclaw-thread-id'],
  ]

  for (const candidate of headerCandidates) {
    const normalized = normalizeHeaderValue(candidate)
    if (normalized !== undefined) {
      return { sessionId: normalized, source: 'header', derived: false }
    }
  }

  const fingerprint = buildConversationFingerprint(input.messages)
  if (fingerprint !== undefined) {
    return { sessionId: fingerprint, source: 'conversation-fingerprint', derived: true }
  }

  return { source: 'none', derived: false }
}

function normalizeSessionValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed !== '' ? trimmed : undefined
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return normalizeSessionValue(value[0])
  }

  return normalizeSessionValue(value)
}

function buildConversationFingerprint(messages: OpenAIMessage[]): string | undefined {
  const basis = messages
    .filter((message) => message.role !== 'assistant')
    .slice(0, 4)
    .map((message) => `${message.role}:${renderMessageContent(message.content)}`)
    .join('\n')
    .trim()

  if (basis === '') {
    return undefined
  }

  const digest = createHash('sha1').update(basis).digest('hex').slice(0, 16)
  return `fp:${digest}`
}

function renderMessageContent(content: string | OpenAIContentPart[] | null): string {
  if (content === null) {
    return ''
  }

  if (typeof content === 'string') {
    return content
  }

  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text ?? ''
      }

      if (part.type === 'image_url') {
        return '[image]'
      }

      return ''
    })
    .join(' ')
}
