import { createInterface } from 'node:readline/promises'
import type { NormalizedModel } from '../providers/types.js'
import type { RoutingTier } from '../router/types.js'
import { loadRouterConfig, saveRouterConfig } from '../config/router-config.js'

interface TierChoice {
  key: string
  tier: RoutingTier
  label: string
  description: string
}

const TIER_CHOICES: TierChoice[] = [
  {
    key: '1',
    tier: 'SIMPLE',
    label: 'SIMPLE',
    description: 'Fast, cheap — quick Q&A, one-liners, lookups',
  },
  {
    key: '2',
    tier: 'STANDARD',
    label: 'STANDARD',
    description: 'General purpose — default routing for most tasks',
  },
  {
    key: '3',
    tier: 'COMPLEX',
    label: 'COMPLEX',
    description: 'Large context, deep reasoning — analysis, long docs',
  },
  {
    key: '4',
    tier: 'CODE',
    label: 'CODE',
    description: 'Code generation, debugging, refactoring, PRs',
  },
]

/**
 * Interactive wizard that prompts the user to assign routing tiers
 * to models that don't have an explicit tier in modelTiers.
 *
 * Only runs when stdin/stdout are both TTYs (i.e. interactive terminal).
 * In non-interactive mode (Docker, CI) it logs a warning and returns unchanged tiers.
 *
 * Results are saved back to the router.config.json file.
 */
export async function runTierWizard(
  models: NormalizedModel[],
  existingTiers: Record<string, RoutingTier>,
  routerConfigPath: string,
  options?: { interactive?: boolean | undefined, replaceExisting?: boolean | undefined },
): Promise<Record<string, RoutingTier>> {
  const initialTiers = options?.replaceExisting === true ? {} : existingTiers
  const unassigned =
    options?.replaceExisting === true
      ? models
      : models.filter((m) => initialTiers[m.id] === undefined)

  if (unassigned.length === 0) return initialTiers

  if (options?.interactive !== true) {
    console.warn(
      `[claw-auto-router] ${unassigned.length} model(s) have no tier assignment — routing uses heuristics.`,
    )
    console.warn('[claw-auto-router] Run `claw-auto-router setup` to classify them interactively.')
    return initialTiers
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn(
      `[claw-auto-router] ${unassigned.length} model(s) have no tier assignment — routing uses heuristics.`,
    )
    console.warn('[claw-auto-router] Run `claw-auto-router setup` interactively to classify them.')
    return initialTiers
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const assigned = { ...initialTiers }

  console.log()
  console.log('┌──────────────────────────────────────────────────────────────┐')
  console.log('│           claw-auto-router — Model Tier Setup Wizard          │')
  console.log('├──────────────────────────────────────────────────────────────┤')
  console.log('│  Assign each model to its best routing tier.                 │')
  console.log('│  The router will prefer assigned models for that tier.       │')
  console.log('│  Press Enter or type 5 to skip (heuristics decide).          │')
  console.log('└──────────────────────────────────────────────────────────────┘')
  console.log()

  for (const model of unassigned) {
    const contextK = Math.round(model.contextWindow / 1000)
    console.log(`  Model    : ${model.name}`)
    console.log(`  ID       : ${model.id}`)
    console.log(
      `  Context  : ${contextK}k tokens   Reasoning: ${model.reasoning ? 'yes ✓' : 'no'}`,
    )
    console.log()

    for (const c of TIER_CHOICES) {
      console.log(`    ${c.key}) ${c.label.padEnd(10)} ${c.description}`)
    }
    console.log(`    5) Skip  — use auto-heuristics`)
    console.log()

    let tier: RoutingTier | undefined
    while (tier === undefined) {
      const raw = (await rl.question('  Choice [1-5, Enter=skip]: ')).trim()
      if (raw === '' || raw === '5') break
      const choice = TIER_CHOICES.find((c) => c.key === raw)
      if (choice !== undefined) {
        tier = choice.tier
      } else {
        console.log('  Please enter a number from 1 to 5.')
      }
    }

    if (tier !== undefined) {
      assigned[model.id] = tier
      console.log(`  ✓ Assigned to ${tier}`)
    } else {
      console.log('  → Skipped (heuristics will decide)')
    }
    console.log()
  }

  rl.close()

  const savedAssignments = Object.keys(assigned).length
  const newlyAssigned = savedAssignments - Object.keys(initialTiers).length
  if (options?.replaceExisting === true || newlyAssigned > 0) {
    saveTiersToConfig(assigned, routerConfigPath)
    console.log(
      `[claw-auto-router] Saved ${options?.replaceExisting === true ? savedAssignments : newlyAssigned} tier assignment(s) to ${routerConfigPath}`,
    )
    console.log()
  }

  return assigned
}

function saveTiersToConfig(tiers: Record<string, RoutingTier>, path: string): void {
  const existing = loadRouterConfig(path)
  saveRouterConfig({ ...existing, modelTiers: tiers }, path)
}
