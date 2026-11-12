import { createHash } from 'node:crypto'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { transaction, fail } from '../db.mjs'
import { assertRuntimeAccess } from './task-access.mjs'
import { parseVideoEdit } from './video-edit-schema.mjs'
import { renderVideoEdit } from './video-edit-render.mjs'

export const editPublic = (row) => ({
  id: row.id,
  isFinal: row.is_final || false,
  taskId: row.task_id,
  spec: row.spec,
  state: row.state,
  phase: row.phase,
  error: row.error,
  result: row.result && {
    width: row.result.width,
    height: row.result.height,
    duration: row.result.duration,
    bytes: row.result.bytes,
    archive: row.result.archive,
  },
  createdAt: row.created_at,
})
const hash = (data) => createHash('sha256').update(data).digest('hex')
export async function readEdit(db, ctx, id) {
  const row = (
    await db.query(
      'SELECT * FROM operations_video_edits WHERE tenant_id=$1 AND user_id=$2 AND id=$3',
      [ctx.tenantId, ctx.userId, id],
    )
  ).rows[0]
  if (!row) throw fail(404, '剪辑记录不存在')
  return row
}

export async function prepareEdit(db, ctx, taskId, body) {
  const { requestId, spec, musicFromEditId, narrationFromEditId, ...upload } = parseVideoEdit(body)
  let music = upload.music
  await assertRuntimeAccess(db, ctx, taskId)
  if (musicFromEditId) {
    const source = await readEdit(db, ctx, musicFromEditId)
    if (!source.music) throw fail(400, '这份剪辑没有已保存的配乐，请重新选择')
    music = Buffer.from(source.music)
    spec.musicName = source.spec.musicName
  }
  let narration = upload.narration
  if (narrationFromEditId) {
    const source = await readEdit(db, ctx, narrationFromEditId)
    if (!source.narration) throw fail(400, '配音不存在')
    narration = Buffer.from(source.narration); spec.narrationName = source.spec.narrationName
  }
  return { requestId, spec, music, narration }
}

