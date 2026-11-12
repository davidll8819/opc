import { officeUserContext, officeModelToken } from '@yikart/common'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { AppConfigRepository } from '@yikart/mongodb'
import { config } from '../../../config'
import { applyFourYiModels, loadFourYiModels } from '../libs/fouryi/fouryi-models.util'
import { ModelsConfigDto } from './models-config.dto'

@Injectable()
export class ModelsConfigService implements OnModuleInit {
  private readonly logger = new Logger(ModelsConfigService.name)
  private modelsConfig = config.ai.models
  private personalModels = new Map<string, { models: typeof config.ai.models, at: number }>()

  constructor(
    private readonly appConfigRepo: AppConfigRepository,
  ) {}

  async onModuleInit() {
    if (config.ai.fouryi.apiKey) {
      applyFourYiModels(config, [])
      try {
        const models = await loadFourYiModels(config.ai.fouryi)
        applyFourYiModels(config, models)
        this.logger.log(`Loaded ${models.length} company 4YI models`)
      }
      catch {
        this.logger.error('4YI model discovery failed. Check the company API key and URL, then restart. Legacy models remain disabled.')
      }
    }
  }

  async saveConfig(_: ModelsConfigDto) {
  }

  async forUser(userId = officeUserContext.getStore()) {
    if (!config.officeBridge) return this.modelsConfig
    if (!userId) throw new Error('Personal model identity is required')
    const current = this.personalModels.get(userId)
    if (current && Date.now() - current.at < 30000) return current.models
    const models = await loadFourYiModels({ ...config.ai.fouryi, apiKey: officeModelToken(config.officeBridge, userId) })
    const snapshot = structuredClone(config)
    applyFourYiModels(snapshot, models)
    if (this.personalModels.size >= 200) this.personalModels.delete(this.personalModels.keys().next().value!)
    this.personalModels.set(userId, { models: snapshot.ai.models, at: Date.now() })
    return snapshot.ai.models
  }

  get config() {
    const userId = officeUserContext.getStore()
    return (userId && this.personalModels.get(userId)?.models) || this.modelsConfig
  }
}
