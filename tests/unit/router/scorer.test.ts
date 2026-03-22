import { describe, it, expect } from 'vitest'
import { scoreCandidate, rankCandidates } from '../../../src/router/scorer.js'
import type { NormalizedModel } from '../../../src/providers/types.js'

const makeModel = (overrides: Partial<NormalizedModel> & { id: string }): NormalizedModel => ({
  id: overrides.id,
  providerId: overrides.id.split('/')[0] ?? 'p',
  modelId: overrides.id.split('/').slice(1).join('/'),
  name: overrides.name ?? overrides.id,
  api: 'openai-completions',
  baseUrl: 'https://example.com',
  apiKeyResolution: { status: 'resolved', key: 'key' },
  reasoning: false,
  supportsImages: false,
  contextWindow: 128000,
  maxTokens: 4096,
  ...overrides,
})

describe('scoreCandidate', () => {
  describe('CODE tier', () => {
    it('gives bonus for reasoning=true', () => {
      const base = scoreCandidate(makeModel({ id: 'p/model', name: 'Model' }), 'CODE', 0)
      const reasoning = scoreCandidate(makeModel({ id: 'p/model', reasoning: true, name: 'Model' }), 'CODE', 0)
      expect(reasoning).toBeGreaterThan(base)
    })

    it('gives bonus for coder model name', () => {
      const base = scoreCandidate(makeModel({ id: 'p/model', name: 'Generic Model' }), 'CODE', 0)
      const coder = scoreCandidate(makeModel({ id: 'p/coder', name: 'Kimi Coder' }), 'CODE', 0)
      expect(coder).toBeGreaterThan(base)
    })

    it('penalizes flash/mini models', () => {
      const full = scoreCandidate(makeModel({ id: 'p/big', name: 'Big Model' }), 'CODE', 0)
      const flash = scoreCandidate(makeModel({ id: 'p/flash', name: 'Flash Model' }), 'CODE', 0)
      expect(flash).toBeLessThan(full)
    })
  })

  describe('COMPLEX tier', () => {
    it('gives bonus for reasoning=true', () => {
      const base = scoreCandidate(makeModel({ id: 'p/m', name: 'M' }), 'COMPLEX', 0)
      const reasoning = scoreCandidate(makeModel({ id: 'p/m', reasoning: true, name: 'M' }), 'COMPLEX', 0)
      expect(reasoning).toBeGreaterThan(base)
    })

    it('gives bonus for large context window', () => {
      const small = scoreCandidate(makeModel({ id: 'p/m', contextWindow: 32000 }), 'COMPLEX', 0)
      const large = scoreCandidate(makeModel({ id: 'p/m', contextWindow: 200000 }), 'COMPLEX', 0)
      expect(large).toBeGreaterThan(small)
    })

    it('penalizes small models', () => {
      const full = scoreCandidate(makeModel({ id: 'p/m', name: 'Full Model' }), 'COMPLEX', 0)
      const mini = scoreCandidate(makeModel({ id: 'p/m', name: 'Mini Model' }), 'COMPLEX', 0)
      expect(mini).toBeLessThan(full)
    })
  })

  describe('SIMPLE tier', () => {
    it('gives bonus for flash/mini models', () => {
      const base = scoreCandidate(makeModel({ id: 'p/m', name: 'Model' }), 'SIMPLE', 0)
      const flash = scoreCandidate(makeModel({ id: 'p/m', name: 'Flash Model' }), 'SIMPLE', 0)
      expect(flash).toBeGreaterThan(base)
    })

    it('penalizes reasoning models', () => {
      const normal = scoreCandidate(makeModel({ id: 'p/m', reasoning: false }), 'SIMPLE', 0)
      const reasoning = scoreCandidate(makeModel({ id: 'p/m', reasoning: true }), 'SIMPLE', 0)
      expect(reasoning).toBeLessThan(normal)
    })
  })

  describe('STANDARD tier', () => {
    it('reflects only config position (no bonuses)', () => {
      const pos0 = scoreCandidate(makeModel({ id: 'p/m' }), 'STANDARD', 0)
      const pos1 = scoreCandidate(makeModel({ id: 'p/m' }), 'STANDARD', 1)
      expect(pos0).toBeGreaterThan(pos1)
    })
  })
})

describe('rankCandidates', () => {
  it('sorts by score descending for CODE tier', () => {
    const candidates = [
      { model: makeModel({ id: 'p/normal', name: 'Normal', reasoning: false }), position: 0, reason: '' },
      { model: makeModel({ id: 'p/reasoner', name: 'Reasoner', reasoning: true }), position: 1, reason: '' },
      { model: makeModel({ id: 'p/flash', name: 'Flash Model', reasoning: false }), position: 2, reason: '' },
    ]

    const ranked = rankCandidates(candidates, 'CODE')
    // Reasoning model should win for CODE even if it's position 1 in config
    expect(ranked[0]?.model.id).toBe('p/reasoner')
  })

  it('sorts by score descending for SIMPLE tier', () => {
    const candidates = [
      { model: makeModel({ id: 'p/heavy', name: 'Heavy Model', reasoning: true, contextWindow: 200000 }), position: 0, reason: '' },
      { model: makeModel({ id: 'p/flash', name: 'Flash Model', reasoning: false }), position: 1, reason: '' },
    ]

    const ranked = rankCandidates(candidates, 'SIMPLE')
    // Flash model should win for SIMPLE even if it's position 1 in config
    expect(ranked[0]?.model.id).toBe('p/flash')
  })

  it('preserves config order for STANDARD tier', () => {
    const candidates = [
      { model: makeModel({ id: 'p/first', reasoning: true, contextWindow: 200000 }), position: 0, reason: '' },
      { model: makeModel({ id: 'p/second', reasoning: false }), position: 1, reason: '' },
    ]

    const ranked = rankCandidates(candidates, 'STANDARD')
    expect(ranked[0]?.model.id).toBe('p/first')
    expect(ranked[1]?.model.id).toBe('p/second')
  })
})
