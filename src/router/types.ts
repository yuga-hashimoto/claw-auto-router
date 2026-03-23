import type { NormalizedModel } from '../providers/types.js'

export type RoutingTier = 'SIMPLE' | 'STANDARD' | 'COMPLEX' | 'CODE'
export type ClassificationMode = 'heuristic' | 'ai'

export interface ClassificationDetail {
  tier: RoutingTier
  totalTokens: number
  lastUserMessage: string
  reasons: string[]
  mode: ClassificationMode
  classifierModelId?: string | undefined
}

export interface CandidateDecisionDetail {
  modelId: string
  modelName: string
  finalPosition: number
  configPosition: number
  sourceReason: string
  score?: number | undefined
  scoreReasons: string[]
  explicit: boolean
  transport?: string | undefined
}

export interface RoutingDecisionDetail {
  requestedModel?: string | undefined
  classification: ClassificationDetail
  candidates: CandidateDecisionDetail[]
}

export interface RouteCandidate {
  model: NormalizedModel
  position: number
  configPosition: number
  reason: string
}

export interface RouteResult {
  winner: RouteCandidate
  fallbacks: RouteCandidate[]
  tier: RoutingTier
  decision?: RoutingDecisionDetail | undefined
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
