import type { RoutingTier } from '../router/types.js'

export interface RequestRecord {
  timestamp: number
  requestedModel: string
  resolvedModel: string
  tier: RoutingTier
  attemptCount: number
  totalDurationMs: number
  success: boolean
  fallbackUsed: boolean
}

export interface ProviderStat {
  attempts: number
  successes: number
  failures: number
  totalDurationMs: number
}

export interface RouterStats {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  fallbackCount: number
  averageDurationMs: number
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
    }
    existing.attempts += req.attemptCount
    if (req.success) existing.successes++
    else existing.failures++
    existing.totalDurationMs += req.totalDurationMs
    this.providerStats.set(key, existing)
  }

  setConfigStatus(status: RouterStats['configStatus']): void {
    this.configStatus = status
  }

  getSummary(): RouterStats {
    const total = this.records.length
    const successful = this.records.filter((r) => r.success).length
    const fallbacks = this.records.filter((r) => r.fallbackUsed).length
    const avgDuration =
      total > 0
        ? Math.round(this.records.reduce((sum, r) => sum + r.totalDurationMs, 0) / total)
        : 0

    const providerStats: Record<string, ProviderStat> = {}
    for (const [key, stat] of this.providerStats.entries()) {
      providerStats[key] = stat
    }

    return {
      totalRequests: total,
      successfulRequests: successful,
      failedRequests: total - successful,
      fallbackCount: fallbacks,
      averageDurationMs: avgDuration,
      providerStats,
      recentRequests: [...this.records].reverse(),
      configStatus: this.configStatus,
    }
  }
}
