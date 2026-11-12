import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'

test('draft API restores unfinished edits/music, isolates owners and rejects stale tabs', async () => {
  const h = await setup(),
    task = 'd'.repeat(24),
    path = `/operations/tasks/${task}/edit-draft`
  try {
    await h.query(
      "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'draft-test','submitted',$4)",
      [randomUUID(), h.tenant, h.alice, task],
    )
    const content = {
      draft: {
        title: '',
        segments: [{ url: 'https://example.test/input.mp4', start: 2, end: 1 }],
        subtitles: [{ start: 2, end: 1, text: '' }],
        ratio: '16:9',
        resolution: '1080p',
        fit: 'contain',
        originalVolume: 1,
        musicVolume: 0.2,
      },
      music: { name: 'music.wav', base64: Buffer.from('test audio').toString('base64') },
      formatInitialized: true,
    }
    assert.deepEqual((await h.request('GET', path)).json(), { content: null, revision: 0 })
    const save = await h.request('PUT', path, { revision: 0, content })
    assert.equal(save.statusCode, 200)
    assert.equal(save.json().revision, 1)
    assert.deepEqual((await h.request('GET', path)).json().content, content)
    assert.equal(
      (await h.request('PUT', path, { revision: 0, content })).statusCode,
      200,
      'lost response retry is idempotent',
    )
    assert.equal(
      (
        await h.request('PUT', path, {
          revision: 0,
          content: { ...content, draft: { ...content.draft, title: 'stale' } },
        })
      ).statusCode,
      409,
    )
    assert.equal((await h.request('GET', path, undefined, h.bob)).statusCode, 404)
    assert.equal((await h.request('PUT', path, { revision: 1, content }, h.bob)).statusCode, 403)
    assert.equal((await h.app.inject({ url: h.base + path })).statusCode, 401)
    assert.equal(
      (
        await h.request('PUT', path, {
          revision: 1,
          content: { ...content, music: { name: 'bad', base64: '###' } },
        })
      ).statusCode,
      400,
    )
    const second = await h.request('PUT', path, {
      revision: 1,
      content: { ...content, draft: { ...content.draft, title: 'new' } },
    })
    assert.equal(second.json().revision, 2)
    assert.equal((await h.request('GET', path)).json().content.draft.title, 'new')
  } finally {
    await h.close()
  }
})
