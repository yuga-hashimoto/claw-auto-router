import type { ThinkingConfig } from '../adapters/types.js'
import type { ClassificationMode, RoutingTier } from '../router/types.js'
import type { SessionSummary } from '../session-store.js'

export interface RequestRecord {
  timestamp: number
  requestedModel: string
  resolvedModel: string
  tier: RoutingTier
  classifierMode: ClassificationMode
  classifierModelId?: string | undefined
  attemptCount: number
  totalDurationMs: number
  success: boolean
  fallbackUsed: boolean
  promptTokens?: number | undefined
  completionTokens?: number | undefined
  totalTokens?: number | undefined
  estimatedCostUsd?: number | undefined
  baselineCostUsd?: number | undefined
  estimatedSavingsUsd?: number | undefined
  baselineModelId?: string | undefined
  sessionId?: string | undefined
  sessionSource?: string | undefined
  overrideApplied?: boolean | undefined
  overrideSummary?: string | undefined
  thinking?: ThinkingConfig | undefined
}

export interface ProviderStat {
  attempts: number
  successes: number
  failures: number
  totalDurationMs: number
  estimatedCostUsd: number
  requestCount: number
}

export interface RouterStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  fallbackCount: number
  averageDurationMs: number
  tierStats: Record<RoutingTier, number>
  classifierStats: Record<ClassificationMode, number>
  costSummary: {
    estimatedCostUsd: number
    baselineCostUsd: number
    estimatedSavingsUsd: number
    meteredRequests: number
    unmeteredRequests: number
    baselineModelId?: string | undefined
  }
  sessionStats: {
    activeOverrides: number
    overrideRequests: number
    recentOverrides: SessionSummary[]
  }
  providerStats: Record<string, ProviderStat>
  recentRequests: RequestRecord[]
  configStatus: {
    loaded: boolean
    path?: string | undefined
    warnings: string[]
    lastReloadAt: string | null
  }
}

const MAX_RECENT = 100

export class StatsCollector {
  private records: RequestRecord[] = []
  private providerStats: Map<string, ProviderStat> = new Map()
  private recentOverrides: SessionSummary[] = []
  private configStatus: RouterStats['configStatus'] = {
    loaded: false,
    warnings: [],
    lastReloadAt: null,
  }

  record(req: RequestRecord): void {
    this.records.push(req)
    if (this.records.length > MAX_RECENT) {
      this.records.shift()
    }

    const key = req.resolvedModel
    const existing = this.providerStats.get(key) ?? {
      attempts: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      estimatedCostUsd: 0,
      requestCount: 0,
    }
    existing.attempts += req.attemptCount
    existing.requestCount += 1
    if (req.success) existing.successes++
    else existing.failures++
    existing.totalDurationMs += req.totalDurationMs
    if (req.estimatedCostUsd !== undefined) {
      existing.estimatedCostUsd += req.estimatedCostUsd
    }
    this.providerStats.set(key, existing)
  }

  setRecentOverrides(overrides: SessionSummary[]): void {
    this.recentOverrides = overrides
  }

  setConfigStatus(status: RouterStats['configStatus']): void {
    this.configStatus = status
  }

  getSummary(): RouterStats {
    const total = this.records.length
    const successful = this.records.filter((r) => r.success).length
    const fallbacks = this.records.filter((r) => r.fallbackUsed).length
    const overrideRequests = this.records.filter((r) => r.overrideApplied === true).length
    const avgDuration =
      total > 0
        ? Math.round(this.records.reduce((sum, r) => sum + r.totalDurationMs, 0) / total)
        : 0
    const tierStats: Record<RoutingTier, number> = {
      SIMPLE: 0,
      STANDARD: 0,
      COMPLEX: 0,
      CODE: 0,
    }
    const classifierStats: Record<ClassificationMode, number> = {
      heuristic: 0,
      ai: 0,
    }
    let estimatedCostUsd = 0
    let baselineCostUsd = 0
    let estimatedSavingsUsd = 0
    let meteredRequests = 0
    let unmeteredRequests = 0
    let baselineModelId: string | undefined

    for (const record of this.records) {
      tierStats[record.tier] += 1
      classifierStats[record.classifierMode] += 1

      if (record.estimatedCostUsd !== undefined) {
        estimatedCostUsd += record.estimatedCostUsd
        meteredRequests += 1
      } else {
        unmeteredRequests += 1
      }

      if (record.baselineCostUsd !== undefined) {
        baselineCostUsd += record.baselineCostUsd
      }

      if (record.estimatedSavingsUsd !== undefined) {
        estimatedSavingsUsd += record.estimatedSavingsUsd
      }

      if (baselineModelId === undefined && record.baselineModelId !== undefined) {
        baselineModelId = record.baselineModelId
      }
    }

    const providerStats: Record<string, ProviderStat> = {}
    for (const [key, stat] of this.providerStats.entries()) {
      providerStats[key] = {
        ...stat,
        estimatedCostUsd: roundUsd(stat.estimatedCostUsd),
      }
    }

    return {
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: total - successful,
      fallbackCount: fallbacks,
      averageDurationMs: avgDuration,
      tierStats,
      classifierStats,
      costSummary: {
        estimatedCostUsd: roundUsd(estimatedCostUsd),
        baselineCostUsd: roundUsd(baselineCostUsd),
        estimatedSavingsUsd: roundUsd(estimatedSavingsUsd),
        meteredRequests,
        unmeteredRequests,
        ...(baselineModelId !== undefined ? { baselineModelId } : {}),
      },
      sessionStats: {
        activeOverrides: this.recentOverrides.length,
        overrideRequests,
        recentOverrides: this.recentOverrides,
      },
      providerStats,
      recentRequests: [...this.records].reverse(),
      configStatus: this.configStatus,
    }
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
