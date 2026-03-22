import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export function resolveUserPath(path: string): string {
  if (path === '~') {
    return homedir()
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }

  return path
}

export function isLikelyAbsoluteOrHomePath(path: string): boolean {
  return isAbsolute(path) || path === '~' || path.startsWith('~/')
}
