import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { ProxyAttempt } from './proxy/types.js'
import type { ClassificationDetail, CandidateDecisionDetail } from './router/types.js'
import { resolveUserPath } from './utils/paths.js'

const DEFAULT_LOG_FILENAME = 'router.decisions.jsonl'
const MAX_DECISION_LOG_ENTRIES = 100

export interface RoutingDecisionLogEntry {
  timestamp: string
  requestId: string
  requestedModel: string
  resolvedModel: string
  success: boolean
  fallbackUsed: boolean
  stream: boolean
  totalDurationMs: number
  messageCount: number
  classification: ClassificationDetail
  candidates: CandidateDecisionDetail[]
  attempts: Array<{
    modelId: string
    success: boolean
    durationMs: number
    statusCode?: number | undefined
    error?: string | undefined
  }>
  error?: string | undefined
}

export function resolveDecisionLogPath(configPath?: string): string {
  if (configPath !== undefined) {
    return join(dirname(resolveUserPath(configPath)), DEFAULT_LOG_FILENAME)
  }

  return join(homedir(), '.openclaw', DEFAULT_LOG_FILENAME)
}

export function appendDecisionLogEntry(entry: RoutingDecisionLogEntry, configPath?: string): string {
  const path = resolveDecisionLogPath(configPath)
  mkdirSync(dirname(path), { recursive: true })
  const entries = readAllDecisionLogEntries(path)
  entries.push(entry)
  const trimmedEntries = entries.slice(-MAX_DECISION_LOG_ENTRIES)
  writeFileSync(
    path,
    trimmedEntries.map((item) => JSON.stringify(item)).join('\n') + '\n',
    'utf-8',
  )
  return path
}

export function readDecisionLogEntries(limit = 20, configPath?: string): RoutingDecisionLogEntry[] {
  const path = resolveDecisionLogPath(configPath)
  const entries = readAllDecisionLogEntries(path)
  return entries.slice(-limit).reverse()
}

export function renderDecisionLogEntries(entries: RoutingDecisionLogEntry[]): string {
  if (entries.length === 0) {
    return '[claw-auto-router] No routing decisions have been logged yet.'
  }

  return entries.map((entry) => renderDecisionLogEntry(entry)).join('\n\n')
}

export function buildDecisionLogEntry(input: {
  requestId: string
  requestedModel: string
  resolvedModel: string
  success: boolean
  fallbackUsed: boolean
  stream: boolean
  totalDurationMs: number
  messageCount: number
  classification: ClassificationDetail
  candidates: CandidateDecisionDetail[]
  attempts: ProxyAttempt[]
  error?: string | undefined
}): RoutingDecisionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    requestId: input.requestId,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    success: input.success,
    fallbackUsed: input.fallbackUsed,
    stream: input.stream,
    totalDurationMs: input.totalDurationMs,
    messageCount: input.messageCount,
    classification: {
      ...input.classification,
      lastUserMessage: truncateText(input.classification.lastUserMessage, 500),
    },
    candidates: input.candidates,
    attempts: input.attempts.map((attempt) => ({
      modelId: attempt.model.id,
      success: attempt.success,
      durationMs: attempt.durationMs,
      ...(attempt.statusCode !== undefined ? { statusCode: attempt.statusCode } : {}),
      ...(attempt.error !== undefined ? { error: attempt.error } : {}),
    })),
    ...(input.error !== undefined ? { error: input.error } : {}),
  }
}

function renderDecisionLogEntry(entry: RoutingDecisionLogEntry): string {
  const lines = [
    `[${entry.timestamp}] ${entry.success ? 'SUCCESS' : 'FAILED'} request=${entry.requestId} tier=${entry.classification.tier} requested=${entry.requestedModel} resolved=${entry.resolvedModel}`,
    `Message: ${entry.classification.lastUserMessage === '' ? '(no user text)' : entry.classification.lastUserMessage}`,
    `Classifier: ${entry.classification.reasons.join('; ')} | approx ${entry.classification.totalTokens} tokens across ${entry.messageCount} messages`,
  ]

  if (entry.candidates.length > 0) {
    lines.push('Candidates:')
    for (const candidate of entry.candidates.slice(0, 8)) {
      const score =
        candidate.score !== undefined
          ? `score=${candidate.score}`
          : 'score=bypassed'
      const transport = candidate.transport !== undefined ? ` transport=${candidate.transport}` : ''
      lines.push(
        `  ${candidate.finalPosition + 1}. ${candidate.modelId} ${score}${transport} | ${candidate.sourceReason}`,
      )
      lines.push(`     ${candidate.scoreReasons.join('; ')}`)
    }
  }

  if (entry.attempts.length > 0) {
    lines.push('Attempts:')
    for (const attempt of entry.attempts) {
      const status = attempt.statusCode !== undefined ? ` status=${attempt.statusCode}` : ''
      const error = attempt.error !== undefined ? ` error=${attempt.error}` : ''
      lines.push(
        `  - ${attempt.modelId} ${attempt.success ? 'ok' : 'failed'}${status} duration=${attempt.durationMs}ms${error}`,
      )
    }
  }

  lines.push(
    `Outcome: duration=${entry.totalDurationMs}ms fallback=${entry.fallbackUsed ? 'yes' : 'no'} stream=${entry.stream ? 'yes' : 'no'}`,
  )
  if (entry.error !== undefined) {
    lines.push(`Error: ${entry.error}`)
  }

  return lines.join('\n')
}

function readAllDecisionLogEntries(path: string): RoutingDecisionLogEntry[] {
  if (!existsSync(path)) {
    return []
  }

  const raw = readFileSync(path, 'utf-8')
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const entries: RoutingDecisionLogEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as RoutingDecisionLogEntry)
    } catch {
      // Ignore malformed log lines and keep showing the valid history.
    }
  }

  return entries
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 1)}...`
}
