import type { ProxyAttempt } from '../proxy/types.js'

export class RouterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouterError'
  }
}

export class ConfigError extends RouterError {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class NoCandidatesError extends RouterError {
  constructor(requestedModel?: string) {
    const msg = requestedModel
      ? `No resolvable candidate found for model "${requestedModel}"`
      : 'No resolvable candidates available'
    super(msg)
    this.name = 'NoCandidatesError'
  }
}

export class AllProvidersFailed extends RouterError {
  constructor(public readonly attempts: ProxyAttempt[]) {
    super(`All provider attempts failed (${attempts.length} tried)`)
    this.name = 'AllProvidersFailed'
  }
}
