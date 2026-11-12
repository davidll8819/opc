import { z } from 'zod'
import { fail } from '../db.mjs'

export async function fileReferences(db, ctx, id) {
  // Conservative protection: retained conversations and source extractions count too.
  const { rows } = await db.query(`SELECT
    EXISTS(SELECT 1 FROM archive_documents WHERE tenant_id=$1 AND user_id=$2 AND file_id=$3::uuid) OR
    EXISTS(SELECT 1 FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 AND strpos(board::text,$3::text)>0) OR
    EXISTS(SELECT 1 FROM department_conversations WHERE tenant_id=$1 AND user_id=$2 AND strpos(messages::text,$3::text)>0) OR
    EXISTS(SELECT 1 FROM employee_workspaces WHERE tenant_id=$1 AND user_id=$2 AND strpos(messages::text,$3::text)>0) OR
    EXISTS(SELECT 1 FROM operations_video_edits WHERE tenant_id=$1 AND user_id=$2 AND strpos(result::text,$3::text)>0)
    AS referenced`, [ctx.tenantId, ctx.userId, id])
  return rows[0].referenced
}

export function registerFileRecycle(app, { scoped }) {
  const root = '/api/tenants/:tenantId/files'
  app.get(`${root}/storage`, req => scoped(req, async (db, tenant, ctx) => {
    const { rows } = await db.query(`SELECT id,name,mime,octet_length(data) size,created_at,deleted_at
      FROM workspace_files WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC`, [ctx.tenantId, ctx.userId])
    let used = 0, trash = 0
    for (const row of rows) {
      used += Number(row.size)
      if (row.deleted_at) trash += Number(row.size)
      row.protected = await fileReferences(db, ctx, row.id)
    }
    return { used, trash, limit: 100 * 1024 * 1024, items: rows }
  }))
  for (const action of ['trash', 'restore', 'purge']) {
    app.post(`${root}/:id/${action}`, req => scoped(req, async (db, tenant, ctx) => {
      const id = z.uuid().parse(req.params.id)
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ctx.userId])
      const row = (await db.query('SELECT deleted_at FROM workspace_files WHERE id=$1 AND tenant_id=$2 AND user_id=$3 FOR UPDATE',
        [id, ctx.tenantId, ctx.userId])).rows[0]
      if (!row) throw fail(404, '文件不存在')
      if (action !== 'restore' && await fileReferences(db, ctx, id))
        throw fail(409, '文件被任务、对话或档案引用，不能删除')
      if (action === 'purge') {
        if (!row.deleted_at) throw fail(409, '请先将文件移入回收站')
        z.object({ confirm: z.literal('永久删除') }).strict().parse(req.body)
        await db.query('DELETE FROM workspace_files WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [id, ctx.tenantId, ctx.userId])
      } else {
        await db.query(`UPDATE workspace_files SET deleted_at=${action === 'trash' ? 'coalesce(deleted_at,now())' : 'NULL'}
          WHERE id=$1 AND tenant_id=$2 AND user_id=$3`, [id, ctx.tenantId, ctx.userId])
      }
      return { ok: true }
    }))
  }
}
