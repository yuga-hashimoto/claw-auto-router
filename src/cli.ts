import { parseArgs } from 'node:util'
import { DEFAULT_PORT } from './defaults.js'

export interface CliOptions {
  command: 'serve' | 'setup' | 'clean-setup' | 'logs'
  help: boolean
  configPath?: string
  routerConfigPath?: string
  baseUrl?: string
  providerId?: string
  modelId?: string
  limit?: number
  json?: boolean
  port?: number
  host?: string
  logLevel?: string
  adminToken?: string
  requestTimeoutMs?: number
}

function parseIntegerOption(name: string, value?: string): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid value for --${name}: expected an integer, received "${value}"`)
  }

  return parsed
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: {
        type: 'boolean',
        short: 'h',
      },
      config: {
        type: 'string',
        short: 'c',
      },
      'router-config': {
        type: 'string',
      },
      'base-url': {
        type: 'string',
      },
      'provider-id': {
        type: 'string',
      },
      'model-id': {
        type: 'string',
      },
      limit: {
        type: 'string',
      },
      json: {
        type: 'boolean',
      },
      port: {
        type: 'string',
        short: 'p',
      },
      host: {
        type: 'string',
      },
      'log-level': {
        type: 'string',
      },
      'admin-token': {
        type: 'string',
      },
      'request-timeout-ms': {
        type: 'string',
      },
    },
  })

  const rawCommand = positionals[0]
  let command: CliOptions['command'] = 'serve'
  if (rawCommand !== undefined) {
    if (rawCommand === 'setup') {
      command = 'setup'
    } else if (rawCommand === 'clean-setup') {
      command = 'clean-setup'
    } else if (rawCommand === 'logs') {
      command = 'logs'
    } else if (rawCommand === 'serve' || rawCommand === 'start') {
      command = 'serve'
    } else {
      throw new Error(`Unknown command "${rawCommand}"`)
    }
  }

  if (positionals.length > 1) {
    throw new Error(`Unexpected extra arguments: ${positionals.slice(1).join(' ')}`)
  }

  const options: CliOptions = {
    command,
    help: values.help ?? false,
  }

  if (values.config !== undefined) {
    options.configPath = values.config
  }

  if (values['router-config'] !== undefined) {
    options.routerConfigPath = values['router-config']
  }

  if (values['base-url'] !== undefined) {
    options.baseUrl = values['base-url']
  }

  if (values['provider-id'] !== undefined) {
    options.providerId = values['provider-id']
  }

  if (values['model-id'] !== undefined) {
    options.modelId = values['model-id']
  }

  const limit = parseIntegerOption('limit', values.limit)
  if (limit !== undefined) {
    options.limit = limit
  }

  if (values.json !== undefined) {
    options.json = values.json
  }

  const port = parseIntegerOption('port', values.port)
  if (port !== undefined) {
    options.port = port
  }

  if (values.host !== undefined) {
    options.host = values.host
  }

  if (values['log-level'] !== undefined) {
    options.logLevel = values['log-level']
  }

  if (values['admin-token'] !== undefined) {
    options.adminToken = values['admin-token']
  }

  const requestTimeoutMs = parseIntegerOption('request-timeout-ms', values['request-timeout-ms'])
  if (requestTimeoutMs !== undefined) {
    options.requestTimeoutMs = requestTimeoutMs
  }

  return options
}

export function getHelpText(commandName = 'clawr'): string {
  return `${commandName}

Usage:
  ${commandName} [options]
  ${commandName} setup [options]
  ${commandName} clean-setup [options]
  ${commandName} logs [options]

Commands:
  setup                            Detect OpenClaw config, ask for model tiers,
                                   and wire OpenClaw to use ${commandName}
  clean-setup                      Rebuild claw-auto-router settings from scratch
                                   and replace existing tier assignments
  logs                             Show recent routing decisions and why they routed that way

Common options:
  -h, --help                       Show this help message
  -c, --config <path>             Path to openclaw.json or moltbot.json
      --router-config <path>      Path to router.config.json
      --limit <number>            How many routing decisions to show in logs mode
      --json                      Print logs as JSON in logs mode
  -p, --port <number>             HTTP port (default: ${DEFAULT_PORT})
      --base-url <url>            Base URL written into OpenClaw during setup
      --provider-id <id>          Provider id written into OpenClaw during setup
      --model-id <id>             Model id written into OpenClaw during setup
      --host <host>               Bind host (default: 0.0.0.0)
      --log-level <level>         trace|debug|info|warn|error
      --admin-token <token>       Protect POST /reload-config
      --request-timeout-ms <ms>   Upstream request timeout in milliseconds

Examples:
  ${commandName} setup
  ${commandName} clean-setup
  ${commandName} setup --config ~/.openclaw/moltbot.json
  ${commandName} logs --limit 20
  ${commandName} logs --json
  ${commandName} --port 3001

Environment fallback:
  OPENCLAW_CONFIG_PATH
  ROUTER_REQUEST_TIMEOUT_MS
  ROUTER_ADMIN_TOKEN
  PORT
  HOST
  LOG_LEVEL
`
}
