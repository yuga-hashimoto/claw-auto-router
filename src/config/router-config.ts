import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Optional local router.config.json file.
 *
 * Use this to:
 *   - Define providers that are referenced in OpenClaw fallbacks but not in models.providers
 *     (e.g. openai-codex, anthropic, openrouter)
 *   - Override model scores / routing preferences
 *   - Denylist specific models
 */

const ExtraModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  api: z.enum(['openai-completions', 'anthropic-messages']).optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
})

const ExtraProviderSchema = z.object({
  baseUrl: z.string(),
  /** Optional static API key. Prefer env vars over putting keys in this file. */
  apiKey: z.string().optional(),
  api: z.enum(['openai-completions', 'anthropic-messages']).default('openai-completions'),
  models: z.array(ExtraModelSchema).default([]),
})

const RoutingTierSchema = z.enum(['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE'])

const RouterConfigSchema = z.object({
  /**
   * Extra provider definitions — merged into the OpenClaw provider pool.
   * Useful for providers like openai-codex or anthropic that are referenced in
   * agents.defaults.model.fallbacks but not defined in models.providers.
   */
  extraProviders: z.record(z.string(), ExtraProviderSchema).optional(),

  /** Denylist specific model composite IDs (e.g. "openai-codex/gpt-5.4") */
  denylist: z.array(z.string()).optional(),

  /**
   * Explicit tier assignment per model ID.
   * When a model is assigned to a tier, it gets top priority for that tier
   * and is deprioritized for all other tiers.
   *
   * Set interactively via the startup wizard, or edit manually.
   *
   * Example:
   *   { "kimi-coding/k2p5": "CODE", "google/gemini-flash": "SIMPLE" }
   */
  modelTiers: z.record(z.string(), RoutingTierSchema).optional(),

  /**
   * Explicit model ordering within each tier.
   * Models listed here are prioritized (in order) over heuristic ranking.
   * Models not listed use the default scoring.
   *
   * Example:
   *   { "CODE": ["kimi-coding/k2p5", "nvidia/qwen/qwen3.5-397b-a17b"] }
   */
  tierPriority: z
    .object({
      SIMPLE: z.array(z.string()).optional(),
      STANDARD: z.array(z.string()).optional(),
      COMPLEX: z.array(z.string()).optional(),
      CODE: z.array(z.string()).optional(),
    })
    .optional(),
})

export type RouterConfig = z.infer<typeof RouterConfigSchema>
export type ExtraProvider = z.infer<typeof ExtraProviderSchema>

export const DEFAULT_ROUTER_CONFIG_PATH = join(process.cwd(), 'router.config.json')

/** @internal alias kept for backwards compat */
const DEFAULT_PATH = DEFAULT_ROUTER_CONFIG_PATH

export function loadRouterConfig(overridePath?: string): RouterConfig {
  const path = overridePath ?? DEFAULT_PATH

  if (!existsSync(path)) {
    return {}
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    console.warn(`[claw-auto-router] Could not read router.config.json at "${path}"`)
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[claw-auto-router] router.config.json at "${path}" is not valid JSON, ignoring`)
    return {}
  }

  const result = RouterConfigSchema.safeParse(parsed)
  if (!result.success) {
    console.warn(
      `[claw-auto-router] router.config.json has validation issues, using what we can parse:`,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '),
    )
    return RouterConfigSchema.partial().safeParse(parsed).data ?? {}
  }

  return result.data
}
