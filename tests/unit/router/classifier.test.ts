import { describe, it, expect } from 'vitest'
import { classifyRequest } from '../../../src/router/classifier.js'
import type { RoutingRequest } from '../../../src/router/types.js'

function req(content: string): RoutingRequest {
  return { messages: [{ role: 'user', content }] }
}

function longReq(words: number): RoutingRequest {
  return { messages: [{ role: 'user', content: 'word '.repeat(words) }] }
}

describe('classifyRequest', () => {
  it('classifies code block as CODE', () => {
    expect(classifyRequest(req('Fix this:\n```python\nprint("hello")\n```'))).toBe('CODE')
  })

  it('classifies coding task keywords as CODE', () => {
    expect(classifyRequest(req('debug this function for me'))).toBe('CODE')
    expect(classifyRequest(req('implement a class for authentication'))).toBe('CODE')
    expect(classifyRequest(req('refactor this code to be cleaner'))).toBe('CODE')
  })

  it('classifies analysis keywords as COMPLEX', () => {
    expect(classifyRequest(req('analyze the architecture of this system'))).toBe('COMPLEX')
    expect(classifyRequest(req('compare these two approaches'))).toBe('COMPLEX')
    expect(classifyRequest(req('evaluate the performance tradeoffs'))).toBe('COMPLEX')
  })

  it('classifies very long messages as COMPLEX', () => {
    // > 2000 tokens ~ 8000+ chars
    expect(classifyRequest(longReq(2500))).toBe('COMPLEX')
  })

  it('classifies short greetings as SIMPLE', () => {
    expect(classifyRequest(req('Hello!'))).toBe('SIMPLE')
    expect(classifyRequest(req('Hi there'))).toBe('SIMPLE')
    expect(classifyRequest(req('thanks'))).toBe('SIMPLE')
  })

  it('classifies simple Q&A as SIMPLE', () => {
    expect(classifyRequest(req('What is the capital of France?'))).toBe('SIMPLE')
    expect(classifyRequest(req("Who is the president?"))).toBe('SIMPLE')
  })

  it('classifies default conversation as STANDARD', () => {
    expect(classifyRequest(req('Tell me about machine learning'))).toBe('STANDARD')
    expect(classifyRequest(req('How does photosynthesis work?'))).toBe('STANDARD')
  })

  it('handles multi-turn conversations', () => {
    const request: RoutingRequest = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'implement a sorting algorithm' },
      ],
    }
    expect(classifyRequest(request)).toBe('CODE')
  })
})
