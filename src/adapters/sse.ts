import type { Response } from 'undici'

export async function* parseJsonSse(response: Response): AsyncIterable<unknown> {
  if (response.body === null) return

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })

    while (true) {
      const separator = buffer.indexOf('\n\n')
      if (separator === -1) break

      const rawEvent = buffer.slice(0, separator)
      buffer = buffer.slice(separator + 2)

      const data = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
        .trim()

      if (data === '' || data === '[DONE]') {
        continue
      }

      try {
        yield JSON.parse(data)
      } catch {
        // Ignore malformed SSE frames from upstream providers.
      }
    }
  }

  const trailing = buffer.trim()
  if (trailing === '') {
    return
  }

  const data = trailing
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')
    .trim()

  if (data === '' || data === '[DONE]') {
    return
  }

  try {
    yield JSON.parse(data)
  } catch {
    // Ignore malformed trailing SSE frames.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formatOpenAIChunk(id: string, model: string, delta: Record<string, any>, finishReason: string | null): string {
  return (
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`
  )
}
