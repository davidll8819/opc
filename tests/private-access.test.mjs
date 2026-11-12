import test from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { privateAccessPolicy, validatePrivateAccess } from '../apps/api/src/private-access.mjs'
const origin = 'https://test-mac.tail-test.ts.net',
  login = 'owner@example.test'
const env = {
  NODE_ENV: 'test',
  AUTH_MODE: 'local',
  APP_ORIGIN: 'http://localhost:3000',
  LOCAL_EMAIL: 'owner@local.test',
  LOCAL_PASSWORD_SALT: 'test-only-salt',
  LOCAL_PASSWORD_HASH: scryptSync('test-only-password', 'test-only-salt', 32).toString('hex'),
  PRIVATE_APP_ORIGIN: origin,
  PRIVATE_TAILSCALE_LOGIN: login,
}

test('private access refuses broad, insecure or production configuration', () => {
  for (const value of [
    'http://test-mac.tail-test.ts.net',
    'https://evil.test',
    'https://test-mac.tail-test.ts.net/',
    'https://a.b.ts.net/path',
    'https://a.b.ts.net:444',
    'https://user:pass@a.b.ts.net',
    'https://a.b.ts.net.evil.test',
  ])
    assert.throws(() => validatePrivateAccess({ origin: value, login }))
  assert.throws(() => privateAccessPolicy({ ...env, PRIVATE_TAILSCALE_LOGIN: '' }))
  assert.throws(() => privateAccessPolicy({ ...env, NODE_ENV: 'production' }))
  assert.throws(() => privateAccessPolicy({ ...env, APP_ORIGIN: origin }))
  assert.equal(privateAccessPolicy({}).config, null)
})

test('phone access requires private identity and password, uses secure bound cookies and shares the local user', async () => {
  const h = await setup(undefined, { env })
  try {
    await h.query('UPDATE users SET subject=$2,email=$3 WHERE id=$1', [
      h.alice,
      'local:owner@local.test',
      'owner@local.test',
    ])
    const local = (method, url, payload, headers = {}) =>
      h.app.inject({
        method,
        url,
        payload,
        remoteAddress: '127.0.0.1',
        headers: { host: 'localhost:3000', origin: env.APP_ORIGIN, ...headers },
      })
    const phone = (method, url, payload, headers = {}, peer = '127.0.0.1') =>
      h.app.inject({
        method,
        url,
        payload,
        remoteAddress: peer,
        headers: {
          host: 'test-mac.tail-test.ts.net',
          origin,
          'tailscale-user-login': login,
          ...headers,
        },
      })
    const body = { email: env.LOCAL_EMAIL, password: 'test-only-password' }
    const desk = await local('POST', '/auth/local', body)
    assert.equal(desk.statusCode, 200, desk.body)
    const deskCookie = desk.cookies[0],
      deskHeaders = {
        cookie: `${deskCookie.name}=${deskCookie.value}`,
        'x-csrf-token': desk.json().csrf,
      }
    assert.equal(deskCookie.name, 'office_session')
    for (const headers of [
      { 'tailscale-user-login': '' },
      { 'tailscale-user-login': 'stranger@example.test' },
      { origin: 'https://evil.test' },
      { host: 'wrong.tail-test.ts.net' },
    ])
      assert.equal((await phone('POST', '/auth/local', body, headers)).statusCode, 403)
    assert.equal((await phone('POST', '/auth/local', body, {}, '100.64.0.10')).statusCode, 403)
    assert.equal((await phone('GET', '/api/me')).statusCode, 401)
    assert.equal(
      (await phone('POST', '/auth/local', { ...body, password: 'incorrect' })).statusCode,
      401,
    )
    const signedIn = await phone('POST', '/auth/local', body)
    assert.equal(signedIn.statusCode, 200, signedIn.body)
    assert.equal(signedIn.json().user.id, h.alice)
    const cookie = signedIn.cookies[0]
    assert.equal(cookie.name, '__Host-office_private')
    assert.equal(cookie.secure, true)
    assert.equal(cookie.httpOnly, true)
    assert.equal(cookie.sameSite, 'Strict')
    const phoneHeaders = {
      cookie: `${cookie.name}=${cookie.value}`,
      'x-csrf-token': signedIn.json().csrf,
    }
    assert.equal(
      (await phone('GET', '/api/me', undefined, phoneHeaders)).json().user.id,
      desk.json().user.id,
    )
    assert.equal(
      (
        await phone('GET', '/api/me', undefined, {
          ...phoneHeaders,
          'tailscale-user-login': 'stranger@example.test',
        })
      ).statusCode,
      403,
    )
    assert.equal(
      (
        await phone('GET', '/api/me', undefined, {
          cookie: `__Host-office_private=${deskCookie.value}`,
        })
      ).statusCode,
      401,
    )
    assert.equal(
      (await local('GET', '/api/me', undefined, { cookie: `office_session=${cookie.value}` }))
        .statusCode,
      401,
    )
    assert.equal(
      (await phone('POST', `${h.base}/secretary`, {}, { ...phoneHeaders, 'x-csrf-token': 'wrong' }))
        .statusCode,
      403,
    )
    const created = await phone(
      'POST',
      `${h.base}/secretary`,
      {
        revision: 0,
        today: '2026-11-04',
        action: { type: 'send', intent: 'plan', language: 'zh', text: '隔离测试：手机整理资料' },
      },
      phoneHeaders,
    )
    assert.equal(created.statusCode, 200, created.body)
    assert.deepEqual(
      (await local('GET', `${h.base}/secretary`, undefined, deskHeaders)).json().board,
      created.json().board,
    )
    const config = (await local('GET', '/public/config')).json()
    assert.equal(config.privateOrigin, origin)
    assert.ok(!JSON.stringify(config).includes(login))
    const out = await phone('POST', '/auth/logout', {}, phoneHeaders)
    assert.equal(out.statusCode, 200, out.body)
    assert.equal(out.json().redirect, origin)
    assert.equal((await phone('GET', '/api/me', undefined, phoneHeaders)).statusCode, 401)
    assert.equal((await local('GET', '/api/me', undefined, deskHeaders)).statusCode, 200)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})
