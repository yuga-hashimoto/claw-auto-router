export type ApiStyle = 'openai-completions' | 'anthropic-messages'

export type ApiKeyResolution =
  | { status: 'resolved'; key: string }
  | { status: 'env_missing'; envVar: string }
  | { status: 'oauth'; reason: string }

export interface NormalizedModel {
  /** Composite ID: "providerId/modelId" */
  id: string
  providerId: string
  modelId: string
  name: string
  api: ApiStyle
  baseUrl: string
  apiKeyResolution: ApiKeyResolution
  reasoning: boolean
  supportsImages: boolean
  contextWindow: number
  maxTokens: number
  alias?: string | undefined
}

export interface NormalizedProvider {
  id: string
  baseUrl: string
  api: ApiStyle
  apiKeyResolution: ApiKeyResolution
  models: NormalizedModel[]
}
