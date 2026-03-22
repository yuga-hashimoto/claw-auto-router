import type { NormalizedModel } from '../providers/types.js'

export interface ProxyAttempt {
  model: NormalizedModel
  durationMs: number
  success: boolean
  statusCode?: number
  error?: string
}

export interface ProxyResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any
  attempts: ProxyAttempt[]
  finalModel: NormalizedModel
  streaming: boolean
  stream?: AsyncIterable<string> | undefined
}
