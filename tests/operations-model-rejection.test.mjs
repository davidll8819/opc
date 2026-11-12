import test from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './helpers/archive-api-fixture.mjs'
import { personalToken } from './helpers/personal-token.mjs'

test('runtime parameter errors survive HTTP routing, never fallback, and release token reservations', async () => {
  const bridgeSecret = 'synthetic-bridge-secret'
  const h = await setup(undefined, { operationsDriver: { binding: async tenantId => ({ tenantId, bridgeSecret }) } })
  try {
    const settings = (await h.request('GET', '/operations/settings')).json().policy
    settings.tiers.strong = 'claude-test'
    settings.tiers.cheap = 'claude-fallback-must-not-run'
    settings.departments.content_ops.tier = 'strong'
    settings.departments.content_ops.fallback = 'cheap'
    assert.equal((await h.request('PUT', '/operations/settings', { policy: settings })).statusCode, 200)
    for (const status of [400, 422]) {
      h.setAnswer(() => Response.json({ error: { message: 'Invalid temperature, private prompt and secret-token', param: 'temperature' } }, { status }))
      const before = h.requests.length
      const response = await h.app.inject({
        method: 'POST',
        url: `/integrations/model-gateway/${h.tenant}/api/anthropic/v1/messages`,
        headers: { authorization: `Bearer ${await personalToken(bridgeSecret, h.tenant, h.alice)}` },
        payload: { model: 'office-content-ops', messages: [{ role: 'user', content: 'Fixture' }], max_tokens: 256, stream: true },
      })
      assert.equal(response.statusCode, status, response.body)
      assert.match(response.json().error, /字段：temperature/)
      assert.doesNotMatch(response.body, /private prompt|secret-token/)
      assert.equal(h.requests.length, before + 1, 'a parameter rejection must never invoke fallback')
      assert.equal(h.requests.at(-1).model, 'claude-test')
    }
    const calls = (await h.query('SELECT state FROM billing_calls WHERE tenant_id=$1', [h.tenant])).rows
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.state === 'rejected'))
    const reservations = (await h.query('SELECT state FROM model_requests WHERE tenant_id=$1', [h.tenant])).rows
    assert.equal(reservations.length, 2)
    assert.ok(reservations.every(call => call.state === 'rejected'))
  } finally { await h.close() }
})
