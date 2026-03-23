import { createInterface } from 'node:readline/promises'
import type { RouterAIConfig, RoutingClassificationMode } from '../config/router-config.js'
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

const ROUTING_TIERS: RoutingTier[] = ['SIMPLE', 'STANDARD', 'COMPLEX', 'CODE']

export type TierPriorityMap = Partial<Record<RoutingTier, string[]>>

export interface TierPriorityPrompt {
  tier: RoutingTier
  models: NormalizedModel[]
  existingPriorityIds: string[]
  orderSource: 'automatic' | 'explicit'
}

export interface RouterAIPrompt {
  current?: RouterAIConfig | undefined
  recommendedModelId?: string | undefined
  models: NormalizedModel[]
}

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

export async function runTierPriorityWizard(
  prompts: TierPriorityPrompt[],
  existingPriority: TierPriorityMap,
  options?: { interactive?: boolean | undefined, replaceExisting?: boolean | undefined },
): Promise<TierPriorityMap> {
  const initialPriority = options?.replaceExisting === true ? {} : cloneTierPriority(existingPriority)
  if (prompts.length === 0) {
    return initialPriority
  }

  if (options?.interactive !== true) {
    return initialPriority
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return initialPriority
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const nextPriority = cloneTierPriority(initialPriority)

  console.log('┌──────────────────────────────────────────────────────────────┐')
  console.log('│        claw-auto-router — Tier Priority Setup Wizard         │')
  console.log('├──────────────────────────────────────────────────────────────┤')
  console.log('│  Review the order inside each tier.                          │')
  console.log('│  Press Enter to keep the current setting.                    │')
  console.log('│  Type "auto" to use automatic ordering.                      │')
  console.log('│  Type numbers like "2 1 3" to pin models to the front.       │')
  console.log('└──────────────────────────────────────────────────────────────┘')
  console.log()

  for (const prompt of prompts) {
    console.log(`  Tier     : ${prompt.tier}`)
    console.log(
      `  Current  : ${prompt.orderSource === 'explicit' ? 'explicit priority override' : 'automatic heuristic/config order'}`,
    )
    console.log()

    for (const [index, model] of prompt.models.entries()) {
      console.log(`    ${index + 1}) ${model.name} (${model.id})`)
    }
    console.log()
    console.log('    Enter  Keep current setting')
    console.log('    auto   Remove explicit priority for this tier')
    console.log('    2 1    Pin model 2 first, then model 1, keep the rest after them')
    console.log()

    while (true) {
      const raw = (await rl.question('  Priority [Enter=keep, auto, numbers]: ')).trim()
      if (raw === '') {
        if (prompt.existingPriorityIds.length > 0 && options?.replaceExisting !== true) {
          console.log(`  ✓ Keeping explicit priority for ${prompt.tier}`)
        } else {
          console.log(`  ✓ Keeping automatic order for ${prompt.tier}`)
        }
        break
      }

      if (raw.toLowerCase() === 'auto') {
        delete nextPriority[prompt.tier]
        console.log(`  ✓ ${prompt.tier} now uses automatic order`)
        break
      }

      const selectedPositions = parsePrioritySelectionInput(raw, prompt.models.length)
      if (selectedPositions === undefined) {
        console.log('  Please enter unique numbers from the list, separated by spaces or commas.')
        continue
      }

      nextPriority[prompt.tier] = selectedPositions.map((position) => prompt.models[position - 1]!.id)
      console.log(
        `  ✓ Saved explicit priority for ${prompt.tier}: ${nextPriority[prompt.tier]!.join(' -> ')}`,
      )
      break
    }

    console.log()
  }

  rl.close()

  return pruneTierPriority(nextPriority)
}

export async function runRouterAIWizard(
  prompt: RouterAIPrompt,
  options?: { interactive?: boolean | undefined },
): Promise<RouterAIConfig | undefined> {
  if (options?.interactive !== true) {
    return prompt.current?.mode === 'ai' ? prompt.current : undefined
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return prompt.current?.mode === 'ai' ? prompt.current : undefined
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const currentMode: RoutingClassificationMode = prompt.current?.mode ?? 'heuristic'

  console.log('┌──────────────────────────────────────────────────────────────┐')
  console.log('│         claw-auto-router — Routing Strategy Wizard          │')
  console.log('├──────────────────────────────────────────────────────────────┤')
  console.log('│  Choose how requests are classified into routing tiers.     │')
  console.log('│  RouterAI adds one extra model call before auto-routing.    │')
  console.log('└──────────────────────────────────────────────────────────────┘')
  console.log()
  console.log(`  Current  : ${currentMode === 'ai' ? 'RouterAI classifier' : 'Deterministic heuristics'}`)
  if (prompt.current?.mode === 'ai' && prompt.current.model !== undefined) {
    console.log(`  Model    : ${prompt.current.model}`)
  }
  console.log()
  console.log('    1) Heuristic   Fast, deterministic, no extra model call (Recommended)')
  console.log('    2) RouterAI    Better on ambiguous prompts, but costs one small classifier request')
  console.log()

  let mode: RoutingClassificationMode = currentMode
  while (true) {
    const raw = (await rl.question(`  Choice [1-2, Enter=${currentMode === 'ai' ? '2' : '1'}]: `)).trim()
    if (raw === '') {
      break
    }

    if (raw === '1') {
      mode = 'heuristic'
      break
    }

    if (raw === '2') {
      mode = 'ai'
      break
    }

    console.log('  Please enter 1 or 2.')
  }

  if (mode === 'heuristic') {
    console.log('  ✓ Using deterministic heuristics for routing tier classification')
    console.log()
    rl.close()
    return undefined
  }

  if (prompt.models.length === 0) {
    console.log('  → No classifier-capable models were available, so heuristics will stay enabled.')
    console.log()
    rl.close()
    return undefined
  }

  const defaultModelId =
    (prompt.current?.mode === 'ai' ? prompt.current.model : undefined) ??
    prompt.recommendedModelId ??
    prompt.models[0]?.id

  const defaultIndex = Math.max(
    0,
    prompt.models.findIndex((model) => model.id === defaultModelId),
  )

  console.log('  Choose the model that should classify each auto-routed request.')
  console.log('  A fast, general-purpose model is usually best here.')
  console.log()

  for (const [index, model] of prompt.models.entries()) {
    const recommended = model.id === prompt.recommendedModelId ? '  (Recommended)' : ''
    console.log(`    ${index + 1}) ${model.name} (${model.id})${recommended}`)
  }
  console.log()

  let selectedModel = prompt.models[defaultIndex]
  while (selectedModel === undefined) {
    const raw = (await rl.question(`  Classifier model [1-${prompt.models.length}, Enter=${defaultIndex + 1}]: `)).trim()
    if (raw === '') {
      selectedModel = prompt.models[defaultIndex]
      break
    }

    const index = Number.parseInt(raw, 10)
    if (!Number.isNaN(index) && `${index}` === raw && index >= 1 && index <= prompt.models.length) {
      selectedModel = prompt.models[index - 1]
      break
    }

    console.log(`  Please enter a number from 1 to ${prompt.models.length}.`)
  }

  const finalSelection = selectedModel ?? prompt.models[defaultIndex] ?? prompt.models[0]
  if (finalSelection === undefined) {
    console.log('  → No classifier model could be selected, so heuristics will stay enabled.')
    console.log()
    rl.close()
    return undefined
  }

  console.log(`  ✓ RouterAI will classify requests with ${finalSelection.id}`)
  console.log()
  rl.close()

  return {
    mode: 'ai',
    model: finalSelection.id,
    timeoutMs: prompt.current?.timeoutMs ?? 8_000,
  }
}

export function parsePrioritySelectionInput(raw: string, maxPosition: number): number[] | undefined {
  const tokens = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')

  if (tokens.length === 0) {
    return undefined
  }

  const seen = new Set<number>()
  const positions: number[] = []

  for (const token of tokens) {
    const value = Number.parseInt(token, 10)
    if (Number.isNaN(value) || `${value}` !== token || value < 1 || value > maxPosition || seen.has(value)) {
      return undefined
    }
    seen.add(value)
    positions.push(value)
  }

  return positions
}

function cloneTierPriority(priority: TierPriorityMap): TierPriorityMap {
  const cloned: TierPriorityMap = {}

  for (const tier of ROUTING_TIERS) {
    const ids = priority[tier]
    if (ids !== undefined && ids.length > 0) {
      cloned[tier] = [...ids]
    }
  }

  return cloned
}

function pruneTierPriority(priority: TierPriorityMap): TierPriorityMap {
  const pruned: TierPriorityMap = {}

  for (const tier of ROUTING_TIERS) {
    const ids = priority[tier]
    if (ids === undefined || ids.length === 0) {
      continue
    }

    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length > 0) {
      pruned[tier] = uniqueIds
    }
  }

  return pruned
}
