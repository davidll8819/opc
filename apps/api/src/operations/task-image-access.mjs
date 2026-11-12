import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { z } from 'zod'
import { fail } from '../db.mjs'
import { imageBytes } from '../design-images.mjs'
const maxImage = 6 * 1024 * 1024

export function taskImageKey(entry, value) {
  try {
    const base = new URL(entry.infrastructure.assets.cdnEndpoint),
      target = new URL(value)
    if (
      ![
        'https:',
        ...(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ? ['http:'] : []),
      ].includes(base.protocol) ||
      base.username ||
      base.password ||
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      base.search ||
      base.hash ||
      ![entry.userId,...(entry.legacyTaskIds?.length?[entry.legacyUserId]:[])].some(owner=>target.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(owner)}/`)) ||
      /%2f|%5c|%2e/i.test(target.pathname)
    )
      throw Error('Unexpected storage path')
    return decodeURIComponent(target.pathname.slice(base.pathname.replace(/\/$/, '').length + 1))
  } catch {
    throw fail(404, '这份图片不属于当前企业素材存储')
  }
}
export async function readTaskImage(entry, url) {
  const Key = taskImageKey(entry, url),
    assets = entry.infrastructure.assets
  if (!assets.endpoint || !assets.bucketName || !assets.accessKeyId || !assets.secretAccessKey)
    throw fail(503, '企业图片存储尚未就绪')
  const client = new S3Client({
    endpoint: assets.endpoint,
    region: assets.region || 'us-east-1',
    forcePathStyle: assets.forcePathStyle !== false,
    credentials: { accessKeyId: assets.accessKeyId, secretAccessKey: assets.secretAccessKey },
    maxAttempts: 2,
  })
  let body
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: assets.bucketName, Key }), {
      abortSignal: AbortSignal.timeout(15000),
    })
    body = object.Body
    if (!body || object.ContentLength > maxImage) throw fail(502, '图片不可用或超过 6 MB')
    let size = 0
    const chunks = []
    for await (const chunk of body) {
      size += chunk.length
      if (size > maxImage) throw fail(502, '图片超过 6 MB')
      chunks.push(chunk)
    }
    return imageBytes(Buffer.concat(chunks))
  } catch (error) {
    if (error.statusCode) throw error
    throw fail(502, '图片暂时无法读取，请稍后重试')
  } finally {
    body?.destroy()
    client.destroy()
  }
}
export function registerTaskImageAccess(app, { scoped, driver }) {
  app.get('/api/tenants/:tenantId/secretary/tasks/:id/media/:index', async (req, reply) => {
    const id = z.string().uuid().parse(req.params.id)
    const index = z.coerce.number().int().min(0).max(1000).parse(req.params.index)
    const { tenantId, userId, url } = await scoped(req, async (db, _tenant, ctx) => {
      const board = (
        await db.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
          ctx.tenantId,
          ctx.userId,
        ])
      ).rows[0]?.board
      const media = board?.tasks?.find((task) => task.id === id)?.media?.[index]
      if (!media || media.type !== 'IMAGE') throw fail(404, '任务图片不存在')
      return { tenantId: ctx.tenantId, userId: ctx.userId, url: media.url }
    })
    const entry = await driver.binding(tenantId,userId)
    if (!entry) throw fail(503, '企业图片存储尚未就绪')
    const { bytes, mime, ext } = await readTaskImage(entry, url)
    return reply
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('content-disposition', `inline; filename="task-image.${ext}"`)
      .type(mime)
      .send(bytes)
  })
}
