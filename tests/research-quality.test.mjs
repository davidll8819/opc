import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { validateCoverage, assessCoverage } from '../apps/api/src/research/quality.mjs'
import { productContext } from '../apps/api/src/product-context.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { setup } from './helpers/archive-api-fixture.mjs'
const outline = [{ id: 'R1', questions: ['价格与限额？'] }]
const pages = [{ id: 'S1', read: true, text: '真实原文提供某项功能介绍，但没有价格' }]
const valid = { id: 'R1Q1', status: 'covered', reason: '原文匹配', evidence: [{ sourceId: 'S1', quote: '真实原文提供某项功能介绍', kind: 'official' }] }
test('coverage rejects hallucinated excerpts, unread sources, duplicate and omitted questions', () => {
  assert.equal(validateCoverage({ questions: [valid] }, outline, pages)[0].status, 'covered')
  for (const questions of [[], [valid, valid], [{ ...valid, evidence: [{ sourceId: 'S2', quote: valid.evidence[0].quote }] }], [{ ...valid, evidence: [{ sourceId: 'S1', quote: '模型编造的价格每个月一百元' }] }]]) {
    assert.equal(validateCoverage({ questions }, outline, pages)[0].status, 'missing')
  }
  assert.equal(validateCoverage({ questions: [valid] }, outline, [{ ...pages[0], read: false }])[0].status, 'missing')
})
test('failed or truncated evidence check degrades to missing, never a clean bill of health', async () => {
  for (const call of [async () => { throw Error('provider') }, async () => ({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ questions: [valid] }) } }] })]) {
    const result = await assessCoverage({ call, outline, pages })
    assert.equal(result.questions[0].status, 'missing')
    assert.ok(result.issue)
  }
})
test('platform context uses authored facts and booleans, never model settings or credentials', () => {
  const policy = defaultPolicy()
  policy.sensitive = 'synthetic-sensitive-value'
  const before = JSON.stringify(policy)
  const context = productContext(policy)
  assert.match(context, /Wishtaday/)
  assert.match(context, /不证明服务在线/)
  assert.ok(!context.includes('synthetic-sensitive-value'))
  assert.equal(JSON.stringify(policy), before)
  assert.doesNotThrow(() => productContext(undefined))
})
test('review is tenant/user isolated; follow-up is idempotent and preserves original report and gaps', async () => {
  const h = await setup()
  try {
    const task = { id: randomUUID(), title: '原报告', request: '原需求', dept: 'review-agent', status: 'completed', engine: 'research-v1', summary: '不可覆盖的原报告', quality: { status: 'partial', questions: [{ id: 'R1Q1', status: 'missing' }] } }
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [h.tenant, h.alice, JSON.stringify({ tasks: [task], messages: [], batches: [] })])
    const path = `/research/tasks/${task.id}`
    assert.equal((await h.request('POST', path + '/accept', { acknowledgeGaps: false })).statusCode, 409)
    const accepted = await h.request('POST', path + '/accept', { acknowledgeGaps: true })
    assert.equal(accepted.statusCode, 200)
    assert.equal(accepted.json().board.tasks[0].quality.status, 'partial')
    assert.ok(accepted.json().board.tasks[0].quality.acceptance)
    assert.equal((await h.request('POST', path + '/accept', {}, h.bob)).statusCode, 403)
    assert.equal((await h.request('POST', `/api/tenants/${h.other}${path}/accept`, {})).statusCode, 404)
    const payload = { requestId: randomUUID(), feedback: '核查官方价格', acknowledgeCost: true }
    assert.equal((await h.request('POST', path + '/follow-up', { ...payload, acknowledgeCost: false })).statusCode, 400)
    const first = await h.request('POST', path + '/follow-up', payload)
    assert.equal(first.statusCode, 200, first.body)
    const second = await h.request('POST', path + '/follow-up', payload)
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().taskId, first.json().taskId)
    assert.equal(second.json().board.tasks.length, 2)
    assert.deepEqual(second.json().board.tasks[0], accepted.json().board.tasks[0])
    assert.equal(second.json().board.tasks[1].followUpOf, task.id)
    assert.equal((await h.query('SELECT count(*)::int AS n FROM task_jobs')).rows[0].n, 1)
    assert.equal((await h.request('POST', path + '/follow-up', { ...payload, feedback: '其他需求' })).statusCode, 409)
    assert.equal((await h.request('POST', path + '/follow-up', { ...payload, requestId: randomUUID() })).statusCode, 409)
  } finally { await h.close() }
})
