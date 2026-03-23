import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export type BackgroundServiceAction = 'created' | 'updated' | 'unchanged' | 'removed'
export type BackgroundServiceStartMode = 'always' | 'never'

export interface BackgroundServiceOptions {
  configPath?: string
  routerConfigPath?: string
  port: number
  host: string
  logLevel: string
  adminToken?: string
  requestTimeoutMs: number
  startMode?: BackgroundServiceStartMode
}

export interface BackgroundServiceStatus {
  supported: boolean
  manager: 'launchd' | 'unsupported'
  label: string
  plistPath: string
  stdoutPath: string
  stderrPath: string
  command?: string
  installed: boolean
  loaded: boolean
  running: boolean
  pid?: number
  lastExitStatus?: number
  action?: BackgroundServiceAction
  detail?: string
  error?: string
}

export interface ServiceCommandSpec {
  program: string
  args: string[]
}

interface LaunchdPaths {
  plistPath: string
  stdoutPath: string
  stderrPath: string
}

const LAUNCHD_LABEL = 'ai.openclaw.claw-auto-router'

function isSupportedPlatform(): boolean {
  return process.platform === 'darwin'
}

function getLaunchdPaths(homePath = homedir()): LaunchdPaths {
  return {
    plistPath: join(homePath, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    stdoutPath: join(homePath, '.openclaw', 'logs', 'claw-auto-router.launchd.out.log'),
    stderrPath: join(homePath, '.openclaw', 'logs', 'claw-auto-router.launchd.err.log'),
  }
}

function createBaseStatus(paths = getLaunchdPaths()): BackgroundServiceStatus {
  return {
    supported: isSupportedPlatform(),
    manager: isSupportedPlatform() ? 'launchd' : 'unsupported',
    label: LAUNCHD_LABEL,
    plistPath: paths.plistPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    installed: existsSync(paths.plistPath),
    loaded: false,
    running: false,
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function getGuiDomain(): string {
  const getuid = process.getuid
  if (getuid === undefined) {
    throw new Error('process.getuid() is not available on this platform')
  }

  return `gui/${getuid.call(process)}`
}

function getServiceTarget(): string {
  return `${getGuiDomain()}/${LAUNCHD_LABEL}`
}

function formatLaunchctlError(args: string[], stdout: string, stderr: string): string {
  const output = [stderr.trim(), stdout.trim()].filter((part) => part !== '').join('\n')
  return output === '' ? `launchctl ${args.join(' ')} failed` : output
}

function runLaunchctl(args: string[], options?: { allowFailure?: boolean }): { stdout: string; stderr: string } {
  const result = spawnSync('launchctl', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0 && options?.allowFailure !== true) {
    throw new Error(formatLaunchctlError(args, result.stdout, result.stderr))
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function resolveServiceCommand(): ServiceCommandSpec {
  const argv1 = process.argv[1]
  if (argv1 !== undefined) {
    const resolvedArgv1 = resolve(argv1)
    const base = basename(resolvedArgv1)

    if ((base === 'claw-auto-router' || base === 'clawr') && existsSync(resolvedArgv1)) {
      return normalizeExecutablePath(resolvedArgv1)
    }

    if (resolvedArgv1.endsWith('.js') && existsSync(resolvedArgv1)) {
      return {
        program: process.execPath,
        args: [resolvedArgv1],
      }
    }
  }

  const whichResult = spawnSync('which', ['claw-auto-router'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const discoveredCommand = whichResult.stdout.trim()
  if (whichResult.status === 0 && discoveredCommand !== '' && existsSync(discoveredCommand)) {
    return normalizeExecutablePath(discoveredCommand)
  }

  throw new Error(
    'Could not resolve an executable claw-auto-router command for launchd. Install the npm package globally or run from built dist/index.js.',
  )
}

function normalizeExecutablePath(commandPath: string): ServiceCommandSpec {
  const resolvedCommandPath = realpathSync(commandPath)

  try {
    const firstLine = readFileSync(resolvedCommandPath, 'utf-8').split('\n', 1)[0] ?? ''
    if (firstLine.startsWith('#!') && firstLine.includes('node')) {
      return {
        program: process.execPath,
        args: [resolvedCommandPath],
      }
    }
  } catch {
    // If the file is binary or unreadable as text, fall back to executing it directly.
  }

  return {
    program: resolvedCommandPath,
    args: [],
  }
}

export function buildBackgroundServiceProgramArguments(
  command: ServiceCommandSpec,
  options: BackgroundServiceOptions,
): string[] {
  const args = ['serve']

  if (options.configPath !== undefined) {
    args.push('--config', options.configPath)
  }

  if (options.routerConfigPath !== undefined) {
    args.push('--router-config', options.routerConfigPath)
  }

  args.push('--port', String(options.port))
  args.push('--host', options.host)
  args.push('--log-level', options.logLevel)
  args.push('--request-timeout-ms', String(options.requestTimeoutMs))

  if (options.adminToken !== undefined) {
    args.push('--admin-token', options.adminToken)
  }

  return [command.program, ...command.args, ...args]
}

export function buildLaunchAgentPlist(
  programArguments: string[],
  paths = getLaunchdPaths(),
  workingDirectory = homedir(),
): string {
  const argumentXml = programArguments.map((value) => `    <string>${escapeXml(value)}</string>`).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(paths.stderrPath)}</string>
</dict>
</plist>
`
}

export function getBackgroundServiceStatus(): BackgroundServiceStatus {
  const paths = getLaunchdPaths()
  const status = createBaseStatus(paths)

  if (!status.supported) {
    status.error = 'Automatic background service is currently only supported on macOS via launchd.'
    return status
  }

  try {
    const command = resolveServiceCommand()
    status.command = [command.program, ...command.args].join(' ')
  } catch (error) {
    status.error = error instanceof Error ? error.message : 'Could not resolve service executable'
  }

  if (!status.installed) {
    return status
  }

  const result = spawnSync('launchctl', ['print', getServiceTarget()], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0) {
    return status
  }

  status.loaded = true

  const pidMatch = result.stdout.match(/\bpid = (\d+)/)
  if (pidMatch?.[1] !== undefined) {
    status.pid = Number.parseInt(pidMatch[1], 10)
    status.running = true
  }

  const stateMatch = result.stdout.match(/\bstate = ([^\n]+)/)
  if (stateMatch?.[1]?.trim().toLowerCase() === 'running') {
    status.running = true
  }

  const exitMatch = result.stdout.match(/\blast exit code = (\d+)/)
  if (exitMatch?.[1] !== undefined) {
    status.lastExitStatus = Number.parseInt(exitMatch[1], 10)
  }

  return status
}

export function installBackgroundService(options: BackgroundServiceOptions): BackgroundServiceStatus {
  const paths = getLaunchdPaths()
  const baseStatus = createBaseStatus(paths)

  if (!baseStatus.supported) {
    baseStatus.error = 'Automatic background service is currently only supported on macOS via launchd.'
    return baseStatus
  }

  const command = resolveServiceCommand()
  const programArguments = buildBackgroundServiceProgramArguments(command, options)
  const plistContents = buildLaunchAgentPlist(programArguments, paths)

  mkdirSync(dirname(paths.plistPath), { recursive: true })
  mkdirSync(dirname(paths.stdoutPath), { recursive: true })

  let action: BackgroundServiceAction = 'created'
  if (existsSync(paths.plistPath)) {
    const current = readFileSync(paths.plistPath, 'utf-8')
    if (current === plistContents) {
      action = 'unchanged'
    } else {
      action = 'updated'
    }
  }

  writeFileSync(paths.plistPath, plistContents, 'utf-8')

  let detail: string | undefined
  if (options.startMode !== 'never') {
    runLaunchctl(['bootout', getServiceTarget()], { allowFailure: true })
    runLaunchctl(['enable', getServiceTarget()], { allowFailure: true })
    runLaunchctl(['bootstrap', getGuiDomain(), paths.plistPath])
    runLaunchctl(['kickstart', '-k', getServiceTarget()], { allowFailure: true })
    detail = 'launchd service installed and started'
  } else {
    detail = 'launchd service installed; start skipped because router is already responding'
  }

  return {
    ...getBackgroundServiceStatus(),
    action,
    command: [command.program, ...command.args].join(' '),
    detail,
  }
}

export function startBackgroundService(): BackgroundServiceStatus {
  const status = getBackgroundServiceStatus()

  if (!status.supported) {
    return status
  }

  if (!status.installed) {
    return {
      ...status,
      error: 'No launchd service is installed yet. Run `claw-auto-router service install` first.',
    }
  }

  runLaunchctl(['enable', getServiceTarget()], { allowFailure: true })

  if (status.loaded) {
    runLaunchctl(['kickstart', '-k', getServiceTarget()], { allowFailure: true })
  } else {
    runLaunchctl(['bootstrap', getGuiDomain(), status.plistPath])
    runLaunchctl(['kickstart', '-k', getServiceTarget()], { allowFailure: true })
  }

  return {
    ...getBackgroundServiceStatus(),
    detail: 'launchd service started',
  }
}

export function stopBackgroundService(): BackgroundServiceStatus {
  const status = getBackgroundServiceStatus()

  if (!status.supported) {
    return status
  }

  if (!status.installed || !status.loaded) {
    return {
      ...status,
      detail: 'launchd service is not loaded',
    }
  }

  runLaunchctl(['bootout', getServiceTarget()], { allowFailure: true })

  return {
    ...getBackgroundServiceStatus(),
    loaded: false,
    running: false,
    detail: 'launchd service stopped',
  }
}

export function restartBackgroundService(): BackgroundServiceStatus {
  const status = getBackgroundServiceStatus()

  if (!status.supported) {
    return status
  }

  if (!status.installed) {
    return {
      ...status,
      error: 'No launchd service is installed yet. Run `claw-auto-router service install` first.',
    }
  }

  runLaunchctl(['bootout', getServiceTarget()], { allowFailure: true })
  runLaunchctl(['bootstrap', getGuiDomain(), status.plistPath])
  runLaunchctl(['kickstart', '-k', getServiceTarget()], { allowFailure: true })

  return {
    ...getBackgroundServiceStatus(),
    detail: 'launchd service restarted',
  }
}

export function uninstallBackgroundService(): BackgroundServiceStatus {
  const status = getBackgroundServiceStatus()

  if (!status.supported) {
    return status
  }

  if (status.loaded) {
    runLaunchctl(['bootout', getServiceTarget()], { allowFailure: true })
  }

  if (existsSync(status.plistPath)) {
    unlinkSync(status.plistPath)
  }

  return {
    ...getBackgroundServiceStatus(),
    action: 'removed',
    installed: false,
    loaded: false,
    running: false,
    detail: 'launchd service removed',
  }
}
