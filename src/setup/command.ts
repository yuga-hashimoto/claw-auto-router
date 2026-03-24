import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RawConfig, RawProvider, RawModelEntry } from '../config/schema.js'
import { loadOpenClawConfig } from '../config/loader.js'
import {
  loadRouterConfig,
  resolveRouterConfigPath,
  saveRouterConfig,
  type RouterAIConfig,
  type RouterConfig,
  type RoutingClassificationMode,
  type OpenClawIntegration,
} from '../config/router-config.js'
import {
  augmentConfigWithOpenClawDiscovery,
  filterUnsupportedProviderWarnings,
  resolveGatewayBackedProviderIds,
} from '../openclaw/discovery.js'
import { normalizeConfig } from '../providers/normalizer.js'
import { ProviderRegistry } from '../providers/registry.js'
import type { NormalizedModel } from '../providers/types.js'
import { buildCandidateChain } from '../router/chain-builder.js'
import type { RoutingTier } from '../router/types.js'
import { resolveUserPath } from '../utils/paths.js'
import {
  runRouterAIWizard,
  runTierPriorityWizard,
  runTierWizard,
  type RouterAIPrompt,
  type TierPriorityMap,
  type TierPriorityPrompt,
} from '../wizard/setup.js'
import { DEFAULT_BASE_URL, DEFAULT_PORT } from '../defaults.js'
import {
  getBackgroundServiceStatus,
  installBackgroundService,
  type BackgroundServiceStatus,
} from '../service/launchd.js'

const DEFAULT_PROVIDER_ID = 'claw-auto-router'
const DEFAULT_MODEL_ID = 'auto'
const ROUTING_TIERS: RoutingTier[] = ['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE']

export interface SetupOptions {
  configPath?: string
  routerConfigPath?: string
  baseUrl?: string
  providerId?: string
  modelId?: string
  port?: number
  host?: string
  logLevel?: string
  adminToken?: string
  requestTimeoutMs?: number
  manageService?: boolean
  resetExisting?: boolean
}

export interface SetupResult {
  mode: 'setup' | 'clean-setup'
  openClawConfigPath: string
  routerConfigPath: string
  routerRef: string
  routerBaseUrl: string
  backupPath?: string
  suggestedStartCommand: string
  inferredUpstreamFromFallbacks: boolean
  upstreamPrimary?: string
  upstreamFallbacks: string[]
  openClawChanges: {
    providerAction: 'created' | 'updated' | 'unchanged'
    primaryBefore?: string
    primaryAfter: string
    fallbacksBefore: string[]
    fallbacksAfter: string[]
  }
  openClawObservedState?: {
    defaultModel?: string
    resolvedDefault?: string
    fallbacks: string[]
  }
  routerConfigSummary: {
    totalAssigned: number
    tierCounts: Record<RoutingTier, number>
    priorityCounts: Record<RoutingTier, number>
    classificationMode: RoutingClassificationMode
    routerAIModel?: string
  }
  routerRuntime: {
    running: boolean
    healthUrl: string
    modelsUrl: string
    healthStatus?: string
    totalModels?: number
    resolvableModels?: number
    error?: string
  }
  backgroundService?: BackgroundServiceStatus
}

interface UpstreamSelection {
  inferredFromFallbacks: boolean
  primary?: string
  fallbacks: string[]
}

interface UpstreamSelectionOptions {
  ignoreSavedIntegration?: boolean
  selfRefs?: string[]
}

interface OpenClawModelsStatusPayload {
  defaultModel?: string
  resolvedDefault?: string
  fallbacks?: string[]
}

interface RouterHealthPayload {
  status?: string
  models?: {
    total?: number
    resolvable?: number
  }
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

function toRouterRef(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

function getKnownRouterRefs(
  currentRouterRef: string,
  previousIntegration?: OpenClawIntegration,
): string[] {
  const refs = [currentRouterRef]

  if (previousIntegration !== undefined) {
    refs.push(toRouterRef(previousIntegration.providerId, previousIntegration.modelId))
  }

  return dedupe(refs)
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
      return port === DEFAULT_PORT ? 'claw-auto-router' : `claw-auto-router --port ${port}`
    }
  } catch {
    // Fall back to the local port-based suggestion below.
  }

