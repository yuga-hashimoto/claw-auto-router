import { isModelAvailable, type NormalizedModel } from './types.js'

/**
 * ProviderRegistry — flat lookup for normalized models.
 *
 * Supports lookup by:
 *   - composite ID: "nvidia/qwen/qwen3.5-397b-a17b"
 *   - alias: "qwen3.5-397b"
 */
export class ProviderRegistry {
  private readonly byId: Map<string, NormalizedModel>
  private readonly byAlias: Map<string, NormalizedModel>

  constructor(models: NormalizedModel[]) {
    this.byId = new Map()
    this.byAlias = new Map()

    for (const model of models) {
      this.byId.set(model.id, model)
      if (model.alias !== undefined) {
        this.byAlias.set(model.alias.toLowerCase(), model)
      }
    }
  }

  lookup(ref: string): NormalizedModel | undefined {
    return this.byId.get(ref) ?? this.byAlias.get(ref.toLowerCase())
  }

  /** All models in the registry */
  all(): NormalizedModel[] {
    return Array.from(this.byId.values())
  }

  /** Only models with a resolved API key */
  resolvable(): NormalizedModel[] {
    return this.all().filter((m) => isModelAvailable(m))
  }

  get size(): number {
    return this.byId.size
  }
}
