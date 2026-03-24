import type { OpenAIMessage } from '../router/types.js'
import type { OpenClawGatewayContext } from '../openclaw/gateway.js'

export interface ThinkingConfig {
  type: 'enabled'
  budgetTokens?: number | undefined
  interleaved?: boolean | undefined
  effort?: 'low' | 'medium' | 'high' | undefined
  source?: 'request' | 'session' | 'reasoning_effort' | 'command' | undefined
}

export interface AdapterRequest {
  messages: OpenAIMessage[]
  model: string          // upstream model ID (modelId, not composite)
  maxTokens?: number | undefined
  temperature?: number | undefined
  stream: boolean
  thinking?: ThinkingConfig | undefined
  openClawConfigPath?: string | undefined
  openClawGateway?: OpenClawGatewayContext | undefined
  // Pass-through any extra OpenAI fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any> | undefined
}

export interface AdapterResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
  statusCode: number
  headers: Record<string, string>
  streaming: boolean
  /** For streaming: async iterable of SSE chunks in OpenAI format */
  stream?: AsyncIterable<string> | undefined
}
