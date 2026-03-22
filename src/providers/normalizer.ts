import type { RawConfig } from '../config/schema.js'
import type { RouterConfig } from '../config/router-config.js'
import type { NormalizedModel, NormalizedProvider, ApiStyle } from './types.js'
import { resolveApiKey } from './apikey-resolver.js'

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
): {
  providers: NormalizedProvider[]
  models: NormalizedModel[]
  warnings: string[]
} {
  const warnings: string[] = []
  const providers: NormalizedProvider[] = []
  const models: NormalizedModel[] = []

  // Merge OpenClaw providers with extra providers from router.config.json.
  const rawProviders: Record<string, {
    baseUrl: string
    apiKey?: string | undefined
    api: ApiStyle
    models: Array<{
      id: string
      name?: string | undefined
      api?: ApiStyle | undefined
      reasoning?: boolean | undefined
      input?: string[] | undefined
      contextWindow?: number | undefined
      maxTokens?: number | undefined
    }>
  }> = {
    ...(config.models?.providers ?? {}),
    ...(routerConfig?.extraProviders ?? {}),
  }

  const authProfiles = config.auth?.profiles
  const agentModels = config.agents?.defaults?.models ?? {}
  const denylist = new Set(routerConfig?.denylist ?? [])

  // Map of providerId → NormalizedProvider for auto-population phase
  const providerMap = new Map<string, NormalizedProvider>()

  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    const apiKeyResolution = resolveApiKey(providerId, rawProvider, authProfiles)
    const providerApi: ApiStyle = rawProvider.api

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
        ...(alias !== undefined ? { alias } : {}),
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

    if (provider !== undefined) {
      // Provider exists but model wasn't in its models list — auto-add with minimal metadata
      const alias = agentModels[ref]?.alias
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
        ...(alias !== undefined ? { alias } : {}),
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
        `Phantom ref "${ref}" — provider "${providerId}" not found in models.providers or extraProviders. ` +
          `Add it to router.config.json under "extraProviders" to enable it.`,
      )
    }
  }

  return { providers, models, warnings }
}
