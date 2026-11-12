import { z } from 'zod'
import { taskDependencyState } from './task-dependencies.mjs'
import { needsDesignImage } from './design-images.mjs'

export const taskSettingsSchema = z.object({
  maxOutputTokens: z.union([z.literal(4096), z.literal(8192), z.literal(16384)]),
  deliveryNote: z.string().trim().max(2000),
}).strict()

export function textTaskSettings(task) {
  const parsed = taskSettingsSchema.safeParse(task.executionSettings)
  return parsed.success ? parsed.data : { maxOutputTokens: 4096, deliveryNote: '' }
}

export function canAdjustTextTask(task) {
  return task.engine === 'department-v1' && task.dept !== 'app-agent' &&
    !task.runtimeTaskId && !task.runtimePending && !task.publishRequired &&
    task.outputKind !== 'image' && !needsDesignImage(task)
}

export function taskProblem(board, task) {
  const dependencies = taskDependencyState(board, task)
  const links = dependencies.dependencies.filter(Boolean).filter(t => t.status !== 'completed')
    .map(t => ({ id: t.id, title: t.title, status: t.status }))
  const note = task.executionNote || ''
  const external = !!task.runtimeTaskId || !!task.runtimePending || task.dept === 'app-agent' || !!task.publishRequired
  let code = 'other', title = '任务需要处理', description = '请查看失败记录，确认原因后恢复当前步骤。', destination = null
  if (!dependencies.ready) {
    code = 'dependency'; title = '前置任务尚未完成'; description = dependencies.note
  } else if (task.problem?.code === 'output_limit' || /输出额度已耗尽|单次回复长度上限/.test(note)) {
    code = 'output_limit'; title = '回复超过单次长度上限'
    description = '这是单次回复被截断，不代表账户余额不足。可以调整本任务输出长度，或补充更精简的交付要求。'
  } else if (/未知|待核对|中断|timeout|unknown/i.test(note) || task.runtimePending) {
    code = 'uncertain'; title = '上次请求结果待核对'
    description = '先核对现有成果和费用。重试可能再次计费，原预占额度不会自动清除。'
    destination = external ? 'operations' : 'usage'
  } else if (/预算|额度|余额|价格|计费/.test(note)) {
    code = 'budget'; title = '预算或计费条件需要处理'
    description = '先核对错误详情与费用。任务金额预算和企业总额度不同，调整任务预算不能绕过企业限制。'; destination = 'usage'
  } else if (/附件|素材|文件|容量|空间/.test(note)) {
    code = 'material'; title = '任务资料需要处理'
    description = '到资料室核对附件、素材和剩余空间；已删除或无权限的资料需要重新安排。'; destination = 'archive'
  } else if (/个人.*Key|API\s*Key/i.test(note)) {
    code = 'connection'; title = '个人 Key 需要检查'
    description = '打开设置中的「我的 4yi Key」，保存你自己的 Key 并验证连接；其他用户的 Key 不受影响。'; destination = 'settings'
  } else if (external || /运营|视频服务|制作服务/.test(note)) {
    code = 'service'; title = '制作服务需要检查'
    description = '打开原运营任务核对服务、进度和已生成的素材，不要另建重复任务。'; destination = 'operations'
  } else if (/模型|密钥|连接|服务|网络/.test(note)) {
    code = 'connection'; title = '模型连接需要检查'
    description = '到设置中核对对应员工的连接或自检记录。修改企业设置会影响其他任务，自检可能产生费用。'; destination = 'settings'
  }
  return { code, title, description, destination, hasExternalRun: !!task.runtimeTaskId, dependencies: links,
    adjustable: task.status === 'blocked' && dependencies.ready && canAdjustTextTask(task),
    settings: textTaskSettings(task), note,
    partialResult: task.partialResult || null }
}
