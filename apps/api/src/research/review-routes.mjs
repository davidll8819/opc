import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fail } from '../db.mjs'

export function registerResearchReview(app, { scoped }) {
  const root = '/api/tenants/:tenantId/research/tasks/:taskId'
  const withTask = (req, fn) => scoped(req, async (db, _tenant, ctx) => {
    const row = (await db.query('SELECT revision,board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE', [ctx.tenantId, ctx.userId])).rows[0]
    const task = row?.board.tasks.find(t => t.id === req.params.taskId)
    if (!task || task.engine !== 'research-v1') throw fail(404, '调研任务不存在或无权访问')
    const result = await fn(db, ctx, row, task)
    await db.query('UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2', [ctx.tenantId, ctx.userId, JSON.stringify(row.board)])
    return { ...result, board: row.board }
  }, ['owner', 'admin'])
  app.post(`${root}/accept`, req => {
    const input = z.object({ acknowledgeGaps: z.boolean().default(false) }).strict().parse(req.body)
    return withTask(req, async (_db, _ctx, _row, task) => {
      if (task.status !== 'completed' || !task.quality) throw fail(409, '此成果尚无证据核查记录，请先补充调研')
      if (task.dept === 'file-agent') throw fail(409, '请在前置调研任务中验收')
      if (task.quality.status === 'partial' && !input.acknowledgeGaps) throw fail(409, '请先确认已了解证据缺口')
      task.quality.acceptance ||= { at: new Date().toISOString(), decision: 'accepted', note: task.quality.status === 'partial' ? '用户已了解缺口，接受当前范围；不代表缺口已消除' : '用户确认接受当前成果' }
      return { accepted: true }
    })
  })
  app.post(`${root}/follow-up`, req => {
    const input = z.object({ requestId: z.uuid(), feedback: z.string().trim().min(1).max(1000), acknowledgeCost: z.literal(true) }).strict().parse(req.body)
    return withTask(req, async (db, ctx, row, task) => {
      if (task.status !== 'completed' || !['review-agent', 'new-agent-8'].includes(task.dept)) throw fail(409, '请从已结束的调研任务发起补查')
      const duplicate = row.board.tasks.find(t => t.followUpRequestId === input.requestId)
      if (duplicate) {
        if (duplicate.followUpOf !== task.id || duplicate.followUpFeedback !== input.feedback) throw fail(409, '提交编号已用于其他补查，请刷新后核对')
        return { taskId: duplicate.id }
      }
      const active = row.board.tasks.find(t => t.followUpOf === task.id && ['queued', 'working', 'blocked'].includes(t.status))
      if (active) throw fail(409, '已有补查任务，请先查看其结果或恢复原补查')
      if (row.board.tasks.filter(t => ['queued', 'working'].includes(t.status)).length >= 40) throw fail(409, '请先处理已有任务')
      const originalRequest = task.originalResearchRequest || task.request || task.title
      if (originalRequest.length > 20000) throw fail(409, '原任务要求过长，请在秘书处整理后重新派发')
      const next = { id: randomUUID(), title: `${task.title.replace(/^补充调研：/, '').slice(0, 110)}（补查）`, dept: task.dept,
        due: new Date().toISOString().slice(0, 10), status: 'queued', engine: 'research-v1', publishRequired: false,
        request: `${originalRequest}\n本轮重点补查：${input.feedback}\n原报告可能不完整或有误，重新核对公开来源，不把原报告当作已证实事实。`,
        originalResearchRequest: originalRequest, summary: '', dependsOn: [], attachmentIds: task.attachmentIds || [],
        ...(task.briefSnapshot ? { briefSnapshot: structuredClone(task.briefSnapshot) } : {}),
        followUpOf: task.id, followUpRequestId: input.requestId, followUpFeedback: input.feedback,
        executionNote: '补充调研已排队；另存新报告，原报告保留', steps: [] }
      row.board.tasks.push(next)
      await db.query("INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'queued')", [ctx.tenantId, ctx.userId, next.id])
      return { taskId: next.id }
    })
  })
}
