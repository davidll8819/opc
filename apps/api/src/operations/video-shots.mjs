import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { assertRuntimeAccess } from './task-access.mjs'
import { loadPolicy } from './gateway.mjs'
import { resolveCapability } from './policy.mjs'
import { fail } from '../db.mjs'

export const shotInput = z.object({
  requestId: z.uuid(), prompt: z.string().trim().min(1).max(2000),
  duration: z.number().int().min(5).max(15),
  ratio: z.enum(['9:16', '16:9', '1:1']), resolution: z.enum(['720p', '1080p']),
  costAcknowledged: z.literal(true),
}).strict()
export function checkedShotResult(result) {
  const raw = result.specification
  const specification = raw ? { matches: raw.matches === true,
    requested: { ratio: String(raw.requested?.ratio || ''), resolution: String(raw.requested?.resolution || '') },
    actual: { width: Number(raw.actual?.width) || 0, height: Number(raw.actual?.height) || 0 } } : undefined
  const mismatch = result.status === 'SUCCESS' && specification && !specification.matches
  return { state: result.status === 'SUCCESS' ? (mismatch ? 'failed' : 'completed') : result.status === 'FAILURE' ? 'failed' : 'submitted',
    result: { status: result.status, videoUrl: result.videoUrl, specification,
      ...(mismatch ? { error: '服务商返回的视频尺寸与要求不一致，素材已保留；未自动裁剪或重新付费生成' } : {}) } }
}
const publicShot = row => ({ id: row.id, state: row.state, input: row.input,
  model: row.model, result: row.result, createdAt: row.created_at })

export function registerVideoShots(app, { scoped, driver, env }) {
  const root = '/api/tenants/:tenantId/operations/tasks/:taskId/shots'
  const taskId = req => z.string().regex(/^[a-f0-9]{24}$/).parse(req.params.taskId)
  app.post(root, async req => {
    const input = shotInput.parse(req.body), task = taskId(req)
    const reservation = await scoped(req, async (db, tenant, ctx) => {
      await assertRuntimeAccess(db, ctx, task)
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`video-shot:${ctx.tenantId}:${ctx.userId}`])
      const existing = (await db.query('SELECT * FROM operations_video_shots WHERE tenant_id=$1 AND user_id=$2 AND id=$3', [ctx.tenantId, ctx.userId, input.requestId])).rows[0]
      if (existing) {
        if (existing.task_id !== task || !isDeepStrictEqual(existing.input, input)) throw fail(409, '该请求编号已有其他内容')
        return { ctx, row: existing, fresh: false }
      }
      const active = (await db.query("SELECT 1 FROM operations_video_shots WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND state IN ('submitting','submitted','uncertain') LIMIT 1", [ctx.tenantId, ctx.userId, task])).rows[0]
      if (active) throw fail(409, '上一镜头仍在生成或结果待核对，请勿重复付费提交')
      const { policy } = await loadPolicy(db, ctx.tenantId, env)
      const { model } = resolveCapability(policy, 'content_ops', 'video')
      const row = (await db.query("INSERT INTO operations_video_shots(id,tenant_id,user_id,task_id,input,model,state) VALUES($1,$2,$3,$4,$5,$6,'submitting') RETURNING *", [input.requestId, ctx.tenantId, ctx.userId, task, input, model])).rows[0]
      return { ctx, row, fresh: true }
    }, ['owner', 'admin'])
    if (!reservation.fresh) return { shot: publicShot(reservation.row) }
    let remote, state = 'uncertain'
    try {
      const entry = await driver.ready(reservation.ctx.tenantId,undefined,reservation.ctx.userId)
      remote = await driver.request(entry, 'ai', '/ai/video/generations', { method: 'POST', body: {
        model: reservation.row.model, prompt: input.prompt, duration: input.duration,
        ratio: input.ratio, resolution: input.resolution,
        metadata: { officeTaskId: task, officeShotRequestId: input.requestId },
      } })
      if (typeof remote?.id === 'string' && /^[a-f0-9]{24}$/.test(remote.id)) state = 'submitted'
    } catch { /* Never automatically repeat a possibly charged generation. */ }
    const row = await scoped(req, async (db, tenant, ctx) => (await db.query(
      'UPDATE operations_video_shots SET state=$4,remote_id=$5 WHERE tenant_id=$1 AND user_id=$2 AND id=$3 RETURNING *',
      [ctx.tenantId, ctx.userId, input.requestId, state, state === 'submitted' ? remote.id : null])).rows[0])
    return { shot: publicShot(row) }
  })
  app.get(root, async req => {
    const { ctx, rows } = await scoped(req, async (db, tenant, ctx) => {
      await assertRuntimeAccess(db, ctx, taskId(req))
      return { ctx, rows: (await db.query('SELECT * FROM operations_video_shots WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 ORDER BY created_at DESC LIMIT 30', [ctx.tenantId, ctx.userId, taskId(req)])).rows }
    })
    for (const row of rows.filter(r => r.state === 'submitted' && r.remote_id)) {
      try {
        const entry = await driver.binding(ctx.tenantId,ctx.userId)
        const result = await driver.request(entry, 'ai', `/ai/video/generations/${row.remote_id}`)
        const { state, result: safe } = checkedShotResult(result)
        await scoped(req, db => db.query('UPDATE operations_video_shots SET state=$4,result=$5 WHERE tenant_id=$1 AND user_id=$2 AND id=$3', [ctx.tenantId, ctx.userId, row.id, state, safe]))
        row.state = state; row.result = safe
      } catch { row.statusUnavailable = true }
    }
    return { items: rows.map(row => ({ ...publicShot(row), statusUnavailable: row.statusUnavailable })) }
  })
}
