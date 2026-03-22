import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RawConfig, RawModelEntry, RawProvider } from '../config/schema.js'

const OAUTH_SENTINEL_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-oauth$/

type SupportedProviderApi = RawProvider['api']

interface OpenClawModelsStatusPayload {
  agentDir?: string
  defaultModel?: string
  resolvedDefault?: string
  fallbacks?: string[]
  allowed?: string[]
}

interface OpenClawModelsListEntry {
  key?: string
  name?: string
  input?: string
  contextWindow?: number
}

interface OpenClawModelsListPayload {
  models?: OpenClawModelsListEntry[]
}

interface StoredAuthProfileCredential {
  provider?: string
  type?: string
  key?: string
  token?: string
  access?: string
  refresh?: string
  expires?: number
  projectId?: string
  accountId?: string
}

interface StoredAuthProfilesPayload {
  profiles?: Record<string, StoredAuthProfileCredential>
  lastGood?: Record<string, string>
}

interface OpenClawModelsJsonPayload {
  providers?: Record<string, {
    baseUrl?: string
    apiKey?: string
    api?: string
    models?: Array<{
      id?: string
      name?: string
      api?: string
      reasoning?: boolean
      input?: string[]
      contextWindow?: number
      maxTokens?: number
    }>
  }>
}

interface DiscoveryModelSeed {
  compositeId: string
  name?: string
  input?: string[]
  contextWindow?: number
}

interface ResolvedStoredProviderCredential {
  apiKey?: string
  authMode?: RawProvider['authMode']
  authProfileId?: string
  oauthRefreshToken?: string
  oauthExpiresAt?: number
  oauthProjectId?: string
  oauthAccountId?: string
}

export interface OpenClawDiscoverySnapshot {
  providers: Record<string, RawProvider>
  models: DiscoveryModelSeed[]
  warnings: string[]
}

export function augmentConfigWithOpenClawDiscovery(
  config: RawConfig,
  openClawConfigPath?: string,
): { config: RawConfig; warnings: string[] } {
  const snapshot = discoverOpenClawSnapshot(config, openClawConfigPath)
  if (snapshot === undefined) {
    return { config, warnings: [] }
  }

  return {
    config: mergeDiscoveryIntoConfig(config, snapshot),
    warnings: snapshot.warnings,
  }
}

export function filterUnsupportedProviderWarnings(
  warnings: string[],
  discoveryWarnings: string[],
): string[] {
  const unsupportedProviders = discoveryWarnings
    .map((warning) => warning.match(/^Configured OpenClaw provider "([^"]+)"/)?.[1])
    .filter((providerId): providerId is string => providerId !== undefined)

  if (unsupportedProviders.length === 0) {
    return warnings
  }

  return warnings.filter(
    (warning) =>
      !unsupportedProviders.some((providerId) => warning.startsWith(`Phantom ref "${providerId}/`)),
  )
}

export function resolveGatewayBackedProviderIds(
  originalConfig: RawConfig,
  discoveredConfig: RawConfig,
): string[] {
  const configuredProviderIds = new Set(Object.keys(originalConfig.models?.providers ?? {}))
  const gatewayBacked = new Set<string>()

  for (const [providerId, provider] of Object.entries(discoveredConfig.models?.providers ?? {})) {
    if (!configuredProviderIds.has(providerId)) {
      gatewayBacked.add(providerId)
      continue
    }

    if (provider.authMode === 'oauth') {
      gatewayBacked.add(providerId)
      continue
    }

    if (typeof provider.apiKey === 'string' && OAUTH_SENTINEL_RE.test(provider.apiKey)) {
      gatewayBacked.add(providerId)
    }
  }

  return Array.from(gatewayBacked)
}

export function mergeDiscoveryIntoConfig(
  config: RawConfig,
  snapshot: OpenClawDiscoverySnapshot,
): RawConfig {
  const existingProviders = config.models?.providers ?? {}
  const mergedProviders: Record<string, RawProvider> = {}

  for (const [providerId, provider] of Object.entries(snapshot.providers)) {
    mergedProviders[providerId] = cloneProvider(provider)
  }

  for (const [providerId, provider] of Object.entries(existingProviders)) {
    mergedProviders[providerId] = mergeProviders(mergedProviders[providerId], provider)
  }

  for (const model of snapshot.models) {
    const slashIndex = model.compositeId.indexOf('/')
    if (slashIndex === -1) continue

    const providerId = model.compositeId.slice(0, slashIndex)
    const modelId = model.compositeId.slice(slashIndex + 1)
    const provider = mergedProviders[providerId]
    if (provider === undefined) continue
    if (provider.models.some((entry) => entry.id === modelId)) continue

    provider.models.push({
      id: modelId,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.input !== undefined ? { input: model.input } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      maxTokens: inferDefaultMaxTokens(model.contextWindow),
    })
  }

  return {
    ...config,
    models: {
      ...(config.models ?? {}),
      providers: mergedProviders,
    },
  }
}

