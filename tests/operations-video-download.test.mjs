import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { openVideoDownload } from '../apps/api/src/operations/video-download.mjs'
import { registerOperations } from '../apps/api/src/operations/routes.mjs'
import { fail } from '../apps/api/src/db.mjs'
const entry = {
  userId: 'owner',
  infrastructure: { assets: { cdnEndpoint: 'http://127.0.0.1:19000/bucket' } },
}
const url = 'http://127.0.0.1:19000/bucket/owner/ai/video/result.mp4'
const task = { savedVideos: [{ status: 'SUCCESS', videoUrl: url }] }

test('downloads only a completed saved result without forwarding private credentials', async () => {
  const body = Buffer.from('synthetic-video-bytes')
  const response = await openVideoDownload({
    entry,
    task,
    url,
    fetcher: async (target, options) => {
      assert.equal(target, url)
      assert.equal(options.credentials, 'omit')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers, undefined)
      return new Response(body, { headers: { 'content-type': 'video/mp4' } })
    },
  })
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body)
})

test('rejects other files, unfinished results and untrusted storage before making a request', async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    throw Error('unexpected')
  }
  for (const other of [
    'http://127.0.0.1:3302/admin',
    'https://evil.example/a.mp4',
    'http://127.0.0.1:19000/bucket/other-user/a.mp4',
    'http://127.0.0.1:19000/bucket/owner/../private/a.mp4',
    'http://127.0.0.1:19000/bucket/owner/%2e%2e/private/a.mp4',
    'http://user:pass@127.0.0.1:19000/bucket/owner/a.mp4',
    'http://127.0.0.1:19000/bucket/owner/a.mp4?token=synthetic',
  ]) {
    await assert.rejects(
      openVideoDownload({
        entry,
        url: other,
        task: { savedVideos: [{ status: 'SUCCESS', videoUrl: other }] },
        fetcher,
      }),
      /视频地址/,
    )
  }
  await assert.rejects(openVideoDownload({ entry, task, url: url + '.other', fetcher }), /没有/)
  await assert.rejects(
    openVideoDownload({
      entry,
      task: { savedVideos: [{ status: 'InProgress', videoUrl: url }] },
      url,
      fetcher,
    }),
    /没有/,
  )
  assert.equal(calls, 0)
})

test('missing, redirected, non-video and unavailable files return a friendly failure without regeneration', async () => {
  for (const response of [
    new Response('missing', { status: 404 }),
    new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
    new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    await assert.rejects(
      openVideoDownload({ entry, task, url, fetcher: async () => response }),
      /不会重新生成/,
    )
  }
  await assert.rejects(
    openVideoDownload({
      entry,
      task,
      url,
      fetcher: async () => {
        throw Error('network unavailable')
      },
    }),
    /稍后重试/,
  )
})

test('HTTP download enforces login and task ownership, streams an attachment for the owner', async () => {
  const app = Fastify()
  const id = 'a'.repeat(24)
  let upstream = 0,
    reads = 0
  registerOperations(app, {
    env: {},
    tasks: {},
    scoped: async (req, work) => {
      if (!req.headers['x-test-user']) throw fail(401, '请登录')
      const db = {
        query: async (sql) => ({
          rows: sql.includes('operations_submissions')
            ? req.headers['x-test-user'] === 'owner'
              ? [{ runtime_task_id: id }]
              : []
            : sql.includes('operations_settings')
              ? [{ revision: 1 }]
              : [],
        }),
      }
      return work(db, {}, { tenantId: 'tenant-a', userId: req.headers['x-test-user'] })
    },
    driver: {
      ready: async () => entry,
      request: async () => {
        reads++
        return task
      },
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    upstream++
    return new Response('video-bytes', {
      headers: { 'content-type': 'video/mp4', 'content-length': '11' },
    })
  }
  try {
    const path = `/api/tenants/tenant-a/operations/tasks/${id}/video/download?url=${encodeURIComponent(url)}`
    assert.equal((await app.inject({ url: path })).statusCode, 401)
    assert.equal(
      (await app.inject({ url: path, headers: { 'x-test-user': 'other' } })).statusCode,
      404,
    )
    assert.equal(reads, 0)
    assert.equal(upstream, 0)
    const res = await app.inject({ url: path, headers: { 'x-test-user': 'owner' } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, 'video-bytes')
    assert.match(res.headers['content-disposition'], /^attachment;/)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(upstream, 1)
  } finally {
    globalThis.fetch = original
    await app.close()
  }
})
