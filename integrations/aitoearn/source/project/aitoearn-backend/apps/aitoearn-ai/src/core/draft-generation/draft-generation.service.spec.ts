import { AppException, ResponseCode, UserType } from '@yikart/common'
import { AiLogChannel, AiLogStatus } from '@yikart/mongodb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftGenerationError, DraftGenerationService } from './draft-generation.service'

describe('video draft lifecycle', () => {
  const groups = { getInfo: vi.fn(), getDefaultGroup: vi.fn() }
  const materials = { create: vi.fn() }
  const logs = { create: vi.fn(), getById: vi.fn(), getByIdAndUserId: vi.fn(), updateById: vi.fn() }
  const queue = { addDraftGenerationJob: vi.fn(), addLowPriorityDraftGenerationJob: vi.fn(), getDraftGenerationQueueInfo: vi.fn() }
  const video = { getVideoGenerationModelParams: vi.fn(), userVideoGeneration: vi.fn(), getVideoTaskStatus: vi.fn() }
  const assets = { uploadFromBuffer: vi.fn() }
  const metadata = { extractThumbnailFromUrl: vi.fn() }
  const media = { create: vi.fn() }
  let service: DraftGenerationService
  const dto = { model: 'test-video', draftType: 'video', prompt: 'test scene', quantity: 1, duration: 5, aspectRatio: '16:9' }

  beforeEach(() => {
    vi.resetAllMocks()
    groups.getDefaultGroup.mockResolvedValue({ id: 'group-a', userId: 'user-a' })
    logs.create.mockResolvedValue({ id: 'task-a' })
    logs.getById.mockResolvedValue({ response: {} })
    video.getVideoGenerationModelParams.mockResolvedValue([{ name: 'test-video', modes: ['text2video'], channel: AiLogChannel.OpenAI, defaults: { resolution: '720p' } }])
    media.create.mockResolvedValue({ id: 'media-a' })
    service = new DraftGenerationService(groups as never, materials as never, logs as never, queue as never, video as never, assets as never, metadata as never, {} as never, {} as never, media as never, {} as never, {} as never)
  })

  it('creates a queued task with the selected format and requesting user', async () => {
    expect(await service.createDraftsV2('user-a', UserType.User, dto as never)).toEqual(['task-a'])
    expect(logs.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a', status: AiLogStatus.Generating, request: expect.objectContaining({ duration: 5, aspectRatio: '16:9', resolution: '720p' }) }))
    expect(queue.addDraftGenerationJob).toHaveBeenCalledWith(expect.objectContaining({ aiLogId: 'task-a', userId: 'user-a', groupId: 'group-a', model: 'test-video', resolution: '720p' }), undefined)
    expect(video.userVideoGeneration).not.toHaveBeenCalled()
  })

  it('rejects another user’s folder and an unknown model without enqueueing', async () => {
    groups.getInfo.mockResolvedValue({ id: 'other-group', userId: 'user-b' })
    await expect(service.createDraftsV2('user-a', UserType.User, { ...dto, groupId: 'other-group' } as never)).rejects.toMatchObject({ code: ResponseCode.MaterialGroupNotFound })
    video.getVideoGenerationModelParams.mockResolvedValue([])
    await expect(service.createDraftsV2('user-a', UserType.User, dto as never)).rejects.toMatchObject({ code: ResponseCode.InvalidModel })
    expect(logs.create).not.toHaveBeenCalled()
    expect(queue.addDraftGenerationJob).not.toHaveBeenCalled()
  })

  it('does not reveal a task belonging to another user', async () => {
    logs.getByIdAndUserId.mockResolvedValue(null)
    await expect(service.getTask('task-a', 'user-b', UserType.User)).rejects.toMatchObject({ code: ResponseCode.AiLogNotFound })
    expect(logs.getByIdAndUserId).toHaveBeenCalledWith('task-a', 'user-b', UserType.User)
    expect(queue.getDraftGenerationQueueInfo).not.toHaveBeenCalled()
  })

  it('shows queue progress only while the task is generating', async () => {
    logs.getByIdAndUserId.mockResolvedValue({ id: 'task-a', status: AiLogStatus.Generating })
    queue.getDraftGenerationQueueInfo.mockResolvedValue({ state: 'waiting', position: 2 })
    expect(await service.getTask('task-a', 'user-a', UserType.User)).toMatchObject({ queue: { position: 2 } })
    queue.getDraftGenerationQueueInfo.mockClear()
    logs.getByIdAndUserId.mockResolvedValue({ id: 'task-a', status: AiLogStatus.Success })
    expect(await service.getTask('task-a', 'user-a', UserType.User)).not.toHaveProperty('queue')
    expect(queue.getDraftGenerationQueueInfo).not.toHaveBeenCalled()
  })

  it('reuses the saved video and cover on retry without paying for generation again', async () => {
    logs.getById.mockResolvedValue({ response: { videoUrl: 'saved.mp4', coverUrl: 'saved.png', mediaId: 'existing-media' } })
    await service.generateContentV2('task-a', 'user-a', UserType.User, 'group-a', dto as never)
    expect(video.userVideoGeneration).not.toHaveBeenCalled()
    expect(metadata.extractThumbnailFromUrl).not.toHaveBeenCalled()
    expect(media.create).not.toHaveBeenCalled()
    expect(logs.updateById).toHaveBeenCalledWith('task-a', { $set: expect.objectContaining({ status: AiLogStatus.Success, response: { mediaId: 'existing-media', videoUrl: 'saved.mp4', coverUrl: 'saved.png' } }) })
  })

  it('marks a rejected video submission as failed and preserves the cause for retry handling', async () => {
    const failure = new AppException(ResponseCode.AiCallFailed)
    video.userVideoGeneration.mockRejectedValue(failure)
    const result = service.generateContentV2('task-a', 'user-a', UserType.User, 'group-a', dto as never)
    await expect(result).rejects.toBeInstanceOf(DraftGenerationError)
    await expect(result).rejects.toMatchObject({ cause: failure })
    expect(logs.updateById).toHaveBeenCalledWith('task-a', { $set: expect.objectContaining({ status: AiLogStatus.Failed }) })
    expect(media.create).not.toHaveBeenCalled()
  })
})
