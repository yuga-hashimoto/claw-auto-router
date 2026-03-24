import { describe, expect, it } from 'vitest'
import { SessionStore, resolveSessionKey } from '../../src/session-store.js'

describe('SessionStore', () => {
  it('stores and clears conversation overrides', () => {
    const store = new SessionStore()

    store.upsert('session-1', { explicitModelId: 'openai-codex/gpt-5.4' })
    expect(store.get('session-1')?.explicitModelId).toBe('openai-codex/gpt-5.4')
    expect(store.list()).toHaveLength(1)

    store.clear('session-1')
    expect(store.get('session-1')).toBeUndefined()
    expect(store.list()).toHaveLength(0)
  })

  it('drops empty overrides after an upsert clears every field', () => {
    const store = new SessionStore()

    store.upsert('session-1', {
      explicitModelId: 'openai-codex/gpt-5.4',
      forcedTier: 'CODE',
    })
    store.upsert('session-1', {
      explicitModelId: undefined,
      forcedTier: undefined,
      thinking: undefined,
    })

    expect(store.get('session-1')).toBeUndefined()
  })

  it('prunes the oldest session overrides once the store grows past the limit', () => {
    const store = new SessionStore()

    for (let index = 0; index < 205; index += 1) {
      store.upsert(`session-${index}`, { explicitModelId: `provider/model-${index}` })
    }

    expect(store.size).toBe(200)
    expect(store.get('session-0')).toBeUndefined()
    expect(store.get('session-4')).toBeUndefined()
    expect(store.get('session-204')?.explicitModelId).toBe('provider/model-204')
  })
})

describe('resolveSessionKey', () => {
  it('prefers body.session_id over other sources', () => {
    const result = resolveSessionKey({
      sessionId: 'conv-123',
      user: 'ignored-user',
      headers: { 'x-session-id': 'ignored-header' },
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result).toEqual({
      sessionId: 'conv-123',
      source: 'body.session_id',
      derived: false,
    })
  })

  it('falls back to headers before generating a fingerprint', () => {
    const result = resolveSessionKey({
      headers: { 'x-openclaw-thread-id': 'thread-456' },
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(result).toEqual({
      sessionId: 'thread-456',
      source: 'header',
      derived: false,
    })
  })

  it('derives a stable fingerprint from early non-assistant messages when needed', () => {
    const result = resolveSessionKey({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Please help me debug this.' },
        { role: 'assistant', content: 'Sure.' },
      ],
    })

    expect(result.source).toBe('conversation-fingerprint')
    expect(result.derived).toBe(true)
    expect(result.sessionId).toMatch(/^fp:/)
  })
})
