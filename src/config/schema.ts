import { z } from 'zod'

const ApiStyleSchema = z.enum([
  'openai-completions',
  'anthropic-messages',
  'openai-codex-responses',
  'google-gemini-cli',
])

const AuthModeSchema = z.enum(['token', 'api_key', 'oauth'])

const CostSchema = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
})

const RawModelEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  api: ApiStyleSchema.optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  cost: CostSchema.optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
})

const RawProviderSchema = z.object({
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  api: ApiStyleSchema.default('openai-completions'),
  authMode: AuthModeSchema.optional(),
  authProfileId: z.string().optional(),
  oauthRefreshToken: z.string().optional(),
  oauthExpiresAt: z.number().optional(),
  oauthProjectId: z.string().optional(),
  oauthAccountId: z.string().optional(),
  authHeader: z.boolean().optional(),
  models: z.array(RawModelEntrySchema).default([]),
})

const AuthProfileSchema = z.object({
  provider: z.string(),
  mode: z.enum(['token', 'api_key', 'oauth']),
})

const AgentModelRefSchema = z.object({
  alias: z.string().optional(),
})

const AgentDefaultsModelSchema = z.object({
  primary: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
})

const AgentDefaultsSchema = z.object({
  model: AgentDefaultsModelSchema.optional(),
  models: z.record(z.string(), AgentModelRefSchema).optional(),
})

export const OpenClawConfigSchema = z.object({
  models: z
    .object({
      mode: z.enum(['merge', 'override']).optional(),
      providers: z.record(z.string(), RawProviderSchema).default({}),
    })
    .optional(),
  agents: z
    .object({
      defaults: AgentDefaultsSchema.optional(),
    })
    .optional(),
  auth: z
    .object({
      profiles: z.record(z.string(), AuthProfileSchema).optional(),
    })
    .optional(),
})

export type RawModelEntry = z.infer<typeof RawModelEntrySchema>
export type RawProvider = z.infer<typeof RawProviderSchema>
export type RawConfig = z.infer<typeof OpenClawConfigSchema>
export type AuthProfile = z.infer<typeof AuthProfileSchema>
