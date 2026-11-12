import { createHash, randomUUID } from 'node:crypto'
import { fail } from '../db.mjs'
import { readEdit, openEditedVideo } from './video-edit-service.mjs'

// Read the immutable export outside the database transaction; never archive a remote URL alone.
export async function archiveBytes(entry, row, open = openEditedVideo) {
  if (row.state !== 'completed') throw fail(409, '成片尚未完成，不能归档')
  const limit = 100 * 1024 * 1024
  if (!row.result?.bytes || row.result.bytes > limit)
    throw fail(409, '成片超过资料室容量，请先下载保留')
  const object = await open(entry, row)
  const chunks = []
  let size = 0
  try {
    for await (const chunk of object.Body) {
      size += chunk.length
      if (size > limit) throw fail(409, '成片超过资料室容量，请先下载保留')
      chunks.push(chunk)
    }
  } finally {
    object.Body.destroy?.()
  }
  if (size !== row.result.bytes) throw fail(502, '成片读取不完整，请重试归档')
  return Buffer.concat(chunks)
}

export async function archiveVideoEdit(db, ctx, id, bytes) {
  await db.query(
    `INSERT INTO secretary_workspaces(tenant_id,user_id,board,revision) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, ctx.userId, JSON.stringify({ tasks: [], messages: [], batches: [] })],
  )
  await db.query(
    'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
    [ctx.tenantId, ctx.userId],
  )
  // Match the existing board → user lock order; uploads share the quota lock.
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ctx.userId])
  const row = await readEdit(db, ctx, id)
  if (row.result?.archive) return row.result.archive
  if (row.state !== 'completed') throw fail(409, '成片尚未完成，不能归档')
  if (!bytes?.length || bytes.length !== row.result.bytes)
    throw fail(502, '成片读取不完整，请重试归档')
  const workspace = (
    await db.query(
      'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  const board = workspace?.board || { tasks: [], messages: [], batches: [] }
  const source = board.tasks.find((t) => t.runtimeTaskId === row.task_id && !t.videoEditId)
  const now = new Date().toISOString(),
    fileId = randomUUID(),
    manifestId = randomUUID(),
    taskId = randomUUID()
  const title = row.spec.title.replace(/[/\\\x00-\x1f]/g, '_').slice(0, 100)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const summary = `成片已确认并保存到资料室。${row.result.width} × ${row.result.height}，${row.result.duration.toFixed(2)} 秒。对外发布尚未授权。`
  const manifest = Buffer.from(
    `# ${title}\n\n${summary}\n\n需求：${source?.request || source?.summary || '参见运营工作台的原始任务记录'}\n\n原制作任务：${row.task_id}\n剪辑版本：${id}\n确认时间：${now}\n文件 SHA-256：${sha256}\n\n剪辑设置：\n\n\`\`\`json\n${JSON.stringify(row.spec, null, 2)}\n\`\`\`\n`,
  )
  const total = Number(
    (
      await db.query(
        'SELECT coalesce(sum(octet_length(data)),0) total FROM workspace_files WHERE tenant_id=$1 AND user_id=$2',
        [ctx.tenantId, ctx.userId],
      )
    ).rows[0].total,
  )
  if (total + bytes.length + manifest.length > 100 * 1024 * 1024)
    throw fail(409, '资料空间已满，归档未完成；成片仍保留在剪辑记录，可先下载')
  for (const [fid, name, mime, data] of [
    [fileId, `${title}.mp4`, 'video/mp4', bytes],
    [manifestId, `${title}-制作记录.md`, 'text/markdown', manifest],
  ])
    await db.query(
      'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
      [fid, ctx.tenantId, ctx.userId, name, mime, data],
    )
  const archive = { fileId, manifestId, taskId, sha256, archivedAt: now }
  board.tasks.push({
    id: taskId,
    title,
    dept: 'app-agent',
    due: now.slice(0, 10),
    status: 'completed',
    publishRequired: false,
    summary,
    request: source?.request || '',
    runtimeTaskId: row.task_id,
    videoEditId: id,
    archiveFileId: manifestId,
    archiveVideoFileId: fileId,
    archiveName: `${title}-制作记录.md`,
    archivedAt: now,
    finishedAt: now,
    executionNote: '成片已确认并归档；对外发布需要另行确认',
    media: [{ type: 'VIDEO', url: `/api/tenants/${ctx.tenantId}/files/${fileId}/video` }],
  })
  await db.query(
    `INSERT INTO secretary_workspaces(tenant_id,user_id,board,revision) VALUES($1,$2,$3,1)
    ON CONFLICT(tenant_id,user_id) DO UPDATE SET board=$3,revision=secretary_workspaces.revision+1,updated_at=now()`,
    [ctx.tenantId, ctx.userId, JSON.stringify(board)],
  )
  await db.query(
    'UPDATE operations_video_edits SET result=$4,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3',
    [ctx.tenantId, ctx.userId, id, JSON.stringify({ ...row.result, archive })],
  )
  return archive
}
