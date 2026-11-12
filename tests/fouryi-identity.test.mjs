import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { createFouryiIdentity, fouryiEnvironment } from '../apps/api/src/fouryi-identity.mjs'
import { productionChecks } from '../apps/api/src/startup-checks.mjs'
const key = 'a'.repeat(64), host = 'archive.test'
const env = { AUTH_MODE: '4yi', APP_ORIGIN: `https://${host}`, XCLAW_APP_HOSTNAME: host, FOURYI_ROUTER_IDENTITY_KEY: key, FOURYI_PORTAL_ORIGIN: 'https://platform.test' }
function signed(method, url, bytes = Buffer.alloc(0), { user = 'platform-alice', org = 'org-a', time = String(Date.now()), nonce = randomBytes(16).toString('hex') } = {}) {
  const bodyHash = createHash('sha256').update(bytes).digest('hex')
  const signature = createHmac('sha256', key).update(JSON.stringify(['v1', host, method, url, user, org, time, nonce, bodyHash])).digest('hex')
  return { 'x-xclaw-user-id': user, 'x-xclaw-owner-org-id': org, 'x-xclaw-hostname': host,
    'x-xclaw-identity-time': time, 'x-xclaw-identity-nonce': nonce, 'x-xclaw-identity-signature': signature }
}
test('4yi verifies exact bytes, path/query, method, host and identity; rejects replay across verifier instances', async () => {
  const values = new Set(), cache = { set: async k => { if (values.has(k)) return null; values.add(k); return 'OK' } }
  const a = createFouryiIdentity({ env, cache }), b = createFouryiIdentity({ env, cache })
  const bytes = Buffer.from('{ "name": "测试" }'), req = { method: 'POST', url: '/api/tenants?x=1', headers: signed('POST', '/api/tenants?x=1', bytes) }
  assert.deepEqual(await a.verify(req, bytes), { user: 'platform-alice', org: 'org-a' })
  await assert.rejects(b.verify(req, bytes), { statusCode: 401 })
  for (const change of ['bytes', 'method', 'url', 'host', 'user', 'org', 'expiry']) {
    const r = { ...req, headers: signed(req.method, req.url, bytes) }; let content = bytes
    if (change === 'bytes') content = Buffer.from('{"name":"测试"}')
    if (change === 'method') r.method = 'PUT'
    if (change === 'url') r.url = '/api/tenants?x=2'
    if (change === 'host') r.headers['x-xclaw-hostname'] = 'other.test'
    if (change === 'user') r.headers['x-xclaw-user-id'] = 'platform-bob'
    if (change === 'org') r.headers['x-xclaw-owner-org-id'] = 'org-b'
    if (change === 'expiry') r.headers = signed(req.method, req.url, bytes, { time: String(Date.now() - 60000) })
    await assert.rejects(a.verify(r, content), { statusCode: 401 }, change)
  }
})
test('4yi configuration fails closed and production still requires database/media protection', async () => {
  assert.equal(fouryiEnvironment({ ...env, APP_ORIGIN: undefined }).APP_ORIGIN, `https://${host}`)
  assert.throws(() => fouryiEnvironment({ ...env, APP_ORIGIN: 'http://localhost:3000' }))
  assert.throws(() => fouryiEnvironment({ ...env, XCLAW_APP_HOSTNAME: 'evil.test/path' }))
  for (const invalid of ['app..test', 'app.-test', 'app.test-', `${'a'.repeat(64)}.test`])
    assert.throws(() => fouryiEnvironment({ ...env, XCLAW_APP_HOSTNAME: invalid }))
  assert.throws(() => createFouryiIdentity({ env: { ...env, FOURYI_ROUTER_IDENTITY_KEY: '' } }))
  const checks = await productionChecks({ ...env, NODE_ENV: 'production' })
  for (const id of ['formal_auth', 'fouryi_identity_key', 'fouryi_hostname', 'fouryi_portal']) assert.equal(checks.find(c => c.id === id).ok, true)
  assert.equal(checks.find(c => c.id === 'redis_tls').ok, false)
  assert.equal(checks.find(c => c.id === 'config_encryption').ok, false)
})
test('signed platform users create their own spaces; forged headers, other orgs and CSRF cannot cross scope', async () => {
  const h = await setup(undefined, { env })
  const call = (method, url, body, identity, csrf) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    return h.app.inject({ method, url, payload, headers: { ...signed(method, url, payload ? Buffer.from(payload) : Buffer.alloc(0), identity),
      origin: env.APP_ORIGIN, ...(payload ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) } })
  }
  try {
    assert.equal((await h.app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200)
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/me', headers: { 'x-xclaw-user-id': 'platform-alice', 'x-xclaw-owner-org-id': 'org-a' } })).statusCode, 401)
    const response = await call('GET', '/api/me'); assert.equal(response.statusCode, 200, response.body)
    const me = response.json(); assert.deepEqual(me.tenants, [])
    assert.equal((await call('GET', '/api/me')).json().user.id, me.user.id)
    const created = await call('POST', '/api/tenants', { name: '4yi isolated workspace' }, undefined, me.csrf)
    assert.equal(created.statusCode, 201, created.body)
    const id = created.json().id
    assert.equal((await call('GET', '/api/me')).json().tenants[0].id, id)
    const other = (await call('GET', '/api/me', undefined, { org: 'org-b' })).json()
    assert.notEqual(other.user.id, me.user.id); assert.deepEqual(other.tenants, [])
    assert.equal((await call('GET', `/api/tenants/${id}/members`, undefined, { org: 'org-b' })).statusCode, 403)
    const colleague = (await call('GET', '/api/me', undefined, { user: 'platform-bob' })).json()
    assert.notEqual(colleague.user.id, me.user.id); assert.deepEqual(colleague.tenants, [])
    assert.equal((await call('GET', `/api/tenants/${id}/members`, undefined, { user: 'platform-bob' })).statusCode, 403)
    const bytes = Buffer.from('{"name":"signed name"}')
    const tampered = await h.app.inject({ method: 'POST', url: '/api/tenants', payload: '{"name":"changed name"}',
      headers: { ...signed('POST', '/api/tenants', bytes), 'content-type': 'application/json', origin: env.APP_ORIGIN, 'x-csrf-token': me.csrf } })
    assert.equal(tampered.statusCode, 401)
    assert.equal((await call('POST', '/api/tenants', { name: 'Bad CSRF' }, undefined, other.csrf)).statusCode, 403)
    const config = (await call('GET', '/public/config')).json(); assert.equal(config.authMode, '4yi')
    assert.equal(config.platformOrigin, 'https://platform.test')
    assert.equal((await call('POST', '/auth/logout', {}, undefined, me.csrf)).json().redirect, 'https://platform.test')
    assert.equal((await call('POST', '/auth/local', { email: 'owner@local.test', password: 'not-a-real-password' })).statusCode, 404)
  } finally { await h.close() }
})
