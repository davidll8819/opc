import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { fail } from '../db.mjs'
import { assertRuntimeAccess } from './task-access.mjs'
import { readEdit } from './video-edit-service.mjs'

// Working drafts deliberately accept unfinished titles, captions and time ranges.
const time = z.number().finite().min(0).max(180)
const schema = z
  .object({
    draft: z
      .object({
        title: z.string().max(80),
        segments: z
          .array(z.object({ url: z.string().url().max(4096), start: time, end: time }).strict())
          .min(1)
          .max(8),
        subtitles: z
          .array(z.object({ start: time, end: time, text: z.string().max(100) }).strict())
          .max(30),
        ratio: z.enum(['9:16', '16:9', '1:1']),
        resolution: z.enum(['720p', '1080p']),
        fit: z.enum(['contain', 'cover']),
        originalVolume: z.number().min(0).max(1),
        narrationVolume: z.number().min(0).max(1).optional(),
        narrationCues: z.array(z.object({ start: time, end: time }).strict()).max(30).optional(),
        musicFade: z.number().min(0).max(5).optional(),
        duckMusic: z.boolean().optional(),
        musicVolume: z.number().min(0).max(1),
      })
      .strict(),
    music: z
      .object({ name: z.string().max(120), base64: z.string().max(12 * 1024 * 1024) })
      .strict()
      .optional(),
    savedMusic: z
      .object({ id: z.string().uuid(), name: z.string().max(120) })
      .strict()
      .optional(),
    narration: z.object({ name: z.string().max(120), base64: z.string().max(12 * 1024 * 1024) }).strict().optional(),
    savedNarration: z.object({ id: z.uuid(), name: z.string().max(120) }).strict().optional(),
    formatInitialized: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.music && v.savedMusic), '不能同时保存两份配乐')
export async function readVideoDraft(db, ctx, taskId) {
  await assertRuntimeAccess(db, ctx, taskId)
  const { rows } = await db.query(
    'SELECT content,revision,updated_at FROM operations_video_drafts WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3',
    [ctx.tenantId, ctx.userId, taskId],
  )
  return rows[0] || { content: null, revision: 0 }
}
export async function saveVideoDraft(db, ctx, taskId, body) {
  const { content, revision } = z
    .object({ content: schema, revision: z.number().int().min(0) })
    .strict()
    .parse(body)
  await assertRuntimeAccess(db, ctx, taskId)
  if (
    content.music &&
    (!/^[A-Za-z0-9+/]+={0,2}$/.test(content.music.base64) ||
      Buffer.from(content.music.base64, 'base64').length > 8 * 1024 * 1024)
  )
    throw fail(400, '配乐文件格式无效或超过8MB')
  if (content.narration && (content.savedNarration || Buffer.from(content.narration.base64, 'base64').length > 8 * 1024 * 1024 || Buffer.from(content.narration.base64, 'base64').toString('base64') !== content.narration.base64)) throw fail(400, '配音文件格式无效')
  if (content.savedNarration) await readEdit(db, ctx, content.savedNarration.id)
  if (content.savedMusic) await readEdit(db, ctx, content.savedMusic.id)
  // Serialize first inserts too, so concurrent tabs receive a conflict, never an overwrite.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `video-draft:${ctx.tenantId}:${ctx.userId}:${taskId}`,
  ])
  const current = await readVideoDraft(db, ctx, taskId)
  if (current.revision !== revision) {
    if (isDeepStrictEqual(current.content, content)) return current
    throw fail(
      409,
      '另一个窗口已更新草稿。当前内容仍保留，请复制需要的文字，再重新载入已保存草稿。',
    )
  }
  const { rows } = await db.query(
    `INSERT INTO operations_video_drafts(tenant_id,user_id,task_id,content) VALUES($1,$2,$3,$4)
    ON CONFLICT(tenant_id,user_id,task_id) DO UPDATE SET content=$4,revision=operations_video_drafts.revision+1,updated_at=now()
    RETURNING content,revision,updated_at`,
    [ctx.tenantId, ctx.userId, taskId, JSON.stringify(content)],
  )
  return rows[0]
}
