export type ApiStyle =
  | 'openai-completions'
  | 'anthropic-messages'
  | 'openai-codex-responses'
  | 'google-gemini-cli'

export type ExecutionMode = 'direct' | 'openclaw-gateway'

export type AuthMode = 'token' | 'api_key' | 'oauth'

export type ApiKeyResolution =
  | { status: 'resolved'; key: string }
  | { status: 'env_missing'; envVar: string }
  | { status: 'oauth'; reason: string }

export interface ModelCost {
  input: number
  output: number
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
}

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
  transport?: ExecutionMode | undefined
  available?: boolean | undefined
  unavailableReason?: string | undefined
  authMode?: AuthMode | undefined
  authProfileId?: string | undefined
  oauthRefreshToken?: string | undefined
  oauthExpiresAt?: number | undefined
  oauthProjectId?: string | undefined
  oauthAccountId?: string | undefined
  authHeader?: boolean | undefined
  cost?: ModelCost | undefined
}

export interface NormalizedProvider {
  id: string
  baseUrl: string
  api: ApiStyle
  apiKeyResolution: ApiKeyResolution
  models: NormalizedModel[]
  transport?: ExecutionMode | undefined
  available?: boolean | undefined
  unavailableReason?: string | undefined
  authMode?: AuthMode | undefined
  authProfileId?: string | undefined
  oauthRefreshToken?: string | undefined
  oauthExpiresAt?: number | undefined
  oauthProjectId?: string | undefined
  oauthAccountId?: string | undefined
  authHeader?: boolean | undefined
}

export function isModelAvailable(model: NormalizedModel): boolean {
  if (typeof model.available === 'boolean') {
    return model.available
  }

  return model.apiKeyResolution.status === 'resolved'
}
