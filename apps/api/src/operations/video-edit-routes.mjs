import { registerNarration } from './video-narration.mjs'
import { checkVideoEdit } from './video-edit-check.mjs'
import { readVideoDraft, saveVideoDraft } from './video-draft.mjs'
import { z } from 'zod'
import { archiveBytes, archiveVideoEdit } from './video-edit-archive.mjs'
import { fail } from '../db.mjs'
import { assertRuntimeAccess } from './task-access.mjs'
import {
  createVideoEditor,
  editPublic,
  readEdit,
  saveEdit,
  prepareEdit,
  openEditedVideo,
} from './video-edit-service.mjs'

export function registerVideoEdits(
  app,
  { scoped, pool, driver, env, editor = createVideoEditor({ pool, driver, env }) },
) {
  registerNarration(app, { scoped, driver })
  const root = '/api/tenants/:tenantId/operations',
    admin = ['owner', 'admin']
  const taskId = (req) =>
    z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse(req.params.taskId)
  const editId = (req) => z.string().uuid().parse(req.params.id)
  app.post(`${root}/video-edits/:id/final`, req => scoped(req, async (db, tenant, ctx) => {
    const row = await readEdit(db, ctx, editId(req))
    if (row.state !== 'completed') throw fail(409, '只能将已完成成片标记为定稿')
    await assertRuntimeAccess(db, ctx, row.task_id)
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`video-final:${ctx.tenantId}:${ctx.userId}:${row.task_id}`])
    await db.query('UPDATE operations_video_edits SET is_final=false WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND is_final', [ctx.tenantId, ctx.userId, row.task_id])
    await db.query('UPDATE operations_video_edits SET is_final=true WHERE tenant_id=$1 AND user_id=$2 AND id=$3', [ctx.tenantId, ctx.userId, row.id])
    return { ok: true }
  }, admin))
  app.addHook('onClose', () => editor.close())
  app.get(`${root}/tasks/:taskId/edit-draft`, async (req) =>
    scoped(req, (db, tenant, ctx) => readVideoDraft(db, ctx, taskId(req))),
  )
  app.put(`${root}/tasks/:taskId/edit-draft`, { bodyLimit: 24 * 1024 * 1024 }, async (req) =>
    scoped(req, (db, tenant, ctx) => saveVideoDraft(db, ctx, taskId(req), req.body), admin),
  )

  app.get(`${root}/tasks/:taskId/edits`, async (req) => {
    const { ctx, rows } = await scoped(req, async (db, tenant, ctx) => {
      await assertRuntimeAccess(db, ctx, taskId(req))
      const { rows } = await db.query(
        'SELECT id,task_id,spec,state,phase,error,result,created_at,is_final FROM operations_video_edits WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 ORDER BY created_at DESC LIMIT 30',
        [ctx.tenantId, ctx.userId, taskId(req)],
      )
      return { ctx, rows }
    })
    for (const row of rows) if (['queued', 'running'].includes(row.state)) editor.kick(ctx, row.id)
    return { items: rows.map(editPublic) }
  })
  app.post(`${root}/tasks/:taskId/edits/check`, { bodyLimit: 24 * 1024 * 1024 }, async (req) => {
    const { ctx, prepared } = await scoped(
      req,
      async (db, tenant, ctx) => ({
        ctx,
        prepared: await prepareEdit(db, ctx, taskId(req), req.body),
      }),
      admin,
    )
    const entry = await driver.binding(ctx.tenantId,ctx.userId)
    if (!entry) throw fail(503, '企业素材服务暂时不可用')
    const task = await driver.request(entry, 'ai', `/agent/tasks/${taskId(req)}`)
    return checkVideoEdit({ entry, task, ...prepared, env })
  })
  app.post(`${root}/tasks/:taskId/edits`, { bodyLimit: 24 * 1024 * 1024 }, async (req) => {
    const { ctx, row } = await scoped(
      req,
      async (db, tenant, ctx) => ({ ctx, row: await saveEdit(db, ctx, taskId(req), req.body) }),
      admin,
    )
    if (['queued', 'running'].includes(row.state)) editor.kick(ctx, row.id)
    return { edit: editPublic(row) }
  })
  app.get(`${root}/video-edits/:id`, async (req) => {
    const { ctx, row } = await scoped(req, async (db, tenant, ctx) => ({
      ctx,
      row: await readEdit(db, ctx, editId(req)),
    }))
    if (['queued', 'running'].includes(row.state)) editor.kick(ctx, row.id)
    return { edit: editPublic(row) }
  })
  for (const track of ['music', 'narration']) app.get(`${root}/video-edits/:id/${track}`, async (req, reply) => {
    const row = await scoped(req, (db, tenant, ctx) => readEdit(db, ctx, editId(req)))
    if (!row[track]) throw fail(404, '这份剪辑没有保存配乐')
    const bytes = Buffer.from(row[track])
    const extension = (row.spec[`${track}Name`] || '').split('.').at(-1).toLowerCase()
    const mime =
      { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' }[extension] ||
      'application/octet-stream'
    reply
      .header('content-type', mime)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('accept-ranges', 'bytes')
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
      const start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]))
      const end =
        match?.[1] && match?.[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= bytes.length
      ) {
        return reply.code(416).header('content-range', `bytes */${bytes.length}`).send()
      }
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${bytes.length}`)
        .header('content-length', end - start + 1)
        .send(bytes.subarray(start, end + 1))
    }
    return reply.header('content-length', bytes.length).send(bytes)
  })
  app.post(`${root}/video-edits/:id/retry`, async (req) => {
    const { ctx, row } = await scoped(
      req,
      async (db, tenant, ctx) => {
        const id = editId(req)
        let row = await readEdit(db, ctx, id)
        await assertRuntimeAccess(db, ctx, row.task_id)
        if (row.state === 'failed')
          row =
            (
              await db.query(
                "UPDATE operations_video_edits SET state='queued',phase='等待重新处理',error=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND state='failed' RETURNING *",
                [ctx.tenantId, ctx.userId, id],
              )
            ).rows[0] || (await readEdit(db, ctx, id))
        return { ctx, row }
      },
      admin,
    )
    if (['queued', 'running'].includes(row.state)) editor.kick(ctx, row.id)
    return { edit: editPublic(row) }
  })
  app.post(`${root}/video-edits/:id/archive`, async (req) => {
    const id = editId(req)
    const { row, ctx } = await scoped(
      req,
      async (db, tenant, ctx) => ({
        row: await readEdit(db, ctx, id),
        ctx,
      }),
      admin,
    )
    if (row.result?.archive) return { archive: row.result.archive }
    if (row.state !== 'completed') throw fail(409, '成片尚未完成，不能归档')
    const entry = await driver.binding(ctx.tenantId,ctx.userId)
    if (!entry) throw fail(503, '企业素材服务暂时不可用')
    const bytes = await archiveBytes(entry, row)
    return scoped(
      req,
      async (db, tenant, context) => ({
        archive: await archiveVideoEdit(db, context, id, bytes),
      }),
      admin,
    )
  })
  app.get(`${root}/video-edits/:id/media`, async (req, reply) => {
    const { row, ctx } = await scoped(req, async (db, tenant, ctx) => ({
      ctx,
      row: await readEdit(db, ctx, editId(req)),
    }))
    if (row.state !== 'completed') throw fail(409, '成片尚未完成')
    const entry = await driver.binding(ctx.tenantId,ctx.userId)
    if (!entry) throw fail(503, '企业素材服务暂时不可用')
    const result = await openEditedVideo(entry, row, req.headers.range)
    reply
      .code(result.ContentRange ? 206 : 200)
      .header('content-type', 'video/mp4')
      .header('content-length', result.ContentLength)
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="edited-${row.id}.mp4"`,
      )
    if (result.ContentRange) reply.header('content-range', result.ContentRange)
    return reply.send(result.Body)
  })
}
