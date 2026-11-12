import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { beginBilling, finishBilling, amount, safeReceipt } from '../apps/api/src/billing.mjs'
const price = {
  model: 'archive-test-model',
  input: '1000000',
  output: '2000000',
  saleInput: '3000000',
  saleOutput: '4000000',
  reference: '合同测试-001',
}
const ctx = (h) => ({ tenantId: h.tenant, userId: h.alice })
const begin = (h) =>
  beginBilling(h.pool, ctx(h), {
    department: 'archive',
    model: price.model,
    input: 100,
    output: 50,
  })
const ok = (r) => {
  assert.equal(r.statusCode, 200, r.body)
  return r.json()
}
test('billing uses integer arithmetic and rejects credential-shaped receipt identifiers', () => {
  assert.equal(amount(1, 1, 1, 1), '1')
  assert.equal(amount(100, 50, 1000000, 2000000), '200')
  assert.equal(safeReceipt('req-123'), 'req-123')
  assert.equal(safeReceipt('Bearer synthetic'), null)
  assert.equal(safeReceipt('sk-synthetic'), null)
})
test('gateway meters actual usage with immutable price versions and role-scoped history', async () => {
  const h = await setup()
  try {
    const first = ok(await h.request('POST', '/billing/prices', price)).id
    h.setAnswer(
      () =>
        new Response(
          JSON.stringify({
            id: 'req-test-1',
            choices: [{ message: { content: '测试' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )
    ok(await h.request('POST', '/departments/archive/messages', { prompt: '只使用模拟服务' }))
    let rows = ok(await h.request('GET', '/billing/calls')).calls
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cost_microusd, '50')
    assert.equal(rows[0].sale_microusd, '110')
    assert.equal(rows[0].price_id, first)
    assert.equal(rows[0].provider_request_id, 'req-test-1')
    ok(await h.request('POST', '/billing/prices', { ...price, input: '9000000' }))
    rows = ok(await h.request('GET', '/billing/calls')).calls
    assert.equal(rows[0].cost_microusd, '50')
    assert.equal(rows[0].price_id, first)
    assert.equal(ok(await h.request('GET', '/billing/calls', undefined, h.bob)).calls.length, 0)
    assert.equal(
      ok(await h.request('GET', `/api/tenants/${h.other}/billing/calls`)).calls.length,
      0,
    )
    assert.equal((await h.request('POST', '/billing/prices', price, h.bob)).statusCode, 403)
    assert.equal(ok(await h.request('GET', '/billing')).summary.calls, 1)
    ok(await h.request('POST', '/departments/archive/messages', { prompt: '成员模拟调用' }, h.bob))
    const member = ok(await h.request('GET', '/billing/calls', undefined, h.bob)).calls[0]
    assert.equal(member.cost_microusd, null)
    assert.equal(member.price_id, null)
    assert.equal(member.rate_snapshot.input, undefined)
    assert.equal(member.rate_snapshot.saleInput, price.saleInput)
  } finally {
    await h.close()
  }
})
test('budget serializes parallel reservations, settles once, and retains unknown charges', async () => {
  const h = await setup()
  try {
    ok(await h.request('POST', '/billing/prices', price))
    ok(await h.request('POST', '/billing/limit', { enabled: true, daily: '250' }))
    const results = await Promise.allSettled([begin(h), begin(h)])
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1)
    assert.equal(results.find((x) => x.status === 'rejected').reason.statusCode, 429)
    const id = results.find((x) => x.status === 'fulfilled').value
    await finishBilling(h.pool, ctx(h), id, 'unknown')
    await finishBilling(h.pool, ctx(h), id, 'completed', { input: 1, output: 1 })
    const item = ok(await h.request('GET', '/billing/calls')).calls[0]
    assert.equal(item.state, 'unknown')
    assert.equal(item.cost_microusd, null)
    assert.equal(ok(await h.request('GET', '/billing')).today.reserved, '200')
    await assert.rejects(begin(h), (e) => e.statusCode === 409)
    ok(
      await h.request('POST', '/billing/reviews', {
        callId: id,
        upstream: '125',
        reference: '上游账单-001',
      }),
    )
    assert.equal(ok(await h.request('GET', '/billing')).today.used, '125')
    assert.equal(ok(await h.request('GET', '/billing')).summary.known_cost, '125')
    assert.equal(ok(await h.request('GET', '/billing')).summary.unpriced, 0)
    assert.equal(ok(await h.request('GET', '/billing')).today.reserved, '0')
    await assert.rejects(begin(h), (e) => e.statusCode === 429)
    assert.equal(
      (
        await h.request('POST', '/billing/reviews', {
          callId: id,
          upstream: '0',
          reference: '改写',
        })
      ).statusCode,
      409,
    )
    assert.equal(
      (await h.query('SELECT state FROM billing_calls WHERE id=$1', [id])).rows[0].state,
      'unknown',
    )
  } finally {
    await h.close()
  }
})
test('test payment simulator is unavailable outside the isolated test environment', async () => {
  const h = await setup(undefined, { env: { NODE_ENV: 'production' } })
  try {
    assert.equal(ok(await h.request('GET', '/billing')).testOrdersEnabled, false)
    assert.equal(
      (
        await h.request('POST', '/billing/test-orders', {
          requestId: randomUUID(),
          amount: '1000000',
        })
      ).statusCode,
      404,
    )
    assert.equal((await h.request('GET', '/billing/test-orders')).statusCode, 404)
  } finally {
    await h.close()
  }
})
test('missing price stops upstream calls; disabling limit preserves unpriced usage and rejects secret references', async () => {
  const h = await setup()
  try {
    ok(await h.request('POST', '/billing/limit', { enabled: true, daily: '100000' }))
    assert.equal(
      (await h.request('POST', '/departments/archive/messages', { prompt: '不应该发出' }))
        .statusCode,
      409,
    )
    assert.equal(h.requests.length, 0)
    ok(await h.request('POST', '/billing/limit', { enabled: false, daily: '100000' }))
    ok(await h.request('POST', '/departments/archive/messages', { prompt: '模拟调用' }))
    const summary = ok(await h.request('GET', '/billing')).summary
    assert.equal(summary.unpriced, 1)
    assert.equal(summary.known_cost, '0')
    assert.equal(
      (await h.request('POST', '/billing/prices', { ...price, reference: 'Bearer synthetic' }))
        .statusCode,
      400,
    )
    ok(await h.request('POST', '/billing/prices', price))
    ok(await h.request('POST', '/billing/limit', { enabled: true, daily: '100000' }))
    await assert.rejects(
      beginBilling(h.pool, ctx(h), { model: price.model, department: 'archive', kind: 'image' }),
      (e) => e.statusCode === 409,
    )
  } finally {
    await h.close()
  }
})
test('legacy calls remain immutable; evidence reconciliation is tenant-scoped and leaves token reservations untouched', async () => {
  const h = await setup()
  try {
    const id = randomUUID()
    await h.query(
      "INSERT INTO model_requests(id,tenant_id,user_id,day,department,model,reserved_tokens,state) VALUES($1,$2,$3,current_date,'archive','old-model',100,'unknown')",
      [id, h.tenant, h.alice],
    )
    const before = (await h.query('SELECT * FROM model_requests WHERE id=$1', [id])).rows[0]
    const item = ok(await h.request('GET', '/billing/calls')).calls[0]
    assert.equal(item.legacy, true)
    assert.equal(item.cost_microusd, null)
    assert.equal(
      (
        await h.request('POST', `/api/tenants/${h.other}/billing/reviews`, {
          callId: id,
          upstream: '5',
          reference: '凭证1',
        })
      ).statusCode,
      404,
    )
    assert.equal(
      (
        await h.request(
          'POST',
          '/billing/reviews',
          { callId: id, upstream: '5', reference: '凭证1' },
          h.bob,
        )
      ).statusCode,
      403,
    )
    ok(
      await h.request('POST', '/billing/reviews', {
        callId: id,
        upstream: '5',
        reference: '凭证1',
      }),
    )
    assert.deepEqual(
      (await h.query('SELECT * FROM model_requests WHERE id=$1', [id])).rows[0],
      before,
    )
    assert.equal(ok(await h.request('GET', '/billing/calls')).calls[0].reviewed_cost, '5')
  } finally {
    await h.close()
  }
})
test('test orders: duplicate creates, payment events, refunds and late payments cannot duplicate credit', async () => {
  const h = await setup()
  try {
    const payload = { requestId: randomUUID(), amount: '1000000' }
    const creates = await Promise.all([
      h.request('POST', '/billing/test-orders', payload),
      h.request('POST', '/billing/test-orders', payload),
    ])
    const id = ok(creates[0]).id
    assert.equal(ok(creates[1]).id, id)
    assert.equal(
      (await h.request('POST', '/billing/test-orders', { ...payload, amount: '2' })).statusCode,
      409,
    )
    const event = (event, amount = '1000000') =>
      h.request('POST', `/billing/test-orders/${id}/events`, { event, amount })
    assert.equal((await event('refunded')).statusCode, 409)
    assert.equal((await event('paid', '2')).statusCode, 409)
    const payments = await Promise.all([event('paid'), event('paid')])
    payments.forEach(ok)
    ok(await event('refunded'))
    ok(await event('refunded'))
    assert.equal(ok(await event('paid')).state, 'refunded')
    assert.equal((await h.query('SELECT count(*)::int n FROM billing_test_events')).rows[0].n, 2)
    assert.equal(ok(await h.request('GET', '/billing/test-orders')).orders[0].state, 'refunded')
    assert.equal((await h.request('POST', '/billing/test-orders', payload, h.bob)).statusCode, 403)
    assert.equal(
      (
        await h.request('POST', `/api/tenants/${h.other}/billing/test-orders/${id}/events`, {
          event: 'paid',
          amount: '1000000',
        })
      ).statusCode,
      404,
    )
    assert.equal(
      (await h.query('SELECT subscription_status FROM tenants WHERE id=$1', [h.tenant])).rows[0]
        .subscription_status,
      'none',
    )
  } finally {
    await h.close()
  }
})
test('usage pages preserve per-task association, pagination and safe export fields', async () => {
  const h = await setup()
  try {
    const taskId = randomUUID(),
      c = { ...ctx(h), taskId, billingStep: '资料对比' }
    const id = await beginBilling(h.pool, c, {
      model: 'test-image',
      department: 'design',
      kind: 'image',
    })
    await finishBilling(h.pool, c, id, 'completed', undefined, 'img-request-1')
    const result = ok(await h.request('GET', `/billing/calls?task=${taskId}`))
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].task_id, taskId)
    assert.equal(result.calls[0].kind, 'image')
    assert.equal(result.calls[0].cost_microusd, null)
    assert.equal(ok(await h.request('GET', `/billing/calls?task=${randomUUID()}`)).calls.length, 0)
    assert.equal((await h.request('GET', '/billing/calls?offset=-1')).statusCode, 400)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-key|encrypted_config/)
  } finally {
    await h.close()
  }
})
test('task limits apply across days independently and reject unlinked video tasks', async () => {
  const h = await setup()
  try {
    const taskId = randomUUID(),
      video = randomUUID()
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [
      h.tenant,
      h.alice,
      {
        tasks: [
          { id: taskId, dept: 'review-agent' },
          { id: video, dept: 'app-agent' },
        ],
      },
    ])
    ok(await h.request('POST', '/billing/prices', price))
    ok(await h.request('POST', '/billing/task-limits', { taskId, amount: '200', enabled: true }))
    assert.equal(
      (
        await h.request('POST', '/billing/task-limits', {
          taskId: video,
          amount: '200',
          enabled: true,
        })
      ).statusCode,
      409,
    )
    assert.equal(
      (
        await h.request('POST', '/billing/task-limits', {
          taskId: randomUUID(),
          amount: '200',
          enabled: true,
        })
      ).statusCode,
      404,
    )
    const c = { ...ctx(h), taskId },
      call = () =>
        beginBilling(h.pool, c, {
          model: price.model,
          department: 'archive',
          input: 100,
          output: 50,
        })
    const id = await call()
    await finishBilling(h.pool, c, id, 'completed', { input: 100, output: 50 })
    await h.query('UPDATE billing_calls SET day=day-1 WHERE id=$1', [id])
    await assert.rejects(call(), (e) => e.statusCode === 429)
    await begin(h) // Another task/daily call has no task cap.
    assert.equal(ok(await h.request('GET', '/billing/task-limits')).limits.length, 1)
    assert.equal((await h.request('GET', '/billing/task-limits', undefined, h.bob)).statusCode, 403)
  } finally {
    await h.close()
  }
})
