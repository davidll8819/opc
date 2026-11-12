import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hash } from '../apps/api/src/auth.mjs'
import { setup } from './helpers/archive-api-fixture.mjs'
import { privateVideoPolicy } from '../scripts/private-video-policy.mjs'

test('private video tickets bind tenant, user, session and expiry, recheck membership and permit ranges', async () => {
  const taskId = 'a'.repeat(24),
    url = 'http://127.0.0.1:19000/test/owner/ai/video/test.mp4'
  let upstream = 0
  const h = await setup(undefined, {
    operationsDriver: {
      binding: async () => ({
        userId: 'owner',
        infrastructure: { assets: { cdnEndpoint: 'http://127.0.0.1:19000/test' } },
      }),
      request: async () => {
        upstream++
        return { savedVideos: [{ status: 'SUCCESS', videoUrl: url }] }
      },
    },
  })
  const prefix = '/operations/video-access'
  try {
    await h.query(
      "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'fixture','submitted',$4)",
      [randomUUID(), h.tenant, h.alice, taskId],
    )
    const video = randomUUID(),
      bytes = Buffer.from('synthetic-private-video')
    await h.query(
      'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
      [video, h.tenant, h.alice, 'test.mp4', 'video/mp4', bytes],
    )
    const mint = async (body) => {
      const res = await h.request('POST', prefix, body)
      assert.equal(res.statusCode, 200)
      return res.json()
    }
    const source = await mint({ kind: 'source', taskId, url })
    assert.equal(upstream, 1)
    assert.ok(source.expiresAt > Date.now() + 295000 && source.expiresAt <= Date.now() + 300000)
    assert.doesNotMatch(source.url, /19000|mp4|owner/)
    assert.equal(
      (await h.request('POST', prefix, { kind: 'source', taskId, url: url + '.other' })).statusCode,
      404,
    )
    assert.equal(
      (await h.request('POST', prefix, { kind: 'source', taskId, url }, h.bob)).statusCode,
      404,
    )
    const ticket = await mint({ kind: 'archive', id: video })
    assert.equal((await h.app.inject(ticket.url)).statusCode, 401)
    assert.equal((await h.request('GET', ticket.url, undefined, h.bob)).statusCode, 403)
    assert.equal((await h.request('GET', ticket.url.replace(h.tenant, h.other))).statusCode, 403)
    const otherSession = randomUUID()
    await h.cache.set(
      `session:${hash(otherSession)}`,
      JSON.stringify({ userId: h.alice, csrf: otherSession }),
    )
    assert.equal((await h.request('GET', ticket.url, undefined, otherSession)).statusCode, 403)
    const result = await h.request('GET', ticket.url)
    assert.equal(result.statusCode, 200)
    assert.deepEqual(result.rawPayload, bytes)
    assert.match(result.headers['cache-control'], /no-store/)
    const range = await h.app.inject({
      url: ticket.url,
      headers: { cookie: `office_session=${h.alice}`, range: 'bytes=2-5' },
    })
    assert.equal(range.statusCode, 206)
    assert.deepEqual(range.rawPayload, bytes.subarray(2, 6))
    assert.equal(
      (await h.request('GET', ticket.url + '?download=1')).headers['content-disposition'],
      'attachment; filename="video.mp4"',
    )
    assert.equal((await h.request('DELETE', ticket.url)).statusCode, 200)
    assert.equal((await h.request('GET', ticket.url)).statusCode, 410)
    const expired = await mint({ kind: 'archive', id: video })
    const key = `video-access:${hash(expired.url.split('/').at(-1))}`
    const saved = JSON.parse(await h.cache.get(key))
    saved.expiresAt = Date.now() - 1
    await h.cache.set(key, JSON.stringify(saved))
    assert.equal((await h.request('GET', expired.url)).statusCode, 410)
    const current = await mint({ kind: 'archive', id: video })
    await h.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2', [h.tenant, h.alice])
    assert.equal((await h.request('GET', current.url)).statusCode, 403)
    assert.equal((await h.request('GET', source.url)).statusCode, 403)
    await h.cache.del(`session:${hash(h.alice)}`)
    assert.equal((await h.request('GET', current.url)).statusCode, 401)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})

test('startup policy removes blanket public reads and protects generated and edited videos', () => {
  const rule = privateVideoPolicy('test-bucket').Statement[0]
  assert.equal(rule.Resource, undefined)
  for (const suffix of [
    '*/ai/video/*',
    '*/office-edits/*',
    '*.mp4',
    '*.MP4',
    '*.Mp4',
    '*/agent/video-edit/*',
  ])
    assert.ok(rule.NotResource.includes(`arn:aws:s3:::test-bucket/${suffix}`))
  assert.deepEqual(rule.Action, ['s3:GetObject'])
  assert.ok(Buffer.byteLength(JSON.stringify(privateVideoPolicy('b'.repeat(63)))) < 20480)
})
