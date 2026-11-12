import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { UserType, UserStatus } from '../enums'
import { User, UserAiInfo } from '../schemas'
import { BaseRepository, LeanDoc } from './base.repository'

export class UserRepository extends BaseRepository<User> {
  constructor(
    @InjectModel(User.name)
    userModel: Model<User>,
  ) {
    super(userModel)
  }

  override async getById(id: string): Promise<LeanDoc<User> | null> {
    let userInfo
    try {
      userInfo = await this.model.findById(id).lean({ virtuals: true }).exec()
    }
    catch {
      return null
    }
    return userInfo as LeanDoc<User> | null
  }

  /** Creates only the verified Office service identity; never changes an existing account. */
  async createOfficeIdentity(id: string, tenantId: string): Promise<void> {
    if (!/^[a-f0-9]{24}$/.test(id) || !tenantId)
      throw new Error('Invalid Office identity')
    await this.model.findOneAndUpdate(
      { _id: id, officeTenantId: tenantId },
      { $setOnInsert: { createdAt: new Date(), updatedAt: new Date(), name: 'Office personal user', status: UserStatus.OPEN, userType: UserType.CREATOR, isDelete: false, usedStorage: 0, storage: { total: 536870912 }, locale: 'zh-CN' } },
      { upsert: true, new: true, setDefaultsOnInsert: true, timestamps: false },
    ).exec()
  }

  async updateAiConfigById(userId: string, aiConfig: Partial<UserAiInfo>): Promise<boolean> {
    const res = await this.model.updateOne(
      { _id: userId },
      { $set: { aiInfo: aiConfig } },
    )
    return res.modifiedCount > 0
  }

  async updateAiConfigItemById(userId: string, type: 'image' | 'edit' | 'video' | 'agent', value: {
    defaultModel: string
    option?: Record<string, any>
  }): Promise<boolean> {
    const res = await this.model.updateOne(
      { _id: userId },
      { $set: { [`aiInfo.${type}`]: { defaultModel: value.defaultModel, option: value.option } } },
    )
    return res.modifiedCount > 0
  }

  async updateUserTypeById(userId: string, userType: UserType): Promise<boolean> {
    const res = await this.model.updateOne(
      { _id: userId },
      { $set: { userType } },
    )
    return res.modifiedCount > 0
  }
}
