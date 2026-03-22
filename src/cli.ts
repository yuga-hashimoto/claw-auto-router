import { parseArgs } from 'node:util'

export interface CliOptions {
  help: boolean
  configPath?: string
  routerConfigPath?: string
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
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
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

  const options: CliOptions = {
    help: values.help ?? false,
  }

  if (values.config !== undefined) {
    options.configPath = values.config
  }

  if (values['router-config'] !== undefined) {
    options.routerConfigPath = values['router-config']
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

Options:
  -h, --help                       Show this help message
  -c, --config <path>             Path to openclaw.json or moltbot.json
      --router-config <path>      Path to router.config.json
  -p, --port <number>             HTTP port (default: 3000)
      --host <host>               Bind host (default: 0.0.0.0)
      --log-level <level>         trace|debug|info|warn|error
      --admin-token <token>       Protect POST /reload-config
      --request-timeout-ms <ms>   Upstream request timeout in milliseconds

Environment fallback:
  OPENCLAW_CONFIG_PATH
  ROUTER_REQUEST_TIMEOUT_MS
  ROUTER_ADMIN_TOKEN
  PORT
  HOST
  LOG_LEVEL
`
}
