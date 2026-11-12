import { vi } from 'vitest'
import { config } from '../../../config'
import { AgentRuntimeService } from './agent-runtime.service'

describe('Office task session recovery', () => {
  const bridge = config.officeBridge
  afterEach(() => { config.officeBridge = bridge })

  function fixture(messages: Array<Record<string, unknown>>) {
    const task = { id: 'original-task', sessionId: 'rejected-session', messages }
    const repository = { getByUserIdAndId: vi.fn().mockResolvedValue(task), updateStatus: vi.fn() }
    const service = Object.create(AgentRuntimeService.prototype)
    const download = vi.fn().mockResolvedValue(undefined)
    const mcp = { createServer: vi.fn().mockReturnValue({}) }
    Object.assign(service, { contentGenerateRepository: repository, logger: { debug: vi.fn(), warn: vi.fn() }, downloadAgentSession: download, mediaMcp: mcp, aideoMcp: mcp, utilMcp: { server: {} }, videoEditMcp: mcp, dramaRecapMcp: mcp, videoUtilsMcp: mcp, styleTransferMcp: mcp, imageEditMcp: mcp })
    return { service, download, task }
  }

  it('keeps the original task/history and starts a fresh SDK session after pre-output rejection', async () => {
    config.officeBridge = { tenantId: 'fixture', secret: 'fixture', officeOrigin: 'http://localhost:3000', revision: 1 }
    const { service, download, task } = fixture([{ type: 'user' }, { type: 'error' }])
    const result = await service.initializeTask('user', 'CREATOR', { taskId: task.id }, new AbortController(), { headers: {} })
    expect(result.taskId).toBe(task.id)
    expect(result.sessionId).toBeUndefined()
    expect(result.historicalMessages).toBe(task.messages)
    expect(download).not.toHaveBeenCalled()
  })

  it('resumes answered sessions so existing tool work cannot be silently restarted', async () => {
    config.officeBridge = { tenantId: 'fixture', secret: 'fixture', officeOrigin: 'http://localhost:3000', revision: 1 }
    const { service, download, task } = fixture([{ type: 'user' }, { type: 'assistant' }])
    const result = await service.initializeTask('user', 'CREATOR', { taskId: task.id }, new AbortController(), { headers: {} })
    expect(result.sessionId).toBe(task.sessionId)
    expect(download).toHaveBeenCalledWith(task)
  })
})
