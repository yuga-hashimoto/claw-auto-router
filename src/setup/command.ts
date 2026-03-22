import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RawConfig, RawProvider, RawModelEntry } from '../config/schema.js'
import { loadOpenClawConfig } from '../config/loader.js'
import {
  loadRouterConfig,
  resolveRouterConfigPath,
  saveRouterConfig,
  type RouterConfig,
  type OpenClawIntegration,
} from '../config/router-config.js'
import {
  augmentConfigWithOpenClawDiscovery,
  filterUnsupportedProviderWarnings,
  resolveGatewayBackedProviderIds,
} from '../openclaw/discovery.js'
import { normalizeConfig } from '../providers/normalizer.js'
import type { NormalizedModel } from '../providers/types.js'
import { resolveUserPath } from '../utils/paths.js'
import { runTierWizard } from '../wizard/setup.js'

const DEFAULT_PROVIDER_ID = 'claw-auto-router'
const DEFAULT_MODEL_ID = 'auto'

export interface SetupOptions {
  configPath?: string
  routerConfigPath?: string
  baseUrl?: string
  providerId?: string
  modelId?: string
  port?: number
}

export interface SetupResult {
  openClawConfigPath: string
  routerConfigPath: string
  routerRef: string
  backupPath?: string
  suggestedStartCommand: string
  inferredUpstreamFromFallbacks: boolean
  upstreamPrimary?: string
  upstreamFallbacks: string[]
}

interface UpstreamSelection {
  inferredFromFallbacks: boolean
  primary?: string
  fallbacks: string[]
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }

  return result
}

