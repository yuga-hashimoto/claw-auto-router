import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendDecisionLogEntry,
  buildDecisionLogEntry,
  readDecisionLogEntries,
  renderDecisionLogEntries,
  resolveDecisionLogPath,
} from '../../src/decision-log.js'

describe('decision log', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('writes and reads back routing decisions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'decision-log-test-'))
    const configPath = join(tempDir, 'moltbot.json')
    writeFileSync(configPath, '{}\n', 'utf-8')

    appendDecisionLogEntry(
      buildDecisionLogEntry({
        requestId: 'req-1',
        requestedModel: 'auto',
        resolvedModel: 'openai-codex/gpt-5.4',
        success: true,
        fallbackUsed: false,
        stream: false,
        totalDurationMs: 1234,
        messageCount: 1,
        classification: {
          tier: 'CODE',
          totalTokens: 42,
          lastUserMessage: 'Please refactor this function.',
          reasons: ['Matched a coding-task phrase in the latest user message'],
        },
        candidates: [
          {
            modelId: 'openai-codex/gpt-5.4',
            modelName: 'GPT-5.4',
            finalPosition: 0,
            configPosition: 3,
            sourceReason: 'fallback from OpenClaw config',
            score: 144,
            scoreReasons: ['Config order base score 97', '+25 coder-model keyword bonus for CODE'],
            explicit: false,
            transport: 'openclaw-gateway',
          },
        ],
        attempts: [
          {
            model: {
              id: 'openai-codex/gpt-5.4',
              providerId: 'openai-codex',
              modelId: 'gpt-5.4',
              name: 'GPT-5.4',
              api: 'openai-completions',
              baseUrl: 'https://example.com',
              apiKeyResolution: { status: 'resolved', key: 'test' },
              reasoning: false,
              supportsImages: false,
              contextWindow: 128000,
              maxTokens: 8192,
            },
            durationMs: 1200,
            success: true,
            statusCode: 200,
          },
        ],
      }),
      configPath,
    )

    const entries = readDecisionLogEntries(10, configPath)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.resolvedModel).toBe('openai-codex/gpt-5.4')
    expect(entries[0]?.classification.tier).toBe('CODE')
    expect(resolveDecisionLogPath(configPath)).toBe(join(tempDir, 'router.decisions.jsonl'))
  })

  it('renders a human-readable summary', () => {
    const output = renderDecisionLogEntries([
      {
        timestamp: '2026-03-23T00:00:00.000Z',
        requestId: 'req-2',
        requestedModel: 'auto',
        resolvedModel: 'kimi-coding/k2p5',
        success: true,
        fallbackUsed: true,
        stream: false,
        totalDurationMs: 2345,
        messageCount: 2,
        classification: {
          tier: 'COMPLEX',
          totalTokens: 900,
          lastUserMessage: 'Analyze this architecture.',
          reasons: ['Matched an analysis or research keyword in the latest user message'],
        },
        candidates: [],
        attempts: [],
      },
    ])

    expect(output).toContain('tier=COMPLEX')
    expect(output).toContain('Analyze this architecture.')
    expect(output).toContain('duration=2345ms')
  })
})
