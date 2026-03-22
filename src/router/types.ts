import type { NormalizedModel } from '../providers/types.js'

export type RoutingTier = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'CODE'

export interface RouteCandidate {
  model: NormalizedModel
  position: number
  reason: string
}

export interface RouteResult {
  winner: RouteCandidate
  fallbacks: RouteCandidate[]
  tier: RoutingTier
}

export interface RoutingRequest {
  model?: string | undefined
  messages: OpenAIMessage[]
  stream?: boolean | undefined
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool'
  content: string | OpenAIContentPart[] | null
  name?: string | undefined
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string | undefined
  image_url?: { url: string } | undefined
}