function discoverOpenClawConfigPathFromCommand(): string | undefined {
  const result = spawnSync('openclaw', ['config', 'file'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return undefined
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  const candidate = lines[lines.length - 1]
  if (candidate === undefined) {
    return undefined
  }

  return resolveUserPath(candidate)
}

function buildSuggestedStartCommand(port: number, baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    const isLocalHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    const effectivePort =
      parsed.port === ''
        ? parsed.protocol === 'https:'
          ? 443
          : 80
        : Number.parseInt(parsed.port, 10)

    if (isLocalHost && effectivePort === port) {
      return port === 3000 ? 'claw-auto-router' : `claw-auto-router --port ${port}`
    }
  } catch {
    // Fall back to the local port-based suggestion below.
  }

  return port === 3000 ? 'claw-auto-router' : `claw-auto-router --port ${port}`
}

export function deriveUpstreamSelection(
  config: RawConfig,
  routerConfig: RouterConfig,
  routerRef: string,
): UpstreamSelection {
  const saved = routerConfig.openClawIntegration
  if (saved !== undefined && (saved.upstreamPrimary !== undefined || (saved.upstreamFallbacks?.length ?? 0) > 0)) {
    const selection: UpstreamSelection = {
      inferredFromFallbacks: false,
      fallbacks: saved.upstreamFallbacks ?? [],
    }
    if (saved.upstreamPrimary !== undefined) {
      selection.primary = saved.upstreamPrimary
    }
    return selection
  }

  const currentPrimary = config.agents?.defaults?.model?.primary
  const currentFallbacks = (config.agents?.defaults?.model?.fallbacks ?? []).filter(
    (ref) => ref !== routerRef,
  )

  if (currentPrimary !== undefined && currentPrimary !== routerRef) {
    const selection: UpstreamSelection = {
      inferredFromFallbacks: false,
      fallbacks: currentFallbacks,
    }
    selection.primary = currentPrimary
    return selection
  }

  if (currentPrimary === routerRef) {
    const [first, ...rest] = currentFallbacks
    const selection: UpstreamSelection = {
      inferredFromFallbacks: true,
      fallbacks: rest,
    }
    if (first !== undefined) {
      selection.primary = first
    }
    return selection
  }

  return {
    inferredFromFallbacks: false,
    fallbacks: currentFallbacks,
  }
}

function buildAutoRouterModel(models: NormalizedModel[], modelId: string): RawModelEntry {
  const contextWindow = Math.max(262_144, ...models.map((model) => model.contextWindow))
  const maxTokens = Math.max(32_768, ...models.map((model) => model.maxTokens))

  return {
    id: modelId,
    name: 'Auto Router',
    api: 'openai-completions',
    contextWindow,
    maxTokens,
  }
}

export function applySetupToOpenClawConfig(
  config: RawConfig,
  integration: OpenClawIntegration,
  models: NormalizedModel[],
): RawConfig {
  const routerRef = `${integration.providerId}/${integration.modelId}`
  const directFallbacks = dedupe(
    [integration.upstreamPrimary, ...(integration.upstreamFallbacks ?? [])].filter(
      (ref): ref is string => ref !== undefined && ref !== routerRef,
    ),
  )

  const routerProvider: RawProvider = {
    baseUrl: integration.baseUrl,
    apiKey: 'claw-auto-router-local',
    api: 'openai-completions',
    models: [buildAutoRouterModel(models, integration.modelId)],
  }

  const updatedModelsSection = {
    ...(config.models ?? {}),
    providers: {
      ...(config.models?.providers ?? {}),
      [integration.providerId]: routerProvider,
    },
  }

  const updatedAgentDefaults = {
    ...(config.agents?.defaults ?? {}),
    model: {
      ...(config.agents?.defaults?.model ?? {}),
      primary: routerRef,
      ...(directFallbacks.length > 0 ? { fallbacks: directFallbacks } : {}),
    },
  }

  return {
    ...config,
    models: updatedModelsSection,
    agents: {
      ...(config.agents ?? {}),
      defaults: updatedAgentDefaults,
    },
  }
}

function writeOpenClawConfig(path: string, updated: RawConfig): { backupPath?: string } {
  const serialized = JSON.stringify(updated, null, 2) + '\n'
  const current = readFileSync(path, 'utf-8')

  if (current === serialized) {
    return {}
  }

  const backupPath = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(path, backupPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serialized, 'utf-8')

  return { backupPath }
}

export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const discoveredConfigPath =
    options.configPath !== undefined
      ? resolveUserPath(options.configPath)
      : discoverOpenClawConfigPathFromCommand()

  if (discoveredConfigPath === undefined && options.configPath === undefined) {
    throw new Error(
      'Could not detect your OpenClaw config automatically. Make sure the `openclaw` CLI is installed or pass `--config /path/to/openclaw.json`.',
    )
  }

  const outcome = loadOpenClawConfig(discoveredConfigPath)
  if (!outcome.ok) {
    throw new Error(outcome.error)
  }

  const providerId = options.providerId ?? DEFAULT_PROVIDER_ID
  const modelId = options.modelId ?? DEFAULT_MODEL_ID
  const port = options.port ?? 3000
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`
  const routerRef = `${providerId}/${modelId}`
  const routerConfigPath = resolveRouterConfigPath(options.routerConfigPath, outcome.path)
  const existingRouterConfig = loadRouterConfig(routerConfigPath, outcome.path)
  const upstream = deriveUpstreamSelection(outcome.config, existingRouterConfig, routerRef)

  const integration: OpenClawIntegration = {
    providerId,
    modelId,
    baseUrl,
    ...(upstream.primary !== undefined ? { upstreamPrimary: upstream.primary } : {}),
    ...(upstream.fallbacks.length > 0 ? { upstreamFallbacks: upstream.fallbacks } : {}),
  }

  const setupAwareRouterConfig: RouterConfig = {
    ...existingRouterConfig,
    openClawIntegration: integration,
  }

  const {
    config: discoveredConfig,
    warnings: discoveryWarnings,
  } = augmentConfigWithOpenClawDiscovery(outcome.config, outcome.path)
  const gatewayBackedProviderIds = resolveGatewayBackedProviderIds(outcome.config, discoveredConfig)
  const { models, warnings } = normalizeConfig(discoveredConfig, setupAwareRouterConfig, {
    gatewayBackedProviderIds,
    gatewayAvailable: true,
  })
  const visibleWarnings = filterUnsupportedProviderWarnings(warnings, discoveryWarnings)

  for (const warning of [...discoveryWarnings, ...visibleWarnings]) {
    console.warn(`[claw-auto-router] ${warning}`)
  }

  const assignedTiers = await runTierWizard(
    models,
    existingRouterConfig.modelTiers ?? {},
    routerConfigPath,
    { interactive: true },
  )

  saveRouterConfig(
    {
      ...existingRouterConfig,
      modelTiers: assignedTiers,
      openClawIntegration: integration,
    },
    routerConfigPath,
    outcome.path,
  )

  const updatedOpenClawConfig = applySetupToOpenClawConfig(outcome.config, integration, models)
  const { backupPath } = writeOpenClawConfig(outcome.path, updatedOpenClawConfig)

  return {
    openClawConfigPath: outcome.path,
    routerConfigPath,
    routerRef,
    suggestedStartCommand: buildSuggestedStartCommand(port, baseUrl),
    ...(backupPath !== undefined ? { backupPath } : {}),
    inferredUpstreamFromFallbacks: upstream.inferredFromFallbacks,
    ...(upstream.primary !== undefined ? { upstreamPrimary: upstream.primary } : {}),
    upstreamFallbacks: upstream.fallbacks,
  }
}
