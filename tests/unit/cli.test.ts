import { describe, expect, it } from 'vitest'
import { getHelpText, parseCliArgs } from '../../src/cli.js'

describe('parseCliArgs', () => {
  it('parses supported CLI flags', () => {
    const args = parseCliArgs([
      'setup',
      '--config',
      '/tmp/openclaw.json',
      '--router-config',
      '/tmp/router.config.json',
      '--base-url',
      'http://127.0.0.1:3333',
      '--provider-id',
      'router',
      '--model-id',
      'smart',
      '--port',
      '3001',
      '--host',
      '127.0.0.1',
      '--log-level',
      'debug',
      '--admin-token',
      'secret',
      '--request-timeout-ms',
      '45000',
    ])

    expect(args).toEqual({
      command: 'setup',
      help: false,
      configPath: '/tmp/openclaw.json',
      routerConfigPath: '/tmp/router.config.json',
      baseUrl: 'http://127.0.0.1:3333',
      providerId: 'router',
      modelId: 'smart',
      port: 3001,
      host: '127.0.0.1',
      logLevel: 'debug',
      adminToken: 'secret',
      requestTimeoutMs: 45000,
    })
  })

  it('returns help mode when requested', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'serve', help: true })
  })

  it('parses logs mode flags', () => {
    expect(parseCliArgs(['logs', '--limit', '15', '--json'])).toEqual({
      command: 'logs',
      help: false,
      limit: 15,
      json: true,
    })
  })

  it('parses clean-setup mode flags', () => {
    expect(parseCliArgs(['clean-setup', '--config', '/tmp/openclaw.json'])).toEqual({
      command: 'clean-setup',
      help: false,
      configPath: '/tmp/openclaw.json',
    })
  })

  it('throws for invalid integer values', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(
      'Invalid value for --port: expected an integer, received "abc"',
    )
  })

  it('defaults to serve when no command is given', () => {
    expect(parseCliArgs([])).toEqual({ command: 'serve', help: false })
  })
})

describe('getHelpText', () => {
  it('includes the CLI command name and main flags', () => {
    const helpText = getHelpText('claw-auto-router')

    expect(helpText).toContain('claw-auto-router')
    expect(helpText).toContain('setup')
    expect(helpText).toContain('clean-setup')
    expect(helpText).toContain('logs')
    expect(helpText).toContain('--config <path>')
    expect(helpText).toContain('--router-config <path>')
  })
})
