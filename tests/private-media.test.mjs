import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { taskImageKey } from '../apps/api/src/operations/task-image-access.mjs'
import { exclusivelyOwnServe } from '../scripts/private-access.mjs'

test('private access setup refuses to replace other Serve or Funnel services', () => {
  const origin = 'https://test-mac.tail-test.ts.net'
  const host = 'test-mac.tail-test.ts.net:443'
  const own = {
    TCP: { 443: { HTTPS: true } },
    Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  }
  assert.equal(exclusivelyOwnServe({}, origin), true)
  assert.equal(exclusivelyOwnServe(own, origin), true)
  for (const value of [
    { ...own, AllowFunnel: { [host]: true } },
    { ...own, TCP: { 80: { HTTP: true } } },
    { ...own, TCP: { 443: { TCPForward: '127.0.0.1:22' } } },
    { ...own, Foreground: { other: {} } },
    { ...own, Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4000' } } } } },
    {
      ...own,
      Web: {
        [host]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' }, '/other': { Text: 'keep me' } },
        },
      },
    },
  ])
    assert.equal(exclusivelyOwnServe(value, origin), false)
})

test('task images use authenticated same-origin storage access with user and tenant isolation', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7uoAAAAASUVORK5CYII=',
    'base64',
  )
  let bytes = png,
    downloads = 0
  const server = createServer((req, res) => {
    downloads++
    assert.equal(req.url.split('?')[0], '/test-bucket/owner-id/picture.png')
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
    })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const entry = {
    userId: 'owner-id',
    infrastructure: {
      assets: {
        cdnEndpoint: 'http://localhost:19000/test-bucket',
        endpoint: `http://127.0.0.1:${server.address().port}`,
        bucketName: 'test-bucket',
        accessKeyId: 'synthetic-access',
        secretAccessKey: 'synthetic-secret',
      },
    },
  }
  const imageUrl = 'http://localhost:19000/test-bucket/owner-id/picture.png'
  const h = await setup(undefined, { operationsDriver: { binding: async () => entry } })
  try {
    assert.equal(taskImageKey(entry, imageUrl), 'owner-id/picture.png')
    for (const bad of [
      'http://169.254.169.254/latest/meta-data',
      imageUrl.replace('owner-id', 'other-user'),
      imageUrl + '?secret=x',
      imageUrl.replace('picture.png', '%2e%2e/other.png'),
    ])
      assert.throws(() => taskImageKey(entry, bad))
    const id = randomUUID()
    const board = {
      messages: [],
      batches: [],
      tasks: [{ id, media: [{ type: 'IMAGE', url: imageUrl }] }],
    }
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [
      h.tenant,
      h.alice,
      JSON.stringify(board),
    ])
    const path = `/secretary/tasks/${id}/media/0`
    const good = await h.request('GET', path)
    assert.equal(good.statusCode, 200, good.body)
    assert.deepEqual(good.rawPayload, png)
    assert.equal(good.headers['content-type'], 'image/png')
    assert.equal(good.headers['cache-control'], 'private, no-store')
    assert.equal(good.headers['x-content-type-options'], 'nosniff')
    assert.equal((await h.request('GET', path, undefined, h.bob)).statusCode, 404)
    assert.equal((await h.request('GET', `/api/tenants/${h.other}${path}`)).statusCode, 404)
    assert.equal((await h.request('GET', `/secretary/tasks/${id}/media/1`)).statusCode, 404)
    assert.equal((await h.app.inject({ method: 'GET', url: `${h.base}${path}` })).statusCode, 401)
    assert.equal(downloads, 1)
    board.tasks[0].media[0].url = 'http://169.254.169.254/latest/meta-data'
    await h.query('UPDATE secretary_workspaces SET board=$3 WHERE tenant_id=$1 AND user_id=$2', [
      h.tenant,
      h.alice,
      JSON.stringify(board),
    ])
    assert.equal((await h.request('GET', path)).statusCode, 404)
    assert.equal(downloads, 1, 'an untrusted URL is never fetched')
    board.tasks[0].media[0].url = imageUrl
    await h.query('UPDATE secretary_workspaces SET board=$3 WHERE tenant_id=$1 AND user_id=$2', [
      h.tenant,
      h.alice,
      JSON.stringify(board),
    ])
    bytes = Buffer.from('<html><script>alert(1)</script></html>')
    assert.equal((await h.request('GET', path)).statusCode, 502)
    bytes = Buffer.alloc(6 * 1024 * 1024 + 1)
    assert.equal((await h.request('GET', path)).statusCode, 502)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
