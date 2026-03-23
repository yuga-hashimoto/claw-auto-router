import { describe, expect, it } from 'vitest'
import {
  buildBackgroundServiceProgramArguments,
  buildLaunchAgentPlist,
  type BackgroundServiceOptions,
  type ServiceCommandSpec,
} from '../../../src/service/launchd.js'

describe('buildBackgroundServiceProgramArguments', () => {
  it('includes explicit runtime flags for the background service', () => {
    const command: ServiceCommandSpec = {
      program: '/opt/homebrew/bin/claw-auto-router',
      args: [],
    }
    const options: BackgroundServiceOptions = {
      configPath: '/Users/example/.openclaw/moltbot.json',
      routerConfigPath: '/Users/example/.openclaw/router.config.json',
      port: 43123,
      host: '0.0.0.0',
      logLevel: 'info',
      adminToken: 'secret-token',
      requestTimeoutMs: 45000,
      startMode: 'always',
    }

    expect(buildBackgroundServiceProgramArguments(command, options)).toEqual([
      '/opt/homebrew/bin/claw-auto-router',
      'serve',
      '--config',
      '/Users/example/.openclaw/moltbot.json',
      '--router-config',
      '/Users/example/.openclaw/router.config.json',
      '--port',
      '43123',
      '--host',
      '0.0.0.0',
      '--log-level',
      'info',
      '--request-timeout-ms',
      '45000',
      '--admin-token',
      'secret-token',
    ])
  })
})

describe('buildLaunchAgentPlist', () => {
  it('renders a launchd plist with escaped paths and logs', () => {
    const plist = buildLaunchAgentPlist(
      ['/opt/homebrew/bin/claw-auto-router', 'serve', '--config', '/Users/example/.openclaw/moltbot.json'],
      {
        plistPath: '/Users/example/Library/LaunchAgents/ai.openclaw.claw-auto-router.plist',
        stdoutPath: '/Users/example/.openclaw/logs/claw-auto-router.launchd.out.log',
        stderrPath: '/Users/example/.openclaw/logs/claw-auto-router.launchd.err.log',
      },
      '/Users/example',
    )

    expect(plist).toContain('<string>ai.openclaw.claw-auto-router</string>')
    expect(plist).toContain('<string>/opt/homebrew/bin/claw-auto-router</string>')
    expect(plist).toContain('<string>/Users/example/.openclaw/logs/claw-auto-router.launchd.out.log</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<true/>')
  })
})
