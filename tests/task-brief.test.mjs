import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { captureTaskBrief, attachTaskBrief, taskBriefSchema } from '../apps/api/src/task-brief.mjs'
import { taskAttention } from '../packages/secretary/task-brief.mjs'
const brief = { project: '秋季产品', goal: '比较三家竞品', audience: '个体经营者', format: '对比表', acceptance: '结论附原始来源，缺口如实列出', budget: '不自动再次付费，不对外发布', materials: '仅用官方公开资料和我的附件' }
test('brief validates limits and preserves independent snapshots, attention excludes background work', () => {
  assert.throws(() => taskBriefSchema.parse({ goal: '' }))
  assert.throws(() => taskBriefSchema.parse({ ...brief, project: 'a'.repeat(81) }))
  assert.throws(() => taskBriefSchema.parse({ ...brief, tenantId: 'other' }))
  const captured = captureTaskBrief(brief), task = attachTaskBrief({ summary: '执行要求' }, captured)
  captured.goal = '后来的修改'
  assert.equal(task.briefSnapshot.goal, brief.goal)
  assert.ok(task.request.includes(brief.acceptance))
  for (const status of ['queued', 'working', 'authorized']) assert.equal(taskAttention({ status }), '')
  assert.ok(taskAttention({ status: 'blocked' }))
  assert.equal(taskAttention({ status: 'completed', engine: 'research-v1', dept: 'review-agent' }), '', 'legacy reports without a review action must not create unresolvable to-dos')
  assert.ok(taskAttention({ status: 'completed', engine: 'research-v1', dept: 'review-agent', quality: { status: 'partial' } }))
  assert.equal(taskAttention({ status: 'completed', engine: 'research-v1', dept: 'review-agent', quality: { acceptance: { at: 'now' } } }), '')
})
test('real API saves brief, retains it through edits/dispatch, isolates users, and execution receives it', async () => {
  const h = await setup()
  try {
    h.setAnswer(() => JSON.stringify({ reply: '请确认分工', tasks: [{ title: '整理竞品', dept: 'new-agent-7', due: '2026-10-25', brief: '模型的简短分工' }] }))
    const body = { revision: 0, text: '按需求单安排任务', language: 'zh', intent: 'plan', brief }
    const response = await h.request('POST', '/secretary/chat', body)
    assert.equal(response.statusCode, 200, response.body)
    let saved = response.json(), task = saved.board.tasks[0]
    assert.ok(h.requests.at(-1).messages.at(-1).content.includes(brief.materials))
    assert.equal(task.briefSnapshot.goal, brief.goal)
    assert.ok(task.request.includes(brief.budget))
    const original = structuredClone(task.briefSnapshot)
    const edited = await h.request('POST', '/secretary', { revision: saved.revision, today: '2026-10-24', action: { type: 'edit', batchId: task.batchId, tasks: [{ id: task.id, title: '修订标题', dept: task.dept, due: '2026-10-26' }] } })
    assert.equal(edited.statusCode, 200, edited.body)
    saved = edited.json()
    assert.deepEqual(saved.board.tasks[0].briefSnapshot, original)
    const dispatch = await h.request('POST', '/secretary', { revision: saved.revision, today: '2026-10-24', action: { type: 'dispatch', batchId: task.batchId } })
    assert.equal(dispatch.statusCode, 200, dispatch.body)
    assert.deepEqual(dispatch.json().board.tasks[0].briefSnapshot, original)
    assert.equal((await h.request('GET', '/secretary', undefined, h.bob)).json().board.tasks.length, 0)
    assert.equal((await h.request('POST', '/secretary/chat', body, h.bob)).statusCode, 403)
    const reread = await h.request('GET', '/secretary')
    assert.deepEqual(reread.json().board.tasks[0].briefSnapshot, original)
    h.setAnswer(() => '已按需求完成整理，证据缺口保留。')
    const run = await h.request('POST', `/secretary/tasks/${task.id}/run`, {})
    assert.equal(run.statusCode, 200, run.body)
    assert.ok(h.requests.at(-1).messages.some(m => m.content.includes(brief.acceptance)))
    assert.equal((await h.request('POST', '/secretary/chat', { ...body, brief: { ...brief, audience: 'x'.repeat(401) } })).statusCode, 400)
  } finally { await h.close() }
})
test('clarification-to-plan keeps the submitted brief without bleeding into unrelated requests', async () => {
  const h = await setup()
  try {
    h.setAnswer(() => JSON.stringify({ reply: '还需要确认范围', tasks: [] }))
    let saved = (await h.request('POST', '/secretary/chat', { revision: 0, text: '先讨论', language: 'zh', intent: 'plan', brief })).json()
    h.setAnswer(() => JSON.stringify({ reply: '安排如下', tasks: [{ title: '后续任务', dept: 'new-agent-7', due: '2026-10-25' }] }))
    saved = (await h.request('POST', '/secretary/chat', { revision: saved.revision, text: '整理为任务', language: 'zh', intent: 'plan', requireTasks: true })).json()
    assert.equal(saved.board.tasks[0].briefSnapshot.project, brief.project)
    const response = await h.request('POST', '/secretary/chat', { revision: saved.revision, text: '另一件工作', language: 'zh', intent: 'plan' })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().board.tasks.at(-1).briefSnapshot, undefined)
  } finally { await h.close() }
})
