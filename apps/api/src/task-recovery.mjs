import { z } from 'zod'
import { fail } from './db.mjs'
import { taskDependencyState } from './task-dependencies.mjs'
import { needsDesignImage } from './design-images.mjs'
import { taskProblem, taskSettingsSchema, canAdjustTextTask, textTaskSettings } from './task-problems.mjs'

export function recoveryState(board, task) {
  const uncertain = /未知|待核对|中断|timeout|unknown/i.test(task.executionNote || '')
  const media = needsDesignImage(task) || !!task.media?.length || !!task.images?.length
  const external = !!task.runtimeTaskId || !!task.runtimePending || task.dept === 'app-agent' || !!task.publishRequired
  const dependencies = taskDependencyState(board, task)
  return { available: task.status === 'blocked' && ['research-v1', 'department-v1'].includes(task.engine) && !external,
    needsConfirmation: true, uncertain, media,
    reason: external ? '存在发布或外部运行记录，请到运营工作台核对，不能重复提交' : !dependencies.ready ? dependencies.note : uncertain ? '上次结果未知，重试可能再次计费；原有预占额度保留' : media ? '恢复可能产生媒体生成费用，请先确认' : '可以保留原任务和记录，重新排队执行', dependenciesReady: dependencies.ready }
}
export async function recoverTask(db, ctx, { taskId, revision, acknowledgeRisk, settings, saveOnly = false }) {
  const row = (await db.query('SELECT revision,board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [ctx.tenantId, ctx.userId])).rows[0]
  if (!row || row.revision !== revision) throw fail(409, '任务已更新，请刷新后重试')
  const task = row.board.tasks.find(t => t.id === taskId)
  if (!task) throw fail(404, '任务不存在')
  const state = recoveryState(row.board, task)
  if (!state.available || !state.dependenciesReady) throw fail(409, state.reason)
  if (!saveOnly && state.needsConfirmation && !acknowledgeRisk) throw fail(409, '请先确认重新执行可能再次计费，再恢复任务')
  const job = (await db.query('SELECT state FROM task_jobs WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 FOR UPDATE', [ctx.tenantId, ctx.userId, task.id])).rows[0]
  if (job && job.state !== 'blocked') throw fail(409, '任务已排队或正在执行，请勿重复恢复')
  const at = new Date().toISOString()
  if (settings !== undefined) {
    if (!canAdjustTextTask(task)) throw fail(409, '该任务不支持文字输出设置，请使用对应处理入口')
    const next = taskSettingsSchema.parse(settings)
    task.settingsHistory = [...(task.settingsHistory || []), { at, previous: textTaskSettings(task), next }].slice(-30)
    task.executionSettings = next
  }
  if (saveOnly) {
    if (settings === undefined) throw fail(400, '没有需要保存的任务设置')
    await db.query('UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2', [ctx.tenantId, ctx.userId, JSON.stringify(row.board)])
    return { board: row.board, revision: row.revision + 1 }
  }
  task.recoveryHistory = [...(task.recoveryHistory || []), { at, previousNote: task.executionNote || '', acknowledgedRisk: !!acknowledgeRisk }].slice(-30)
  task.steps = [...(task.steps || []), { time: at, note: '已手动恢复任务', detail: '保留已有成果和失败记录，等待重新执行；没有自动发布' }].slice(-30)
  task.status = 'queued'
  task.executionNote = '已恢复，等待后台执行器接收'
  delete task.finishedAt
  await db.query("INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'queued') ON CONFLICT(tenant_id,user_id,task_id) DO UPDATE SET state='queued',claim_id=NULL,lease_until=NULL,updated_at=now()", [ctx.tenantId, ctx.userId, task.id])
  await db.query('UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2', [ctx.tenantId, ctx.userId, JSON.stringify(row.board)])
  return { board: row.board, revision: row.revision + 1 }
}
export function registerTaskRecovery(app, { scoped }) {
  const path = '/api/tenants/:tenantId/tasks/:taskId/recovery'
  app.get(path, req => scoped(req, async (db, tenant, ctx) => {
    const row = (await db.query('SELECT revision,board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [ctx.tenantId, ctx.userId])).rows[0]
    const task = row?.board.tasks.find(t => t.id === req.params.taskId)
    if (!task) throw fail(404, '任务不存在')
    return { ...recoveryState(row.board, task), problem: taskProblem(row.board, task), revision: row.revision }
  }, ['owner', 'admin']))
  app.post(path, req => {
    const input = z.object({ revision: z.number().int().nonnegative(), acknowledgeRisk: z.boolean().default(false), settings: taskSettingsSchema.optional() }).strict().parse(req.body)
    return scoped(req, (db, tenant, ctx) => recoverTask(db, ctx, { ...input, taskId: req.params.taskId }), ['owner', 'admin'])
  })
  app.patch(path, req => {
    const input = z.object({ revision: z.number().int().nonnegative(), settings: taskSettingsSchema }).strict().parse(req.body)
    return scoped(req, (db, tenant, ctx) => recoverTask(db, ctx, { ...input, taskId: req.params.taskId, saveOnly: true }), ['owner', 'admin'])
  })
}
