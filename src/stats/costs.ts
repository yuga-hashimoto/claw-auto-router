import type { RouterConfig } from '../config/router-config.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { NormalizedModel } from '../providers/types.js'

export interface UsageSummary {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface CostSummary {
  usage?: UsageSummary | undefined
  estimatedCostUsd?: number | undefined
  baselineCostUsd?: number | undefined
  estimatedSavingsUsd?: number | undefined
  baselineModelId?: string | undefined
}

export function extractUsageSummary(responseBody: unknown): UsageSummary | undefined {
  if (typeof responseBody !== 'object' || responseBody === null) {
    return undefined
  }

  const usage = (responseBody as {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }).usage

  if (usage === undefined) {
    return undefined
  }

  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return undefined
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  }
}

export function estimateRequestCosts(input: {
  resolvedModel: NormalizedModel
  registry: ProviderRegistry
  routerConfig: RouterConfig
  usage?: UsageSummary | undefined
}): CostSummary {
  const usage = input.usage
  if (usage === undefined) {
    return {}
  }

  const estimatedCostUsd = estimateModelCost(input.resolvedModel, usage)
  const baselineModel = resolveBaselineModel(input.registry, input.routerConfig)
  const baselineCostUsd =
    baselineModel !== undefined ? estimateModelCost(baselineModel, usage) : undefined

  return {
    usage,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    ...(baselineCostUsd !== undefined ? { baselineCostUsd } : {}),
    ...(estimatedCostUsd !== undefined && baselineCostUsd !== undefined
      ? { estimatedSavingsUsd: baselineCostUsd - estimatedCostUsd }
      : {}),
    ...(baselineModel !== undefined ? { baselineModelId: baselineModel.id } : {}),
  }
}

export function estimateModelCost(
  model: NormalizedModel,
  usage: UsageSummary,
): number | undefined {
  if (model.cost === undefined) {
    return undefined
  }

  const inputCost = (usage.promptTokens / 1_000_000) * model.cost.input
  const outputCost = (usage.completionTokens / 1_000_000) * model.cost.output
  return roundUsd(inputCost + outputCost)
}

function resolveBaselineModel(
  registry: ProviderRegistry,
  routerConfig: RouterConfig,
): NormalizedModel | undefined {
  const configured =
    routerConfig.dashboard?.baselineModel ??
    routerConfig.openClawIntegration?.upstreamPrimary

  if (configured === undefined) {
    return undefined
  }

  return registry.lookup(configured)
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
