import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { DEFAULT_BASE_URL } from '../defaults.js'
import { resolveUserPath } from '../utils/paths.js'

const RoutingTierSchema = z.enum(['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE'])
const RoutingClassificationModeSchema = z.enum(['heuristic', 'ai'])

const RouterAIConfigSchema = z.object({
  mode: RoutingClassificationModeSchema.default('heuristic'),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().max(60_000).default(8_000),
})

const DashboardConfigSchema = z.object({
  baselineModel: z.string().optional(),
  refreshSeconds: z.number().int().positive().max(60).default(5),
})

const OpenClawIntegrationSchema = z.object({
  providerId: z.string().default('claw-auto-router'),
  modelId: z.string().default('auto'),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  upstreamPrimary: z.string().optional(),
  upstreamFallbacks: z.array(z.string()).optional(),
})

const RouterConfigSchema = z.object({
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

  /**
   * Metadata written by `claw-auto-router setup`.
   *
   * This lets OpenClaw point at the router while the router still remembers
   * the original upstream primary/fallback chain and avoids routing to itself.
   */
  openClawIntegration: OpenClawIntegrationSchema.optional(),

  /**
   * Optional AI-assisted tier classifier.
   *
   * When enabled, claw-auto-router will ask this model to choose a routing tier
   * before ranking candidates. If the classifier call fails, routing falls back
   * to deterministic heuristics automatically.
   */
  routerAI: RouterAIConfigSchema.optional(),

  /**
   * Optional dashboard preferences.
   */
  dashboard: DashboardConfigSchema.optional(),
})

export type RouterConfig = z.infer<typeof RouterConfigSchema>
export type OpenClawIntegration = z.infer<typeof OpenClawIntegrationSchema>
export type RouterAIConfig = z.infer<typeof RouterAIConfigSchema>
export type RoutingClassificationMode = z.infer<typeof RoutingClassificationModeSchema>
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>

export const DEFAULT_ROUTER_CONFIG_PATH = join(homedir(), '.openclaw', 'router.config.json')

export function resolveRouterConfigPath(overridePath?: string, openClawConfigPath?: string): string {
  if (overridePath !== undefined) {
    return resolveUserPath(overridePath)
  }

  if (openClawConfigPath !== undefined) {
    return join(dirname(resolveUserPath(openClawConfigPath)), 'router.config.json')
  }

  return DEFAULT_ROUTER_CONFIG_PATH
}

export function loadRouterConfig(overridePath?: string, openClawConfigPath?: string): RouterConfig {
  const path = resolveRouterConfigPath(overridePath, openClawConfigPath)

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

export function saveRouterConfig(config: RouterConfig, overridePath?: string, openClawConfigPath?: string): void {
  const path = resolveRouterConfigPath(overridePath, openClawConfigPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}