function discoverOpenClawSnapshot(
  config: RawConfig,
  openClawConfigPath?: string,
): OpenClawDiscoverySnapshot | undefined {
  const warnings: string[] = []
  const status = runOpenClawJsonCommand<OpenClawModelsStatusPayload>(
    ['models', 'status', '--json'],
    openClawConfigPath,
  )
  const modelsList = runOpenClawJsonCommand<OpenClawModelsListPayload>(
    ['models', 'list', '--json'],
    openClawConfigPath,
  )

  const configuredRefs = collectConfiguredRefs(config, status)
  const agentDir = status?.agentDir
  if (agentDir === undefined) {
    return undefined
  }

  const modelsJson = readJsonFile<OpenClawModelsJsonPayload>(join(agentDir, 'models.json'))
  if (modelsJson?.providers === undefined) {
    return undefined
  }

  const authProfileStore =
    readJsonFile<StoredAuthProfilesPayload>(join(agentDir, 'auth-profiles.json')) ?? {}
  const authProfiles = authProfileStore.profiles ?? {}
  const lastGoodProfiles = authProfileStore.lastGood ?? {}
  const discoveryProviders: Record<string, RawProvider> = {}

  for (const [providerId, provider] of Object.entries(modelsJson.providers)) {
    if (provider.baseUrl === undefined || provider.baseUrl.trim() === '') {
      continue
    }

    const api = coerceDiscoveredApi(providerId, provider.api)

    const resolvedCredential = resolveStoredProviderCredential(
      providerId,
      provider.apiKey,
      authProfiles,
      lastGoodProfiles,
    )
    discoveryProviders[providerId] = {
      baseUrl: provider.baseUrl,
      ...(resolvedCredential.apiKey !== undefined ? { apiKey: resolvedCredential.apiKey } : {}),
      api,
      ...(resolvedCredential.authMode !== undefined ? { authMode: resolvedCredential.authMode } : {}),
      ...(resolvedCredential.authProfileId !== undefined
        ? { authProfileId: resolvedCredential.authProfileId }
        : {}),
      ...(resolvedCredential.oauthRefreshToken !== undefined
        ? { oauthRefreshToken: resolvedCredential.oauthRefreshToken }
        : {}),
      ...(resolvedCredential.oauthExpiresAt !== undefined
        ? { oauthExpiresAt: resolvedCredential.oauthExpiresAt }
        : {}),
      ...(resolvedCredential.oauthProjectId !== undefined
        ? { oauthProjectId: resolvedCredential.oauthProjectId }
        : {}),
      ...(resolvedCredential.oauthAccountId !== undefined
        ? { oauthAccountId: resolvedCredential.oauthAccountId }
        : {}),
      ...(providerId === 'minimax-portal' ? { authHeader: true } : {}),
      models: (provider.models ?? [])
        .filter((entry): entry is NonNullable<typeof entry> & { id: string } => typeof entry?.id === 'string')
        .map((entry): RawModelEntry => ({
          id: entry.id,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.api !== undefined && isSupportedProviderApi(entry.api)
            ? { api: entry.api }
            : {}),
          ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
          ...(entry.input !== undefined ? { input: entry.input } : {}),
          ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
          ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
        })),
    }
  }

  const discoveryModels: DiscoveryModelSeed[] = []
  const listModels = modelsList?.models ?? []
  for (const entry of listModels) {
    if (typeof entry.key !== 'string' || entry.key.trim() === '') continue

    const compositeId = resolveConfiguredCompositeId(entry.key, configuredRefs)
    const slashIndex = compositeId.indexOf('/')
    if (slashIndex === -1) continue

    const providerId = compositeId.slice(0, slashIndex)
    if (discoveryProviders[providerId] === undefined) continue

    discoveryModels.push({
      compositeId,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.input !== undefined ? { input: parseInputModes(entry.input) } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    })
  }

  return {
    providers: discoveryProviders,
    models: discoveryModels,
    warnings,
  }
}