  return port === DEFAULT_PORT ? 'claw-auto-router' : `claw-auto-router --port ${port}`
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function summarizeTierAssignments(modelTiers: Record<string, RoutingTier>): SetupResult['routerConfigSummary'] {
  const tierCounts: Record<RoutingTier, number> = {
    SIMPLE: 0,
    STANDARD: 0,
    COMPLEX: 0,
    CODE: 0,
  }

  for (const tier of Object.values(modelTiers)) {
    tierCounts[tier] += 1
  }

  return {
    totalAssigned: Object.keys(modelTiers).length,
    tierCounts,
    priorityCounts: {
      SIMPLE: 0,
      STANDARD: 0,
      COMPLEX: 0,
      CODE: 0,
    },
    classificationMode: 'heuristic',
  }
}

function summarizeTierPriority(tierPriority: TierPriorityMap): Record<RoutingTier, number> {
  return {
    SIMPLE: tierPriority.SIMPLE?.length ?? 0,
    STANDARD: tierPriority.STANDARD?.length ?? 0,
    COMPLEX: tierPriority.COMPLEX?.length ?? 0,
    CODE: tierPriority.CODE?.length ?? 0,
  }
}

function summarizeRoutingStrategy(routerAI: RouterAIConfig | undefined): {
  classificationMode: RoutingClassificationMode
  routerAIModel?: string
} {
  if (routerAI?.mode === 'ai' && routerAI.model !== undefined) {
    return {
      classificationMode: 'ai',
      routerAIModel: routerAI.model,
    }
  }

  return {
    classificationMode: 'heuristic',
  }
}

function describeProviderAction(
  previousProvider: RawProvider | undefined,
  nextProvider: RawProvider,
): SetupResult['openClawChanges']['providerAction'] {
  if (previousProvider === undefined) {
    return 'created'
  }

  return JSON.stringify(previousProvider) === JSON.stringify(nextProvider) ? 'unchanged' : 'updated'
}

function sanitizeTierPriority(
  tierPriority: RouterConfig['tierPriority'] | undefined,
  assignedTiers: Record<string, RoutingTier>,
  models: NormalizedModel[],
): TierPriorityMap {
  const availableModelIds = new Set(models.map((model) => model.id))
  const sanitized: TierPriorityMap = {}

  for (const tier of ROUTING_TIERS) {
    const ids = tierPriority?.[tier]
    if (ids === undefined) {
      continue
    }

    const filtered = dedupe(ids.filter((id) => assignedTiers[id] === tier && availableModelIds.has(id)))
    if (filtered.length > 0) {
      sanitized[tier] = filtered
    }
  }

  return sanitized
}

function buildTierPriorityPrompts(
  config: RawConfig,
  models: NormalizedModel[],
  assignedTiers: Record<string, RoutingTier>,
  routerConfig: RouterConfig,
  existingPriority: TierPriorityMap,
): TierPriorityPrompt[] {
  const registry = new ProviderRegistry(models)

  return ROUTING_TIERS
    .map((tier) => {
      const orderedModels = buildCandidateChain(undefined, config, registry, tier, routerConfig)
        .map((candidate) => candidate.model)
        .filter((model) => assignedTiers[model.id] === tier)

      if (orderedModels.length < 2) {
        return undefined
      }

      const orderedIds = new Set(orderedModels.map((model) => model.id))
      const existingPriorityIds = (existingPriority[tier] ?? []).filter((id) => orderedIds.has(id))

      return {
        tier,
        models: orderedModels,
        existingPriorityIds,
        orderSource: existingPriorityIds.length > 0 ? 'explicit' : 'automatic',
      } satisfies TierPriorityPrompt
    })
    .filter((prompt): prompt is TierPriorityPrompt => prompt !== undefined)
}

function buildRouterAIModelPrompt(
  config: RawConfig,
  models: NormalizedModel[],
  routerConfig: RouterConfig,
  current: RouterAIConfig | undefined,
): RouterAIPrompt {
  const registry = new ProviderRegistry(models)
  const orderedModels: NormalizedModel[] = []
  const seen = new Set<string>()

  for (const tier of ['STANDARD', 'SIMPLE', 'CODE', 'COMPLEX'] as const) {
    for (const candidate of buildCandidateChain(undefined, config, registry, tier, routerConfig)) {
      if (seen.has(candidate.model.id)) {
        continue
      }

      seen.add(candidate.model.id)
      orderedModels.push(candidate.model)
    }
  }

  return {
    current,
    recommendedModelId: orderedModels[0]?.id,
    models: orderedModels,
  }
}

function readObservedOpenClawState(configPath: string): SetupResult['openClawObservedState'] | undefined {
  const result = spawnSync('openclaw', ['models', 'status', '--json'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return undefined
  }

  const firstBrace = result.stdout.indexOf('{')
  if (firstBrace === -1) {
    return undefined
  }

  try {
    const payload = JSON.parse(result.stdout.slice(firstBrace)) as OpenClawModelsStatusPayload
    return {
      ...(payload.defaultModel !== undefined ? { defaultModel: payload.defaultModel } : {}),
      ...(payload.resolvedDefault !== undefined ? { resolvedDefault: payload.resolvedDefault } : {}),
      fallbacks: payload.fallbacks ?? [],
    }
  } catch {
    return undefined
  }
}

async function probeRouterRuntime(baseUrl: string): Promise<SetupResult['routerRuntime']> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const healthUrl = `${normalizedBaseUrl}/health`
  const modelsUrl = `${normalizedBaseUrl}/v1/models`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_500)

  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    })

    if (!response.ok) {
      return {
        running: false,
        healthUrl,
        modelsUrl,
        error: `HTTP ${response.status} from /health`,
      }
    }

    const payload = (await response.json()) as RouterHealthPayload
    return {
      running: true,
      healthUrl,
      modelsUrl,
      ...(payload.status !== undefined ? { healthStatus: payload.status } : {}),
      ...(payload.models?.total !== undefined ? { totalModels: payload.models.total } : {}),
      ...(payload.models?.resolvable !== undefined ? { resolvableModels: payload.models.resolvable } : {}),
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? 'Router did not respond to /health within 1.5s'
        : error instanceof Error
          ? error.message
          : 'Could not reach claw-auto-router'
    return {
      running: false,
      healthUrl,
      modelsUrl,
      error: message,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function deriveUpstreamSelection(
  config: RawConfig,
  routerConfig: RouterConfig,
  routerRef: string,
  options?: UpstreamSelectionOptions,
): UpstreamSelection {
  const selfRefs = new Set([routerRef, ...(options?.selfRefs ?? [])])
  const saved = routerConfig.openClawIntegration
  if (
    options?.ignoreSavedIntegration !== true &&
    saved !== undefined &&
    (saved.upstreamPrimary !== undefined || (saved.upstreamFallbacks?.length ?? 0) > 0)
  ) {
    const selection: UpstreamSelection = {
      inferredFromFallbacks: false,
      fallbacks: (saved.upstreamFallbacks ?? []).filter((ref) => !selfRefs.has(ref)),
    }
    if (saved.upstreamPrimary !== undefined && !selfRefs.has(saved.upstreamPrimary)) {
      selection.primary = saved.upstreamPrimary
    }
    return selection
  }

  const currentPrimary = config.agents?.defaults?.model?.primary
  const currentFallbacks = (config.agents?.defaults?.model?.fallbacks ?? []).filter(
    (ref) => !selfRefs.has(ref),
  )

  if (currentPrimary !== undefined && !selfRefs.has(currentPrimary)) {
    const selection: UpstreamSelection = {
      inferredFromFallbacks: false,
      fallbacks: currentFallbacks,
    }
    selection.primary = currentPrimary
    return selection
  }

  if (currentPrimary !== undefined && selfRefs.has(currentPrimary)) {
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

function ensureGatewayMode(rawConfig: RawConfig): RawConfig {
  const configRecord = rawConfig as RawConfig & { gateway?: Record<string, unknown> }
  const currentGateway = configRecord.gateway

  if (currentGateway?.['mode'] !== undefined) {
    return rawConfig
  }

  return {
    ...rawConfig,
    gateway: {
      ...(currentGateway ?? {}),
      mode: 'local',
    },
  } as RawConfig
}

export function applySetupToOpenClawConfig(
  config: RawConfig,
  integration: OpenClawIntegration,
  models: NormalizedModel[],
  options?: { previousIntegration?: OpenClawIntegration | undefined },
): RawConfig {
  const routerRef = toRouterRef(integration.providerId, integration.modelId)
  const selfRefs = new Set(getKnownRouterRefs(routerRef, options?.previousIntegration))
  const directFallbacks = dedupe(
    [integration.upstreamPrimary, ...(integration.upstreamFallbacks ?? [])].filter(
      (ref): ref is string => ref !== undefined && !selfRefs.has(ref),
    ),
  )

  const routerProvider: RawProvider = {
    baseUrl: integration.baseUrl,
    apiKey: 'claw-auto-router-local',
    api: 'openai-completions',
    models: [buildAutoRouterModel(models, integration.modelId)],
  }

  const updatedProviders = { ...(config.models?.providers ?? {}) }
  if (options?.previousIntegration !== undefined && options.previousIntegration.providerId !== integration.providerId) {
    delete updatedProviders[options.previousIntegration.providerId]
  }
  updatedProviders[integration.providerId] = routerProvider

  const updatedModelsSection = {
    ...(config.models ?? {}),
    providers: updatedProviders,
  }

  const updatedAgentDefaults = {
    ...(config.agents?.defaults ?? {}),
    model: {
      ...(config.agents?.defaults?.model ?? {}),
      primary: routerRef,
      ...(directFallbacks.length > 0 ? { fallbacks: directFallbacks } : {}),
    },
  }

  return ensureGatewayMode({
    ...config,
    models: updatedModelsSection,
    agents: {
      ...(config.agents ?? {}),
      defaults: updatedAgentDefaults,
    },
  })
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
  const port = options.port ?? DEFAULT_PORT
  const host = options.host ?? '0.0.0.0'
  const logLevel = options.logLevel ?? 'info'
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  const baseUrl = options.baseUrl ?? (port === DEFAULT_PORT ? DEFAULT_BASE_URL : `http://127.0.0.1:${port}`)
  const routerRef = toRouterRef(providerId, modelId)
  const routerConfigPath = resolveRouterConfigPath(options.routerConfigPath, outcome.path)
  const existingRouterConfig = loadRouterConfig(routerConfigPath, outcome.path)
  const previousIntegration = existingRouterConfig.openClawIntegration
  const upstream = deriveUpstreamSelection(outcome.config, existingRouterConfig, routerRef, {
    ignoreSavedIntegration: options.resetExisting === true,
    selfRefs: getKnownRouterRefs(routerRef, previousIntegration),
  })
  const previousPrimary = outcome.config.agents?.defaults?.model?.primary
  const previousFallbacks = outcome.config.agents?.defaults?.model?.fallbacks ?? []
  const previousRouterProvider = outcome.config.models?.providers?.[providerId]

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
  const visibleWarnings = filterUnsupportedProviderWarnings(warnings, discoveryWarnings).filter(
    (warning) => !warning.startsWith(`Phantom ref "${routerRef}"`),
  )

  for (const warning of [...discoveryWarnings, ...visibleWarnings]) {
    console.warn(`[claw-auto-router] ${warning}`)
  }

  const assignedTiers = await runTierWizard(
    models,
    options.resetExisting === true ? {} : (existingRouterConfig.modelTiers ?? {}),
    routerConfigPath,
    { interactive: true, replaceExisting: options.resetExisting === true },
  )

  const sanitizedExistingPriority = sanitizeTierPriority(
    options.resetExisting === true ? undefined : existingRouterConfig.tierPriority,
    assignedTiers,
    models,
  )
  const priorityPreviewRouterConfig: RouterConfig = {
    ...setupAwareRouterConfig,
    modelTiers: assignedTiers,
    ...(Object.keys(sanitizedExistingPriority).length > 0 ? { tierPriority: sanitizedExistingPriority } : {}),
  }
  const priorityPrompts = buildTierPriorityPrompts(
    discoveredConfig,
    models,
    assignedTiers,
    priorityPreviewRouterConfig,
    sanitizedExistingPriority,
  )
  const assignedTierPriority = await runTierPriorityWizard(
    priorityPrompts,
    sanitizedExistingPriority,
    { interactive: true, replaceExisting: options.resetExisting === true },
  )

  const routerAIPreviewConfig: RouterConfig = {
    ...setupAwareRouterConfig,
    modelTiers: assignedTiers,
    ...(Object.keys(assignedTierPriority).length > 0 ? { tierPriority: assignedTierPriority } : {}),
  }
  const assignedRouterAI = await runRouterAIWizard(
    buildRouterAIModelPrompt(
      discoveredConfig,
      models,
      routerAIPreviewConfig,
      options.resetExisting === true ? undefined : existingRouterConfig.routerAI,
    ),
    { interactive: true },
  )

  const nextRouterConfig: RouterConfig = {
    ...existingRouterConfig,
    modelTiers: assignedTiers,
    openClawIntegration: integration,
  }
  if (Object.keys(assignedTierPriority).length > 0) {
    nextRouterConfig.tierPriority = assignedTierPriority
  } else {
    delete nextRouterConfig.tierPriority
  }
  if (assignedRouterAI?.mode === 'ai') {
    nextRouterConfig.routerAI = assignedRouterAI
  } else {
    delete nextRouterConfig.routerAI
  }

  saveRouterConfig(
    nextRouterConfig,
    routerConfigPath,
    outcome.path,
  )

  const updatedOpenClawConfig = applySetupToOpenClawConfig(outcome.config, integration, models, {
    previousIntegration,
  })
  const { backupPath } = writeOpenClawConfig(outcome.path, updatedOpenClawConfig)
  const observedOpenClawState = readObservedOpenClawState(outcome.path)
  const runtimeBeforeService = await probeRouterRuntime(baseUrl)
  const existingBackgroundService = getBackgroundServiceStatus()
  let backgroundService: BackgroundServiceStatus | undefined

  if (options.manageService !== false && existingBackgroundService.supported) {
    try {
      const shouldStartService = existingBackgroundService.running || !runtimeBeforeService.running
      backgroundService = installBackgroundService({
        configPath: outcome.path,
        routerConfigPath,
        port,
        host,
        logLevel,
        ...(options.adminToken !== undefined ? { adminToken: options.adminToken } : {}),
        requestTimeoutMs,
        startMode: shouldStartService ? 'always' : 'never',
      })
    } catch (error) {
      backgroundService = {
        ...existingBackgroundService,
        error: error instanceof Error ? error.message : 'Could not install the background service',
      }
    }
  } else if (existingBackgroundService.supported) {
    backgroundService = existingBackgroundService
  }

  const routerRuntime =
    backgroundService?.running === true || backgroundService?.action !== undefined
      ? await probeRouterRuntime(baseUrl)
      : runtimeBeforeService
  const routerProvider = updatedOpenClawConfig.models?.providers?.[providerId]
  const updatedPrimary = updatedOpenClawConfig.agents?.defaults?.model?.primary ?? routerRef
  const updatedFallbacks = updatedOpenClawConfig.agents?.defaults?.model?.fallbacks ?? []
  const routerConfigSummary = {
    ...summarizeTierAssignments(assignedTiers),
    priorityCounts: summarizeTierPriority(assignedTierPriority),
    ...summarizeRoutingStrategy(assignedRouterAI),
  }

  return {
    mode: options.resetExisting === true ? 'clean-setup' : 'setup',
    openClawConfigPath: outcome.path,
    routerConfigPath,
    routerRef,
    routerBaseUrl: baseUrl,
    suggestedStartCommand: buildSuggestedStartCommand(port, baseUrl),
    ...(backupPath !== undefined ? { backupPath } : {}),
    inferredUpstreamFromFallbacks: upstream.inferredFromFallbacks,
    ...(upstream.primary !== undefined ? { upstreamPrimary: upstream.primary } : {}),
    upstreamFallbacks: upstream.fallbacks,
    openClawChanges: {
      providerAction:
        routerProvider !== undefined
          ? describeProviderAction(previousRouterProvider, routerProvider)
          : 'unchanged',
      ...(previousPrimary !== undefined ? { primaryBefore: previousPrimary } : {}),
      primaryAfter: updatedPrimary,
      fallbacksBefore: previousFallbacks,
      fallbacksAfter: updatedFallbacks,
    },
    ...(observedOpenClawState !== undefined ? { openClawObservedState: observedOpenClawState } : {}),
    routerConfigSummary,
    routerRuntime,
    ...(backgroundService !== undefined ? { backgroundService } : {}),
  }
}
