import { fail } from '../db.mjs'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { legacyMediaOwner } from './driver.mjs'

// Only download a saved result of an authorized task from its operator-owned store.
export async function openVideoDownload({ entry, task, url, fetcher = fetch, range }) {
  if (!task.savedVideos?.some((video) => video.status === 'SUCCESS' && video.videoUrl === url))
    throw fail(404, '该任务没有这份已完成的视频')
  let target, base
  try {
    target = new URL(url)
    base = new URL(entry.infrastructure.assets.cdnEndpoint)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    if (
      !['https:', ...(local ? ['http:'] : [])].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.origin !== base.origin ||
      !target.pathname.startsWith(
        `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(task[legacyMediaOwner]||entry.userId)}/`,
      ) ||
      /%2f|%5c|%2e/i.test(target.pathname)
    )
      throw new Error('Invalid storage path')
  } catch {
    throw fail(502, '视频地址与企业素材存储不一致，无法下载')
  }
  let response
  try {
    if (range && (!/^bytes=\d*-\d*$/.test(range) || range === 'bytes=-'))
      throw fail(416, '视频读取范围无效')
    const assets = entry.infrastructure.assets
    if (assets.endpoint) {
      if (!assets.accessKeyId || !assets.secretAccessKey) throw Error('Private storage unavailable')
      const client = new S3Client({
        endpoint: assets.endpoint,
        region: assets.region || 'us-east-1',
        forcePathStyle: assets.forcePathStyle !== false,
        credentials: { accessKeyId: assets.accessKeyId, secretAccessKey: assets.secretAccessKey },
        maxAttempts: 2,
      })
      try {
        const key = decodeURIComponent(
          target.pathname.slice(base.pathname.replace(/\/$/, '').length + 1),
        )
        const object = await client.send(
          new GetObjectCommand({
            Bucket: assets.bucketName,
            Key: key,
            ...(range ? { Range: range } : {}),
          }),
          { abortSignal: AbortSignal.timeout(120000) },
        )
        object.Body.once('close', () => client.destroy())
        const headers = {
          'content-type': object.ContentType || 'video/mp4',
          'accept-ranges': 'bytes',
        }
        if (object.ContentLength !== undefined)
          headers['content-length'] = String(object.ContentLength)
        if (object.ContentRange) headers['content-range'] = object.ContentRange
        response = new Response(Readable.toWeb(object.Body), {
          status: object.ContentRange ? 206 : 200,
          headers,
        })
      } catch (error) {
        client.destroy()
        if (error.$metadata?.httpStatusCode === 416) throw fail(416, '视频读取范围无效')
        throw error
      }
    } else {
      response = await fetcher(target.href, {
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        ...(range ? { headers: { range } } : {}),
      })
    }
    if (
      !response.ok ||
      !response.body ||
      response.redirected ||
      !/^(video\/|application\/octet-stream(?:;|$))/i.test(
        response.headers.get('content-type') || '',
      )
    )
      throw new Error('Video unavailable')
    return response
  } catch (error) {
    await response?.body?.cancel().catch(() => {})
    if (error.statusCode === 416) throw error
    throw fail(502, '视频下载暂时失败，请稍后重试；不会重新生成视频')
  }
}
