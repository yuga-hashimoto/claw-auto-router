import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import type { NormalizedModel, NormalizedProvider, ApiStyle } from './types.js'
import { resolveApiKey } from './apikey-resolver.js'

interface NormalizeOptions {
  gatewayBackedProviderIds?: Iterable<string> | undefined
  gatewayAvailable?: boolean | undefined
}

/**
 * Transform a raw OpenClaw config into normalized providers and models.
 * Merges extra providers from router.config.json.
 *
 * Auto-population:
 *   If agents.defaults.model.fallbacks references "google/gemini-3-flash-preview" but
 *   the google provider has an empty models array, this function auto-adds the model
 *   using the provider's baseUrl/api/apiKeyResolution. This makes all fallback-referenced
 *   models work without manual definition.
 */
export function normalizeConfig(
  config: RawConfig,
  routerConfig?: RouterConfig,
  options?: NormalizeOptions,
): {
  providers: NormalizedProvider[]
  models: NormalizedModel[]
  warnings: string[]
} {
  const warnings: string[] = []
  const providers: NormalizedProvider[] = []
  const models: NormalizedModel[] = []
  const selfProviderId = routerConfig?.openClawIntegration?.providerId

  const rawProviders = config.models?.providers ?? {}

  const authProfiles = config.auth?.profiles
  const agentModels = config.agents?.defaults?.models ?? {}
  const denylist = new Set(routerConfig?.denylist ?? [])
  const gatewayBackedProviderIds = new Set(options?.gatewayBackedProviderIds ?? [])
  const gatewayAvailable = options?.gatewayAvailable === true

  // Map of providerId → NormalizedProvider for auto-population phase
  const providerMap = new Map<string, NormalizedProvider>()

  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    if (selfProviderId !== undefined && providerId === selfProviderId) {
      continue
    }

    const apiKeyResolution = resolveApiKey(providerId, rawProvider, authProfiles)
    const providerApi: ApiStyle = rawProvider.api
    const providerAvailable = gatewayAvailable
    const providerUnavailableReason = !providerAvailable
      ? 'OpenClaw Gateway is unavailable'
      : undefined

    const normalizedModels: NormalizedModel[] = []

    for (const rawModel of rawProvider.models) {
      const modelId = rawModel.id
      const compositeId = `${providerId}/${modelId}`

      if (denylist.has(compositeId)) continue

      const modelApi: ApiStyle = rawModel.api ?? providerApi
      const alias = agentModels[compositeId]?.alias

      const model: NormalizedModel = {
        id: compositeId,
        providerId,
        modelId,
        name: rawModel.name ?? modelId,
        api: modelApi,
        baseUrl: rawProvider.baseUrl,
        apiKeyResolution,
        reasoning: rawModel.reasoning ?? false,
        supportsImages: rawModel.input?.includes('image') ?? false,
        contextWindow: rawModel.contextWindow ?? 128000,
        maxTokens: rawModel.maxTokens ?? 4096,
        ...(rawModel.cost !== undefined ? { cost: rawModel.cost } : {}),
        ...(alias !== undefined ? { alias } : {}),
        transport: 'openclaw-gateway' as const,
        available: providerAvailable,
        ...(providerUnavailableReason !== undefined ? { unavailableReason: providerUnavailableReason } : {}),
        ...(rawProvider.authMode !== undefined ? { authMode: rawProvider.authMode } : {}),
        ...(rawProvider.authProfileId !== undefined ? { authProfileId: rawProvider.authProfileId } : {}),
        ...(rawProvider.oauthRefreshToken !== undefined ? { oauthRefreshToken: rawProvider.oauthRefreshToken } : {}),
        ...(rawProvider.oauthExpiresAt !== undefined ? { oauthExpiresAt: rawProvider.oauthExpiresAt } : {}),
        ...(rawProvider.oauthProjectId !== undefined ? { oauthProjectId: rawProvider.oauthProjectId } : {}),
        ...(rawProvider.oauthAccountId !== undefined ? { oauthAccountId: rawProvider.oauthAccountId } : {}),
        ...(rawProvider.authHeader !== undefined ? { authHeader: rawProvider.authHeader } : {}),
      }

      normalizedModels.push(model)
      models.push(model)
    }

    const normalizedProvider: NormalizedProvider = {
      id: providerId,
      baseUrl: rawProvider.baseUrl,
      api: providerApi,
      apiKeyResolution,
      models: normalizedModels,
      transport: 'openclaw-gateway' as const,
      available: providerAvailable,
      ...(providerUnavailableReason !== undefined ? { unavailableReason: providerUnavailableReason } : {}),
      ...(rawProvider.authMode !== undefined ? { authMode: rawProvider.authMode } : {}),
      ...(rawProvider.authProfileId !== undefined ? { authProfileId: rawProvider.authProfileId } : {}),
      ...(rawProvider.oauthRefreshToken !== undefined ? { oauthRefreshToken: rawProvider.oauthRefreshToken } : {}),
      ...(rawProvider.oauthExpiresAt !== undefined ? { oauthExpiresAt: rawProvider.oauthExpiresAt } : {}),
      ...(rawProvider.oauthProjectId !== undefined ? { oauthProjectId: rawProvider.oauthProjectId } : {}),
      ...(rawProvider.oauthAccountId !== undefined ? { oauthAccountId: rawProvider.oauthAccountId } : {}),
      ...(rawProvider.authHeader !== undefined ? { authHeader: rawProvider.authHeader } : {}),
    }
    providers.push(normalizedProvider)
    providerMap.set(providerId, normalizedProvider)
  }

  // Auto-populate: check fallback refs that reference an existing provider but missing model
  const fallbackRefs = config.agents?.defaults?.model?.fallbacks ?? []
  const primaryRef = config.agents?.defaults?.model?.primary
  const allRefs = primaryRef ? [primaryRef, ...fallbackRefs] : fallbackRefs
  const modelIds = new Set(models.map((m) => m.id))

  for (const ref of allRefs) {
    if (modelIds.has(ref)) continue
    if (denylist.has(ref)) continue

    // Split on first '/' only to get providerId
    const slashIdx = ref.indexOf('/')
    if (slashIdx === -1) continue

    const providerId = ref.slice(0, slashIdx)
    const modelId = ref.slice(slashIdx + 1)
    const provider = providerMap.get(providerId)
    const sourceProvider = rawProviders[providerId]

    if (provider !== undefined) {
      // Provider exists but model wasn't in its models list — auto-add with minimal metadata
      const alias = agentModels[ref]?.alias
      const sourceModel = sourceProvider?.models.find((candidate) => candidate.id === modelId)
      const autoModel: NormalizedModel = {
        id: ref,
        providerId,
        modelId,
        name: alias ?? modelId,
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKeyResolution: provider.apiKeyResolution,
        reasoning: false,
        supportsImages: false,
        contextWindow: 128000,
        maxTokens: 4096,
        ...(sourceModel?.cost !== undefined
          ? { cost: sourceModel.cost }
          : {}),
        ...(alias !== undefined ? { alias } : {}),
        transport: provider.transport,
        available: provider.available,
        ...(provider.unavailableReason !== undefined ? { unavailableReason: provider.unavailableReason } : {}),
        ...(provider.authMode !== undefined ? { authMode: provider.authMode } : {}),
        ...(provider.authProfileId !== undefined ? { authProfileId: provider.authProfileId } : {}),
        ...(provider.oauthRefreshToken !== undefined ? { oauthRefreshToken: provider.oauthRefreshToken } : {}),
        ...(provider.oauthExpiresAt !== undefined ? { oauthExpiresAt: provider.oauthExpiresAt } : {}),
        ...(provider.oauthProjectId !== undefined ? { oauthProjectId: provider.oauthProjectId } : {}),
        ...(provider.oauthAccountId !== undefined ? { oauthAccountId: provider.oauthAccountId } : {}),
        ...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
      }

      models.push(autoModel)
      provider.models.push(autoModel)
      modelIds.add(ref)
      warnings.push(
        `Auto-added "${ref}" from fallback ref (provider "${providerId}" exists but model was not in models list).`,
      )
    } else {
      // Provider itself is missing — true phantom ref
      warnings.push(
        `Phantom ref "${ref}" — provider "${providerId}" not found in models.providers. ` +
          `Add it to your OpenClaw config to enable it.`,
      )
    }
  }

  if (gatewayBackedProviderIds.size > 0 && !gatewayAvailable) {
    warnings.push(
      'OpenClaw Gateway is unavailable, so imported OpenClaw models are temporarily disabled. Start or fix the gateway, then reload the router config.',
    )
  }

  return { providers, models, warnings }
}
