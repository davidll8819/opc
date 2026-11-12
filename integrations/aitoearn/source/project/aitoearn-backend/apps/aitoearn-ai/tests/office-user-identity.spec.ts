import { UserRepository, UserStatus } from '@yikart/mongodb'
import { describe, expect, it, vi } from 'vitest'

describe('Office personal runtime identity', () => {
  it('atomically creates only the matching tenant identity without overwriting existing fields', async () => {
    const exec = vi.fn().mockResolvedValue({ status: UserStatus.OPEN })
    const findOneAndUpdate = vi.fn().mockReturnValue({ exec })
    const repository = new UserRepository({ findOneAndUpdate } as any)
    await repository.createOfficeIdentity('a'.repeat(24), 'tenant-a')
    const [filter, update, options] = findOneAndUpdate.mock.calls[0]
    expect(filter).toEqual({ _id: 'a'.repeat(24), officeTenantId: 'tenant-a' })
    // A disabled/deleted user must not be reactivated by a later request.
    expect(Object.keys(update)).toEqual(['$setOnInsert'])
    expect(update.$setOnInsert).toMatchObject({ status: UserStatus.OPEN, isDelete: false, usedStorage: 0 })
    expect(options).toMatchObject({ upsert: true, timestamps: false })
    expect(exec).toHaveBeenCalledOnce()
  })

  it('rejects malformed or unscoped identities before database access', async () => {
    const findOneAndUpdate = vi.fn()
    const repository = new UserRepository({ findOneAndUpdate } as any)
    await expect(repository.createOfficeIdentity('../shared', 'tenant-a')).rejects.toThrow('Invalid Office identity')
    await expect(repository.createOfficeIdentity('a'.repeat(24), '')).rejects.toThrow('Invalid Office identity')
    expect(findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('does not fall back to another tenant after an identity collision', async () => {
    const exec = vi.fn().mockRejectedValue(Object.assign(new Error('duplicate identity'), { code: 11000 }))
    const findOneAndUpdate = vi.fn().mockReturnValue({ exec })
    const repository = new UserRepository({ findOneAndUpdate } as any)
    await expect(repository.createOfficeIdentity('a'.repeat(24), 'tenant-b')).rejects.toMatchObject({ code: 11000 })
    expect(findOneAndUpdate).toHaveBeenCalledOnce()
  })
})
