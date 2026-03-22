export function getEnv(key: string): string | undefined {
  return process.env[key]
}

export function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue
}

export function getEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key]
  if (raw === undefined) return defaultValue
  const parsed = parseInt(raw, 10)
  return isNaN(parsed) ? defaultValue : parsed
}