function runOpenClawJsonCommand<T>(args: string[], openClawConfigPath?: string): T | undefined {
  const result = spawnSync('openclaw', args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(openClawConfigPath !== undefined
        ? { OPENCLAW_CONFIG_PATH: openClawConfigPath }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return undefined
  }

  return parseJsonFromCommandOutput<T>(result.stdout)
}

function parseJsonFromCommandOutput<T>(stdout: string): T | undefined {
  const firstBrace = stdout.indexOf('{')
  if (firstBrace === -1) {
    return undefined
  }

  const payload = stdout.slice(firstBrace).trim()
  try {
    return JSON.parse(payload) as T
  } catch {
    return undefined
  }
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined
  }

  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return undefined
  }
}

function collectConfiguredRefs(
  config: RawConfig,
  status: OpenClawModelsStatusPayload | undefined,
): string[] {
  const refs = new Set<string>()
  const configModel = config.agents?.defaults?.model

  for (const ref of [
    configModel?.primary,
    ...(configModel?.fallbacks ?? []),
    ...(status?.allowed ?? []),
    ...(status?.defaultModel !== undefined ? [status.defaultModel] : []),
    ...(status?.resolvedDefault !== undefined ? [status.resolvedDefault] : []),
    ...(status?.fallbacks ?? []),
    ...Object.keys(config.agents?.defaults?.models ?? {}),
  ]) {
    if (typeof ref === 'string' && ref.trim() !== '') {
      refs.add(ref)
    }
  }

  return Array.from(refs)
}

export function resolveConfiguredCompositeId(listKey: string, configuredRefs: string[]): string {
  if (configuredRefs.includes(listKey)) {
    return listKey
  }

  const slashIndex = listKey.indexOf('/')
  if (slashIndex === -1) {
    return listKey
  }

  const providerId = listKey.slice(0, slashIndex)
  const modelId = listKey.slice(slashIndex + 1)
  const candidates = configuredRefs.filter(
    (ref) => ref.startsWith(`${providerId}/`) && ref.endsWith(`/${modelId}`),
  )

  const exactCandidate = candidates[0]
  return candidates.length === 1 && exactCandidate !== undefined ? exactCandidate : listKey
}

export function coerceDiscoveredApi(
  providerId: string,
  api: string | undefined,
): SupportedProviderApi {
  if (providerId === 'google-antigravity' || providerId === 'google-gemini-cli') {
    return 'google-gemini-cli'
  }

  if (
    api === 'openai-completions' ||
    api === 'anthropic-messages' ||
    api === 'openai-codex-responses' ||
    api === 'google-gemini-cli'
  ) {
    return api
  }

  if (providerId === 'github-copilot') {
    return 'openai-completions'
  }

  if (providerId === 'openai-codex') {
    return 'openai-codex-responses'
  }

  return 'openai-completions'
}

function isSupportedProviderApi(value: string): value is SupportedProviderApi {
  return (
    value === 'openai-completions' ||
    value === 'anthropic-messages' ||
    value === 'openai-codex-responses' ||
    value === 'google-gemini-cli'
  )
}

function resolveStoredProviderCredential(
  providerId: string,
  configuredApiKey: string | undefined,
  profiles: Record<string, StoredAuthProfileCredential>,
  lastGoodProfiles: Record<string, string>,
): ResolvedStoredProviderCredential {
  if (
    configuredApiKey !== undefined &&
    configuredApiKey !== '' &&
    !OAUTH_SENTINEL_RE.test(configuredApiKey)
  ) {
    return { apiKey: configuredApiKey }
  }

  const candidates = Object.entries(profiles)
    .filter(([, profile]) => profile.provider === providerId)
    .sort((left, right) => compareAuthProfiles(providerId, left, right, lastGoodProfiles))

  const selected = candidates[0]
  if (selected === undefined) {
    return configuredApiKey !== undefined ? { apiKey: configuredApiKey } : {}
  }

  const [profileId, profile] = selected
  if (profile.type === 'api_key' && typeof profile.key === 'string' && profile.key !== '') {
    return {
      apiKey: profile.key,
      authMode: 'api_key',
      authProfileId: profileId,
    }
  }

  if (profile.type === 'token' && typeof profile.token === 'string' && profile.token !== '') {
    return {
      apiKey: profile.token,
      authMode: 'token',
      authProfileId: profileId,
    }
  }

  if (profile.type === 'oauth') {
    return {
      ...(typeof profile.access === 'string' && profile.access !== '' ? { apiKey: profile.access } : {}),
      authMode: 'oauth',
      authProfileId: profileId,
      ...(typeof profile.refresh === 'string' && profile.refresh !== ''
        ? { oauthRefreshToken: profile.refresh }
        : {}),
      ...(typeof profile.expires === 'number' ? { oauthExpiresAt: profile.expires } : {}),
      ...(typeof profile.projectId === 'string' && profile.projectId !== ''
        ? { oauthProjectId: profile.projectId }
        : {}),
      ...(typeof profile.accountId === 'string' && profile.accountId !== ''
        ? { oauthAccountId: profile.accountId }
        : {}),
    }
  }

  return configuredApiKey !== undefined ? { apiKey: configuredApiKey } : {}
}

