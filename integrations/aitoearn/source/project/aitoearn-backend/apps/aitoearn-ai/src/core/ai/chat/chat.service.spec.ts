import { AppException, ResponseCode, UserType } from '@yikart/common'
import { AiLogChannel, AiLogStatus } from '@yikart/mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatService } from './chat.service'

describe('chat completion', () => {
  const openai = { createChatCompletion: vi.fn() }
  const logs = { create: vi.fn() }
  const models = { config: { chat: [{ name: 'test-chat', channel: AiLogChannel.OpenAI, scenes: ['agent'] }] } }
  const assets = { uploadFromBuffer: vi.fn(), buildUrl: vi.fn() }
  let service: ChatService
  const request = { userId: 'user-a', userType: UserType.User, model: 'test-chat', messages: [{ role: 'user', content: 'hello' }] }

  beforeEach(() => {
    vi.clearAllMocks()
    service = new ChatService(openai as never, logs as never, models as never, assets as never, {} as never, {} as never)
    openai.createChatCompletion.mockResolvedValue({ content: 'ok', usage_metadata: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } })
  })

  it('returns the actual reply and saves usage for the requesting user', async () => {
    const result = await service.userChatCompletion(request as never)
    expect(result.content).toBe('ok')
    expect(result.usage.total_tokens).toBe(5)
    expect(logs.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', model: 'test-chat', status: AiLogStatus.Success }))
    expect(openai.createChatCompletion).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown model before contacting a provider', async () => {
    await expect(service.userChatCompletion({ ...request, model: 'missing' } as never)).rejects.toMatchObject({ code: ResponseCode.InvalidModel })
    expect(openai.createChatCompletion).not.toHaveBeenCalled()
    expect(logs.create).not.toHaveBeenCalled()
  })

  it('does not record success if usage is missing or the provider fails', async () => {
    openai.createChatCompletion.mockResolvedValueOnce({ content: 'incomplete' })
    await expect(service.userChatCompletion(request as never)).rejects.toMatchObject({ code: ResponseCode.AiCallFailed })
    openai.createChatCompletion.mockRejectedValueOnce(new AppException(ResponseCode.AiCallFailed))
    await expect(service.userChatCompletion(request as never)).rejects.toBeInstanceOf(AppException)
    expect(logs.create).not.toHaveBeenCalled()
  })

  it('stores returned base64 images and replaces them with a usable asset URL', async () => {
    openai.createChatCompletion.mockResolvedValueOnce({ content: 'image data:image/png;base64,aGVsbG8=', usage_metadata: { total_tokens: 1 } })
    assets.uploadFromBuffer.mockResolvedValueOnce({ asset: { path: 'image.png' } })
    assets.buildUrl.mockReturnValueOnce('https://assets.example.test/image.png')
    const result = await service.userChatCompletion(request as never)
    expect(result.content).toBe('image https://assets.example.test/image.png')
    expect(assets.uploadFromBuffer).toHaveBeenCalledWith('user-a', Buffer.from('hello'), expect.objectContaining({ mimeType: 'image/png' }), 'test-chat')
  })

  it('filters the offered models by channel and scene', async () => {
    expect(await service.getChatModelConfig({ scene: 'agent' } as never)).toHaveLength(1)
    expect(await service.getChatModelConfig({ scene: 'not-supported' } as never)).toEqual([])
  })
})
