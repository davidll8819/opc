import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { hash } from '../auth.mjs'
import { fail } from '../db.mjs'
import { assertRuntimeAccess } from './task-access.mjs'
import { openVideoDownload } from './video-download.mjs'
import { readEdit, openEditedVideo } from './video-edit-service.mjs'

const input = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('source'),
      taskId: z.string().regex(/^[a-f0-9]{24}$/),
      url: z.string().url().max(4096),
    })
    .strict(),
  z.object({ kind: z.literal('edit'), id: z.uuid() }).strict(),
  z.object({ kind: z.literal('archive'), id: z.uuid() }).strict(),
])

export function registerVideoAccess(
  app,
  { scoped, driver, cache, ttlSeconds = 300, now = Date.now },
) {
  const root = '/api/tenants/:tenantId/operations/video-access'
  async function authorize(req, target) {
    return scoped(req, async (db, _tenant, ctx) => {
      if (target.kind === 'source') await assertRuntimeAccess(db, ctx, target.taskId)
      if (target.kind === 'edit') {
        const row = await readEdit(db, ctx, target.id)
        await assertRuntimeAccess(db, ctx, row.task_id)
        if (row.state !== 'completed') throw fail(409, '成片尚未完成')
        return { ctx, row }
      }
      if (target.kind === 'archive') {
        const row = (
          await db.query(
            "SELECT data FROM workspace_files WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND deleted_at IS NULL AND mime='video/mp4'",
            [target.id, ctx.tenantId, ctx.userId],
          )
        ).rows[0]
        if (!row) throw fail(404, '归档视频不存在')
        return { ctx, row }
      }
      return { ctx }
    })
  }
  app.post(root, async (req) => {
    const target = input.parse(req.body),
      { ctx } = await authorize(req, target)
    if (target.kind === 'source') {
      const entry = await driver.binding(ctx.tenantId,ctx.userId)
      if (!entry) throw fail(503, '企业素材服务暂时不可用')
      const task = await driver.request(entry, 'ai', `/agent/tasks/${target.taskId}`)
      if (!task.savedVideos?.some((v) => v.status === 'SUCCESS' && v.videoUrl === target.url))
        throw fail(404, '该任务没有这份已完成的视频')
    }
    const token = randomBytes(32).toString('base64url'),
      expiresAt = now() + ttlSeconds * 1000
    await cache.set(
      `video-access:${hash(token)}`,
      JSON.stringify({ target, ...ctx, session: hash(req.identity.sessionId), expiresAt }),
      { EX: ttlSeconds },
    )
    return { url: `${root.replace(':tenantId', ctx.tenantId)}/${token}`, expiresAt }
  })
  async function grant(req) {
    const token = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(req.params.token)
    const raw = await cache.get(`video-access:${hash(token)}`)
    if (!raw) throw fail(410, '视频链接已过期或已撤销，请重新获取')
    const saved = JSON.parse(raw)
    if (
      saved.userId !== req.identity.userId ||
      saved.tenantId !== req.params.tenantId ||
      saved.session !== hash(req.identity.sessionId)
    )
      throw fail(403, '视频链接仅限当前登录会话使用')
    if (now() >= saved.expiresAt) throw fail(410, '视频链接已过期，请重新获取')
    return { saved, token }
  }
  app.delete(`${root}/:token`, async (req) => {
    const { token, saved } = await grant(req)
    await authorize(req, saved.target)
    await cache.del(`video-access:${hash(token)}`)
    return { revoked: true }
  })
  app.get(`${root}/:token`, async (req, reply) => {
    const { saved } = await grant(req),
      { ctx, row } = await authorize(req, saved.target)
    const range = req.headers.range
    reply
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('accept-ranges', 'bytes')
      .header('content-type', 'video/mp4')
      .header(
        'content-disposition',
        `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="video.mp4"`,
      )
    if (saved.target.kind === 'archive') {
      const bytes = Buffer.from(row.data)
      let start = 0,
        end = bytes.length - 1
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) throw fail(416, '视频读取范围无效')
        start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]))
        if (match[1] && match[2]) end = Math.min(end, Number(match[2]))
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= bytes.length
        )
          throw fail(416, '视频读取范围无效')
        reply.code(206).header('content-range', `bytes ${start}-${end}/${bytes.length}`)
      }
      return reply.header('content-length', end - start + 1).send(bytes.subarray(start, end + 1))
    }
    const entry = await driver.binding(ctx.tenantId,ctx.userId)
    if (!entry) throw fail(503, '企业素材服务暂时不可用')
    if (saved.target.kind === 'edit') {
      const result = await openEditedVideo(entry, row, range)
      if (result.ContentRange) reply.code(206).header('content-range', result.ContentRange)
      return reply.header('content-length', result.ContentLength).send(result.Body)
    }
    const task = await driver.request(entry, 'ai', `/agent/tasks/${saved.target.taskId}`)
    const result = await openVideoDownload({ entry, task, url: saved.target.url, range })
    reply.code(result.status)
    for (const header of ['content-length', 'content-range'])
      if (result.headers.has(header)) reply.header(header, result.headers.get(header))
    return reply.send(Readable.fromWeb(result.body))
  })
}