export async function saveEdit(db, ctx, taskId, body) {
  const { requestId, spec, music, narration } = await prepareEdit(db, ctx, taskId, body)
  const fingerprint = hash(JSON.stringify({ taskId, spec, music: music ? hash(music) : null, narration: narration ? hash(narration) : null }))
  // Serialize reservations for this user; the same request ID never creates two renders.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `video-edit:${ctx.tenantId}:${ctx.userId}`,
  ])
  const existing = (
    await db.query(
      'SELECT * FROM operations_video_edits WHERE tenant_id=$1 AND user_id=$2 AND id=$3',
      [ctx.tenantId, ctx.userId, requestId],
    )
  ).rows[0]
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw fail(409, '这个提交编号已有不同的剪辑内容，请新建一次导出')
    return existing
  }
  const count = (
    await db.query(
      "SELECT count(*)::int AS n FROM operations_video_edits WHERE tenant_id=$1 AND user_id=$2 AND state IN ('queued','running')",
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0].n
  if (count >= 2) throw fail(429, '已有两份剪辑等待处理，请完成后再导出')
  return (
    await db.query(
      `INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,music,narration)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [requestId, ctx.tenantId, ctx.userId, taskId, fingerprint, spec, music, narration],
    )
  ).rows[0]
}

function s3(entry) {
  const a = entry.infrastructure.assets
  return new S3Client({
    endpoint: a.endpoint,
    region: a.region || 'us-east-1',
    forcePathStyle: a.forcePathStyle !== false,
    credentials: { accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey },
    maxAttempts: 2,
  })
}
export async function storeEdit(entry, row, result, signal) {
  const key = `${entry.userId}/office-edits/${row.user_id}/${row.id}.mp4`
  const client = s3(entry)
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: entry.infrastructure.assets.bucketName,
        Key: key,
        Body: createReadStream(result.file),
        ContentLength: result.bytes,
        ContentType: 'video/mp4',
      }),
      { abortSignal: signal },
    )
    const { file, ...metadata } = result
    return { ...metadata, key }
  } catch {
    throw fail(502, '成片保存失败，请重试；原视频仍然保留')
  } finally {
    client.destroy()
  }
}

export async function openEditedVideo(entry, row, range) {
  if (row.state !== 'completed' || !row.result?.key)
    throw fail(409, '成片尚未完成，暂时不能预览或下载')
  if (range && (!/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-'))
    throw fail(416, '视频读取范围无效')
  const client = s3(entry)
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: entry.infrastructure.assets.bucketName,
        Key: row.result.key,
        ...(range ? { Range: range } : {}),
      }),
    )
    response.Body.once('close', () => client.destroy())
    return response
  } catch (error) {
    client.destroy()
    throw fail(error.$metadata?.httpStatusCode === 416 ? 416 : 502, '成片暂时无法读取，请稍后重试')
  }
}

export function createVideoEditor({
  pool,
  driver,
  env,
  render = renderVideoEdit,
  store = storeEdit,
}) {
  const queue = new Map(),
    controller = new AbortController()
  let working = null,
    closing = false
  async function processJob(ctx, id) {
    const db = await pool.connect()
    let locked = false,
      dir
    const work = (fn) =>
      transaction({ connect: async () => ({ query: db.query.bind(db), release() {} }) }, fn, ctx)
    const update = (state, phase, error = null, result = null) =>
      work((client) =>
        client.query(
          'UPDATE operations_video_edits SET state=$4,phase=$5,error=$6,result=COALESCE($7,result),updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3',
          [ctx.tenantId, ctx.userId, id, state, phase, error, result],
        ),
      )
    try {
      locked = (
        await db.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
          `video-edit:${ctx.tenantId}:${ctx.userId}:${id}`,
        ])
      ).rows[0].locked
      if (!locked) return
      const row = await work((client) => readEdit(client, ctx, id))
      if (!['queued', 'running'].includes(row.state)) return
      await update('running', '读取原视频')
      await work((client) => assertRuntimeAccess(client, ctx, row.task_id))
      const entry = await driver.binding(ctx.tenantId,ctx.userId)
      if (!entry) throw fail(503, '企业素材服务暂时不可用')
      const task = await driver.request(entry, 'ai', `/agent/tasks/${row.task_id}`)
      dir = await mkdtemp(join(env.VIDEO_EDIT_TMP || tmpdir(), 'office-video-edit-'))
      await chmod(dir, 0o700)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)])
      const result = await render({
        entry,
        task,
        spec: row.spec,
        music: row.music && Buffer.from(row.music),
        narration: row.narration && Buffer.from(row.narration),
        dir,
        signal,
        env,
        phase: (value) => update('running', value),
      })
      await update('running', '保存成片')
      const stored = await store(entry, row, result, signal)
      await update('completed', '成片已保存，可以预览和下载', null, stored)
    } catch (error) {
      if (locked)
        await update(
          closing ? 'queued' : 'failed',
          closing ? '服务重启后可恢复处理' : '导出未完成',
          closing ? null : error.expose ? error.message : '导出失败或超时，请重试；原视频仍然保留',
        ).catch(() => {})
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      try {
        if (locked)
          await db.query('SELECT pg_advisory_unlock(hashtext($1))', [
            `video-edit:${ctx.tenantId}:${ctx.userId}:${id}`,
          ])
      } finally {
        db.release()
      }
    }
  }
  async function drain() {
    while (!closing && queue.size) {
      const [key, { ctx, id }] = queue.entries().next().value
      try {
        await processJob(ctx, id)
      } catch {
        /* Polling retries transient database failures. */
      }
      queue.delete(key)
    }
  }
  return {
    kick(ctx, id) {
      if (closing || queue.size >= 32) return
      queue.set(`${ctx.tenantId}:${ctx.userId}:${id}`, { ctx, id })
      if (!working)
        working = drain().finally(() => {
          working = null
        })
    },
    async close() {
      closing = true
      controller.abort()
      await working
      queue.clear()
    },
  }
}
