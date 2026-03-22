import { describe, expect, it } from 'vitest'
import { getHelpText, parseCliArgs } from '../../src/cli.js'

describe('parseCliArgs', () => {
  it('parses supported CLI flags', () => {
    const args = parseCliArgs([
      '--config',
      '/tmp/openclaw.json',
      '--router-config',
      '/tmp/router.config.json',
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
      help: false,
      configPath: '/tmp/openclaw.json',
      routerConfigPath: '/tmp/router.config.json',
      port: 3001,
      host: '127.0.0.1',
      logLevel: 'debug',
      adminToken: 'secret',
      requestTimeoutMs: 45000,
    })
  })

  it('returns help mode when requested', () => {
    expect(parseCliArgs(['--help'])).toEqual({ help: true })
  })

  it('throws for invalid integer values', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(
      'Invalid value for --port: expected an integer, received "abc"',
    )
  })
})

describe('getHelpText', () => {
  it('includes the CLI command name and main flags', () => {
    const helpText = getHelpText('claw-auto-router')

    expect(helpText).toContain('claw-auto-router')
    expect(helpText).toContain('--config <path>')
    expect(helpText).toContain('--router-config <path>')
  })
})
