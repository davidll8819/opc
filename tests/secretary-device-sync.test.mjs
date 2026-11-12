import test from 'node:test'
import assert from 'node:assert/strict'
import { hash } from '../apps/api/src/auth.mjs'
import { setup } from './helpers/archive-api-fixture.mjs'

test('independent phone and desktop sessions share records, reject stale writes and keep user/tenant isolation', async () => {
  const h = await setup()
  try {
    const phoneSession = 'synthetic-phone-session', phoneCsrf = 'synthetic-phone-csrf'
    await h.cache.set(`session:${hash(phoneSession)}`, JSON.stringify({ userId: h.alice, email: 'phone@test.invalid', csrf: phoneCsrf }))
    const phone = (method, payload, origin = 'https://archive.test') => h.app.inject({
      method, url: `${h.base}/secretary`, payload,
      headers: { cookie: `office_session=${phoneSession}`, origin, 'x-csrf-token': phoneCsrf },
    })
    const initial = (await phone('GET')).json()
    assert.equal(initial.revision, 0)
    const payload = { revision: initial.revision, today: '2026-11-04', action: { type: 'send', intent: 'plan', language: 'zh', text: '隔离测试：整理资料，先准备草稿' } }
    const desktopWrite = await h.request('POST', '/secretary', payload)
    assert.equal(desktopWrite.statusCode, 200, desktopWrite.body)
    const phoneRead = await phone('GET')
    assert.deepEqual(phoneRead.json().board, desktopWrite.json().board)
    assert.equal(phoneRead.json().revision, desktopWrite.json().revision)
    const stale = await phone('POST', payload)
    assert.equal(stale.statusCode, 409)
    const current = phoneRead.json()
    const phoneWrite = await phone('POST', { ...payload, revision: current.revision, action: { ...payload.action, text: '隔离测试：手机补充资料整理需求' } })
    assert.equal(phoneWrite.statusCode, 200, phoneWrite.body)
    assert.deepEqual((await h.request('GET', '/secretary')).json().board, phoneWrite.json().board)
    assert.equal((await h.request('GET', '/secretary', undefined, h.bob)).json().board.messages.length, 0)
    assert.equal((await h.request('GET', `/api/tenants/${h.other}/secretary`)).json().board.messages.length, 0)
    assert.equal((await phone('POST', { ...payload, revision: phoneWrite.json().revision }, 'https://untrusted.test')).statusCode, 403)
    assert.equal((await h.app.inject({ method: 'GET', url: `${h.base}/secretary` })).statusCode, 401)
    assert.equal(h.requests.length, 0, 'device synchronization does not call a paid model')
    assert.equal((await h.query('SELECT count(*)::int n FROM task_jobs')).rows[0].n, 0)
  } finally { await h.close() }
})