function parseInputModes(rawInput: string): string[] {
  const lower = rawInput.toLowerCase()
  return lower.includes('image') ? ['text', 'image'] : ['text']
}

function inferDefaultMaxTokens(contextWindow: number | undefined): number {
  if (contextWindow !== undefined && contextWindow >= 262_144) {
    return 32_768
  }

  return 8_192
}

function cloneProvider(provider: RawProvider): RawProvider {
  return {
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
  }
}

function mergeProviders(
  discovered: RawProvider | undefined,
  configured: RawProvider,
): RawProvider {
  if (discovered === undefined) {
    return cloneProvider(configured)
  }

  const mergedModels = [
    ...configured.models.map((model) => ({ ...model })),
    ...discovered.models
      .filter((model) => configured.models.every((configuredModel) => configuredModel.id !== model.id))
      .map((model) => ({ ...model })),
  ]

  return {
    ...discovered,
    ...configured,
    baseUrl: configured.baseUrl,
    api: configured.api,
    ...(preferConfiguredApiKey(configured.apiKey, discovered.apiKey) !== undefined
      ? { apiKey: preferConfiguredApiKey(configured.apiKey, discovered.apiKey) }
      : {}),
    ...(configured.authMode ?? discovered.authMode) !== undefined
      ? { authMode: configured.authMode ?? discovered.authMode }
      : {},
    ...(configured.authProfileId ?? discovered.authProfileId) !== undefined
      ? { authProfileId: configured.authProfileId ?? discovered.authProfileId }
      : {},
    ...(configured.oauthRefreshToken ?? discovered.oauthRefreshToken) !== undefined
      ? { oauthRefreshToken: configured.oauthRefreshToken ?? discovered.oauthRefreshToken }
      : {},
    ...(configured.oauthExpiresAt ?? discovered.oauthExpiresAt) !== undefined
      ? { oauthExpiresAt: configured.oauthExpiresAt ?? discovered.oauthExpiresAt }
      : {},
    ...(configured.oauthProjectId ?? discovered.oauthProjectId) !== undefined
      ? { oauthProjectId: configured.oauthProjectId ?? discovered.oauthProjectId }
      : {},
    ...(configured.oauthAccountId ?? discovered.oauthAccountId) !== undefined
      ? { oauthAccountId: configured.oauthAccountId ?? discovered.oauthAccountId }
      : {},
    ...(configured.authHeader ?? discovered.authHeader) !== undefined
      ? { authHeader: configured.authHeader ?? discovered.authHeader }
      : {},
    models: mergedModels,
  }
}

function preferConfiguredApiKey(
  configured: string | undefined,
  discovered: string | undefined,
): string | undefined {
  if (configured === undefined || configured === '') {
    return discovered
  }

  if (discovered === undefined || discovered === '') {
    return configured
  }

  if (OAUTH_SENTINEL_RE.test(configured)) {
    return discovered
  }

  return configured
}

function compareAuthProfiles(
  providerId: string,
  left: [string, StoredAuthProfileCredential],
  right: [string, StoredAuthProfileCredential],
  lastGoodProfiles: Record<string, string>,
): number {
  const [leftId, leftProfile] = left
  const [rightId, rightProfile] = right

  if (leftId === lastGoodProfiles[providerId]) return -1
  if (rightId === lastGoodProfiles[providerId]) return 1

  if (leftId === `${providerId}:default`) return -1
  if (rightId === `${providerId}:default`) return 1

  const leftExpires = typeof leftProfile.expires === 'number' ? leftProfile.expires : -1
  const rightExpires = typeof rightProfile.expires === 'number' ? rightProfile.expires : -1

  if (leftExpires !== rightExpires) {
    return rightExpires - leftExpires
  }

  return leftId.localeCompare(rightId)
}
