import { MediaGroupRepository } from '@yikart/mongodb'
import { describe, expect, it, vi } from 'vitest'

describe('personal media groups on first use', () => {
  it('uses stable per-user and per-type IDs with insert-only defaults', async () => {
    const findOne = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) })
    const findOneAndUpdate = vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue({ id: 'created' }) })
    const repository = new MediaGroupRepository({ findOne, findOneAndUpdate } as any)
    expect(await repository.createDefault('user-a')).toBe(true)
    expect(await repository.createDefault('user-a')).toBe(true)
    expect(await repository.createDefault('user-b')).toBe(true)
    const calls = findOneAndUpdate.mock.calls
    expect(calls[0][0]).toEqual(calls[2][0])
    expect(calls[1][0]).toEqual(calls[3][0])
    expect(new Set([calls[0], calls[1], calls[4], calls[5]].map(c => c[0]._id)).size).toBe(4)
    for (const [filter, update, options] of calls) {
      expect(filter._id).toMatch(/^[a-f0-9]{24}$/)
      expect(Object.keys(update)).toEqual(['$setOnInsert'])
      expect(options).toMatchObject({ upsert: true, timestamps: false })
    }
  })

  it('keeps existing renamed groups and their contents untouched', async () => {
    const findOne = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ id: 'old', title: 'My projects' }) })
    const findOneAndUpdate = vi.fn()
    expect(await new MediaGroupRepository({ findOne, findOneAndUpdate } as any).createDefault('user-a')).toBe(true)
    expect(findOneAndUpdate).not.toHaveBeenCalled()
  })
})
