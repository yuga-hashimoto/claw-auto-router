import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OpenClawConfigSchema, type RawConfig } from './schema.js'
import { ConfigError } from '../utils/errors.js'
import { resolveUserPath } from '../utils/paths.js'

/** Ordered list of default config paths to try */
const DEFAULT_PATHS = [
  join(homedir(), '.openclaw', 'openclaw.json'),
  join(homedir(), '.openclaw', 'moltbot.json'),
]

export interface LoadResult {
  config: RawConfig
  path: string
}

export interface LoadError {
  error: string
  triedPaths: string[]
}

export type LoadOutcome =
  | ({ ok: true } & LoadResult)
  | ({ ok: false } & LoadError)

/**
 * Discover and load the OpenClaw config file.
 *
 * Priority:
 *   1. OPENCLAW_CONFIG_PATH env var
 *   2. ~/.openclaw/openclaw.json
 *   3. ~/.openclaw/moltbot.json
 */
export function loadOpenClawConfig(overridePath?: string): LoadOutcome {
  const candidates = overridePath ? [resolveUserPath(overridePath)] : DEFAULT_PATHS

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue

    let raw: string
    try {
      raw = readFileSync(candidate, 'utf-8')
    } catch (err) {
      return {
        ok: false,
        error: `Failed to read "${candidate}": ${String(err)}`,
        triedPaths: candidates,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: `Failed to parse JSON in "${candidate}": not valid JSON`,
        triedPaths: candidates,
      }
    }

    const result = OpenClawConfigSchema.safeParse(parsed)
    if (!result.success) {
      // Partial parse: log issues but still try to extract what we can
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      console.warn(
        `[claw-auto-router] Config at "${candidate}" has validation issues:\n` +
          issues.map((i) => `  - ${i}`).join('\n') +
          '\n  Proceeding with best-effort parse.',
      )
      // Try a lenient parse with a partial schema fallback
      const lenient = OpenClawConfigSchema.partial().safeParse(parsed)
      if (lenient.success) {
        return { ok: true, config: lenient.data as RawConfig, path: candidate }
      }
    } else {
      return { ok: true, config: result.data, path: candidate }
    }
  }

  if (overridePath) {
    return {
      ok: false,
      error: `Config file not found at "${overridePath}"`,
      triedPaths: candidates,
    }
  }

  return {
    ok: false,
    error: `No OpenClaw config found. Tried: ${candidates.join(', ')}`,
    triedPaths: candidates,
  }
}

/**
 * Throw a ConfigError if the load failed; otherwise return the config.
 * Use this for strict startup validation.
 */
export function requireOpenClawConfig(overridePath?: string): LoadResult {
  const outcome = loadOpenClawConfig(overridePath)
  if (!outcome.ok) {
    throw new ConfigError(outcome.error)
  }
  return { config: outcome.config, path: outcome.path }
}
