import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_CODE_ROUTER_PROVIDER_NAME } from '../agent.constants'
import { ClaudeCodeRouterService } from './claude-code-router.service'

interface TestableClaudeCodeRouterService {
  buildConfigFile: (routerConfig: unknown) => {
    PORT?: number
    Providers?: Array<{
      name: string
      api_base_url: string
      api_key: string
      models: string[]
      transformer?: unknown
    }>
    Router?: {
      default: string
      background?: string
      think?: string
    }
  }
}

describe('claudeCodeRouterService', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('rejects absent and legacy router authentication', () => {
    const service = new ClaudeCodeRouterService() as unknown as TestableClaudeCodeRouterService
    for (const value of ['', 'ccr']) {
      vi.stubEnv('OFFICE_CCR_API_KEY', value)
      expect(() => service.buildConfigFile({})).toThrow(/OFFICE_CCR_API_KEY/)
    }
  })
  it('builds router config from agent model config without changing transformer settings', () => {
    vi.stubEnv('OFFICE_CCR_API_KEY', 'synthetic-router-authentication-only-123456')
    const service = new ClaudeCodeRouterService() as unknown as TestableClaudeCodeRouterService
    const routerConfig = service.buildConfigFile({
      routerPort: 24567,
      baseUrl: 'https://agent.example.com/v1/messages',
      apiKey: 'agent-key',
      models: ['deepseek-anthropic-chat', 'deepseek-anthropic-lite'],
      defaultModel: 'deepseek-anthropic-chat',
      backgroundModel: 'deepseek-anthropic-lite',
      thinkModel: 'deepseek-anthropic-chat',
    })

    expect(routerConfig.PORT).toBe(24567)
    expect(routerConfig.Providers?.[0]).toEqual({
      name: CLAUDE_CODE_ROUTER_PROVIDER_NAME,
      api_base_url: 'https://agent.example.com/v1/messages',
      api_key: 'agent-key',
      models: ['deepseek-anthropic-chat', 'deepseek-anthropic-lite'],
      transformer: {
        use: ['Anthropic'],
      },
    })
    expect(routerConfig.Router).toEqual({
      default: `${CLAUDE_CODE_ROUTER_PROVIDER_NAME},deepseek-anthropic-chat`,
      background: `${CLAUDE_CODE_ROUTER_PROVIDER_NAME},deepseek-anthropic-lite`,
      think: `${CLAUDE_CODE_ROUTER_PROVIDER_NAME},deepseek-anthropic-chat`,
    })
  })
})
