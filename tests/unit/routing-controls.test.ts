import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../../src/providers/registry.js'
import { resolveRoutingControlCommand } from '../../src/routing-controls.js'
import type { NormalizedModel } from '../../src/providers/types.js'

function makeModel(id: string, name = id): NormalizedModel {
  return {
    id,
    providerId: id.split('/')[0] ?? 'provider',
    modelId: id.split('/').slice(1).join('/'),
    name,
    api: 'openai-completions',
    baseUrl: 'https://example.com',
    apiKeyResolution: { status: 'resolved', key: 'test-key' },
    reasoning: false,
    supportsImages: false,
    contextWindow: 128000,
    maxTokens: 4096,
  }
}

const registry = new ProviderRegistry([
  makeModel('anthropic/claude-opus-4-6', 'Claude Opus 4.6'),
  makeModel('openai-codex/gpt-5.4', 'GPT-5.4'),
  makeModel('github-copilot/gpt-4o', 'GPT-4o'),
])

describe('resolveRoutingControlCommand', () => {
  it('detects model override commands', () => {
    const resolution = resolveRoutingControlCommand('use opus', registry)

    expect(resolution?.action.type).toBe('set-model')
    expect(resolution?.action.type === 'set-model' ? resolution.action.model.id : undefined).toBe(
      'anthropic/claude-opus-4-6',
    )
  })

  it('detects tier override commands', () => {
    const resolution = resolveRoutingControlCommand('prefer code', registry)

    expect(resolution).toEqual({
      action: { type: 'set-tier', tier: 'CODE' },
      userMessage: 'prefer code',
    })
  })

  it('detects conversation-level thinking commands', () => {
    const resolution = resolveRoutingControlCommand('thinking high', registry)

    expect(resolution?.action.type).toBe('set-thinking')
    expect(
      resolution?.action.type === 'set-thinking' ? resolution.action.thinking.effort : undefined,
    ).toBe('high')
  })

  it('ignores normal prompts that only happen to start with routing verbs', () => {
    const resolution = resolveRoutingControlCommand(
      'use gpt-4o to summarize the attached proposal and call out risks',
      registry,
    )

    expect(resolution).toBeUndefined()
  })
})
