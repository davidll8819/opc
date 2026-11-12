import test from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './helpers/archive-api-fixture.mjs'

test('recycle: private, reversible, quota includes trash, referenced results protected', async () => {
  const h = await setup()
  try {
    const upload = await h.request('POST', '/files', { name: 'recycle.txt', mime: 'text/plain', content: Buffer.from('fixture').toString('base64') })
    assert.equal(upload.statusCode, 200)
    const id = upload.json().id, path = `/files/${id}`
    assert.equal((await h.request('POST', `${path}/trash`, {}, h.bob)).statusCode, 404)
    assert.equal((await h.request('POST', `${path}/purge`, { confirm: '永久删除' })).statusCode, 409)
    assert.equal((await h.request('POST', `${path}/trash`, {})).statusCode, 200)
    assert.equal((await h.request('GET', `${path}/download`)).statusCode, 404)
    assert.equal((await h.request('GET', '/files')).json().items.length, 0)
    const storage = (await h.request('GET', '/files/storage')).json()
    assert.equal(storage.used, 7); assert.equal(storage.trash, 7)
    assert.equal((await h.request('POST', `${path}/restore`, {})).statusCode, 200)
    assert.equal((await h.request('GET', `${path}/download`)).body, 'fixture')
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [h.tenant, h.alice, JSON.stringify({ tasks: [{ archiveFileId: id }], messages: [], batches: [] })])
    assert.equal((await h.request('POST', `${path}/trash`, {})).statusCode, 409)
    assert.equal((await h.request('GET', '/files/storage')).json().items[0].protected, true)
    await h.query('DELETE FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [h.tenant, h.alice])
    await h.request('POST', `${path}/trash`, {})
    assert.equal((await h.request('POST', `${path}/purge`, {})).statusCode, 400)
    assert.equal((await h.request('POST', `${path}/purge`, { confirm: '永久删除' })).statusCode, 200)
    assert.equal((await h.request('GET', '/files/storage')).json().used, 0)
  } finally { await h.close() }
})
