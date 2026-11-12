import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { emptyBrief } from '../packages/secretary/task-brief.mjs'
import { fillWorkflow, taskNotices, knowledgeContext } from '../apps/api/src/reuse.mjs'
import { currentTaskContext } from '../apps/api/src/secretary-preferences.mjs'
import { createDepartmentEngine } from '../apps/api/src/department-engine.mjs'
import { archiveQueryTerms } from '../apps/api/src/archive/search.mjs'

const memory = (title, project = '', content = '先给结论，再写证据') => ({
  kind: 'memory',
  title,
  project,
  enabled: true,
  body: { content, source: '用户明确确认的工作要求' },
})
const template = () => ({
  kind: 'template',
  title: '重复工作流程',
  project: '',
  enabled: true,
  body: {
    brief: { ...emptyBrief, project: '{{项目}}', goal: '{{目标}}', acceptance: '有出处' },
    steps: [
      { title: '准备材料', dept: 'new-agent-7', brief: '{{目标}}', dependsOn: [] },
      { title: '整理材料', dept: 'file-agent', brief: '按前序内容完成{{目标}}', dependsOn: [0] },
    ],
  },
})
const values = { 项目: '客户乙', 目标: '整理公开的产品规格' }
test('workflow substitution is literal, bounded, requires all parameters; notices track transitions', () => {
  const source = template().body
  const result = fillWorkflow(source, { ...values, 目标: '合法文字 $& <script>alert(1)</script>' })
  assert.equal(result.brief.goal, '合法文字 $& <script>alert(1)</script>')
  assert.deepEqual(result.steps[1].dependsOn, [0])
  assert.throws(() => fillWorkflow(source, { 项目: 'a' }))
  assert.throws(() => fillWorkflow(source, { ...values, extra: 'a' }))
  assert.throws(() => fillWorkflow(source, { ...values, 目标: 'a'.repeat(1100) }))
  const task = { id: 'task', title: '任务', status: 'blocked', executionNote: '需要补充' }
  const before = taskNotices({ tasks: [task] })[0].key
  assert.equal(taskNotices({ tasks: [task] })[0].key, before)
  assert.notEqual(taskNotices({ tasks: [{ ...task, status: 'completed' }] })[0].key, before)
})
test('long conversation task context retains recent and blocked tasks without cutting JSON', () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    title: '标题' + i,
    status: 'completed',
    summary: 'old '.repeat(20000),
  }))
  tasks[4].status = 'blocked'
  const summary = JSON.parse(currentTaskContext({ tasks }))
  assert.equal(summary.total, 100)
  assert.equal(summary.shown, 30)
  assert.ok(summary.tasks.some((t) => t.id === '99'))
  assert.ok(summary.tasks.some((t) => t.id === '4'))
  assert.ok(currentTaskContext({ tasks }).length < 16000)
})
test('curated retrieval synonyms cover ordinary questions without unrestricted expansion', () => {
  for (const [query, term] of [
    ['怎么退费', '退款'],
    ['顾客怎么开票', '发票'],
    ['背景音乐要求', '配乐'],
    ['报价多少', '价格'],
  ])
    assert.ok(archiveQueryTerms(query).includes(term))
  assert.ok(!archiveQueryTerms('猫咪摄影').includes('退款'))
  assert.ok(archiveQueryTerms('ZL-2026-000001').includes('zl-2026-000001'))
})
test('knowledge CRUD, optimistic versions, tenant/user isolation, disabled and deleted exclusion', async () => {
  const h = await setup()
  try {
    const created = await h.request('POST', '/reuse', memory('表达偏好'))
    assert.equal(created.statusCode, 200, created.body)
    const first = created.json()
    assert.equal((await h.request('GET', '/reuse', undefined, h.bob)).json().items.length, 0)
    assert.equal((await h.request('GET', `/api/tenants/${h.other}/reuse`)).json().items.length, 0)
    assert.equal(
      (await h.request('GET', `/reuse/${first.id}/versions`, undefined, h.bob)).statusCode,
      404,
    )
    const next = await h.request('PUT', `/reuse/${first.id}`, {
      ...memory('表达偏好', '', '先列证据，再给结论'),
      expectedVersion: 1,
    })
    assert.equal(next.statusCode, 200, next.body)
    assert.equal(next.json().version, 2)
    assert.equal(
      (await h.request('PUT', `/reuse/${first.id}`, { ...memory('覆盖'), expectedVersion: 1 }))
        .statusCode,
      409,
    )
    assert.equal((await h.request('GET', `/reuse/${first.id}/versions`)).json().items.length, 2)
    await h.request('POST', '/reuse', memory('客户甲内部规则', '客户甲', '私有条款甲'))
    await h.request('POST', '/reuse', memory('客户乙内部规则', '客户乙', '私有条款乙'))
    const context = (
      await h.request('POST', '/reuse/search', { question: '需求', project: '客户乙' })
    ).json()
    assert.equal(context.items.length, 2)
    assert.ok(JSON.stringify(context).includes('私有条款乙'))
    assert.ok(!JSON.stringify(context).includes('私有条款甲'))
    assert.equal(
      (
        await h.request('PUT', `/reuse/${first.id}`, {
          ...memory('表达偏好'),
          enabled: false,
          expectedVersion: 2,
        })
      ).statusCode,
      200,
    )
    assert.equal(
      (await h.request('POST', '/reuse/search', { question: '需求' })).json().items.length,
      0,
    )
    assert.equal(
      (await h.request('DELETE', `/reuse/${first.id}`, { expectedVersion: 2 })).statusCode,
      409,
    )
    assert.equal(
      (await h.request('DELETE', `/reuse/${first.id}`, { expectedVersion: 3 })).statusCode,
      200,
    )
    assert.equal((await h.request('GET', `/reuse/${first.id}/versions`)).statusCode, 404)
    assert.equal(
      (await h.query('SELECT count(*)::int n FROM reuse_versions WHERE entry_id=$1', [first.id]))
        .rows[0].n,
      0,
    )
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})
test('template preview, duplicate submit, independent dependencies, explicit dispatch, latest knowledge snapshots', async () => {
  const h = await setup()
  try {
    const saved = (await h.request('POST', '/reuse', template())).json()
    const mem = (
      await h.request('POST', '/reuse', memory('测试偏好', '客户乙', '不使用夸张宣传'))
    ).json()
    const preview = await h.request('POST', `/reuse/${saved.id}/preview`, { version: 1, values })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.equal(preview.json().brief.project, '客户乙')
    assert.equal((await h.request('GET', '/secretary')).json().board.tasks.length, 0)
    const payload = { version: 1, values, requestId: randomUUID(), due: '2026-10-25' }
    const results = await Promise.all([
      h.request('POST', `/reuse/${saved.id}/draft`, payload),
      h.request('POST', `/reuse/${saved.id}/draft`, payload),
    ])
    for (const r of results) assert.equal(r.statusCode, 200, r.body)
    let { board, revision } = results[0].json()
    const batchId = results[0].json().batchId
    assert.equal(results[1].json().batchId, batchId)
    assert.equal(board.tasks.length, 2)
    assert.deepEqual(board.tasks[1].dependsOn, [board.tasks[0].id])
    assert.ok(
      board.tasks.every((t) => t.status === 'draft' && !t.attachmentIds && !t.archiveFileId),
    )
    assert.equal(board.tasks[0].knowledgeSnapshot.records[0].version, 1)
    assert.equal((await h.query('SELECT count(*)::int n FROM task_jobs')).rows[0].n, 0)
    assert.equal(
      (
        await h.request('POST', `/reuse/${saved.id}/draft`, {
          ...payload,
          values: { ...values, 项目: 'other' },
        })
      ).statusCode,
      409,
    )
    assert.equal(
      (
        await h.request(
          'POST',
          `/reuse/${saved.id}/draft`,
          { ...payload, requestId: randomUUID() },
          h.bob,
        )
      ).statusCode,
      403,
    )
    await h.request('PUT', `/reuse/${mem.id}`, {
      ...memory('测试偏好', '客户乙', '新的措辞'),
      expectedVersion: 1,
    })
    const second = (
      await h.request('POST', `/reuse/${saved.id}/draft`, { ...payload, requestId: randomUUID() })
    ).json()
    assert.equal(second.board.tasks.at(-1).knowledgeSnapshot.records[0].version, 2)
    assert.equal(second.board.tasks[0].knowledgeSnapshot.records[0].content, '不使用夸张宣传')
    assert.equal(h.requests.length, 0, 'draft and preview must never call a model')
    const dispatch = await h.request('POST', '/secretary', {
      revision: second.revision,
      today: '2026-10-24',
      action: { type: 'dispatch', batchId },
    })
    assert.equal(dispatch.statusCode, 200, dispatch.body)
    h.setAnswer(() => '根据本次要求整理完成')
    const run = await h.request('POST', `/secretary/tasks/${board.tasks[0].id}/run`, {})
    assert.equal(run.statusCode, 200, run.body)
    const workerRequests = []
    const engine = createDepartmentEngine({
      pool: h.pool,
      env: { NODE_ENV: 'test', OPERATIONS_CONFIG_KEY: Buffer.alloc(32, 9).toString('base64') },
      fetcher: async (url, options) => {
        workerRequests.push(JSON.parse(options.body))
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '任务已按要求完成' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })
    await engine.tick()
    assert.ok(workerRequests.at(-1).messages.some((m) => m.content.includes('不使用夸张宣传')))
    assert.ok(!workerRequests.at(-1).messages.some((m) => m.content.includes('新的措辞')))
    const firstDone = (await h.request('GET', '/secretary')).json().board.tasks[0]
    assert.equal(firstDone.status, 'completed')
    await engine.tick()
    assert.ok(workerRequests.at(-1).messages.some((m) => m.content.includes('任务已按要求完成')))
    assert.equal((await h.request('GET', '/secretary')).json().board.tasks[1].status, 'completed')
    await h.request('PUT', `/reuse/${saved.id}`, {
      ...template(),
      enabled: false,
      expectedVersion: 1,
    })
    assert.equal(
      (await h.request('POST', `/reuse/${saved.id}/preview`, { version: 1, values })).statusCode,
      409,
    )
    // Existing successful idempotency key still recovers its original batch after template edits.
    assert.equal(
      (await h.request('POST', `/reuse/${saved.id}/draft`, payload)).json().batchId,
      batchId,
    )
  } finally {
    await h.close()
  }
})
test('source proposals strip client text, attachments and outcomes; feedback/notice updates preserve task content', async () => {
  const h = await setup()
  try {
    const task = {
      id: randomUUID(),
      batchId: randomUUID(),
      title: '秘密客户甲',
      dept: 'new-agent-7',
      status: 'completed',
      summary: '秘密结果',
      request: '秘密要求',
      attachmentIds: [randomUUID()],
      due: '2025-01-01',
      finishedAt: '2026-10-24T00:00:00Z',
    }
    const board = { tasks: [task], messages: [], batches: [] }
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [
      h.tenant,
      h.alice,
      board,
    ])
    const proposal = await h.request('GET', `/reuse/template-source/${task.id}`)
    assert.equal(proposal.statusCode, 200, proposal.body)
    assert.doesNotMatch(proposal.body, /秘密|2025|attachmentIds|archiveFileId/)
    assert.equal(proposal.json().body.steps[0].dept, task.dept)
    const notices = (await h.request('GET', '/reuse/notices')).json().items
    assert.equal(notices.length, 1)
    assert.equal(
      (await h.request('POST', '/reuse/notices/read', { key: notices[0].key })).statusCode,
      200,
    )
    assert.equal((await h.request('GET', '/reuse/notices')).json().items[0].read, true)
    assert.equal(
      (await h.request('POST', '/reuse/notices/read', { key: notices[0].key }, h.bob)).statusCode,
      404,
    )
    assert.equal(
      (
        await h.request('POST', `/reuse/feedback/${task.id}`, {
          rating: 'revise',
          note: '希望加出处',
        })
      ).statusCode,
      200,
    )
    assert.equal((await h.request('GET', `/reuse/feedback/${task.id}`)).json().items.length, 1)
    assert.equal(
      (await h.request('GET', `/reuse/feedback/${task.id}`, undefined, h.bob)).json().items.length,
      0,
    )
    assert.equal(
      (
        await h.request(
          'POST',
          `/reuse/feedback/${task.id}`,
          { rating: 'adopted', note: '越权' },
          h.bob,
        )
      ).statusCode,
      409,
    )
    assert.deepEqual((await h.request('GET', '/secretary')).json().board, board)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})
test('secretary reads project-scoped knowledge and persists exact sources for employee execution', async () => {
  const h = await setup()
  try {
    await h.request('POST', '/reuse', memory('共同偏好', '', '短句'))
    await h.request('POST', '/reuse', {
      ...memory('价格文件', '客户乙', '公开报价按年度更新'),
      kind: 'knowledge',
    })
    await h.request('POST', '/reuse', memory('其他客户', '客户甲', '不应出现的私有约束'))
    h.setAnswer(() =>
      JSON.stringify({
        reply: '已生成草稿',
        tasks: [{ title: '整理规格', dept: 'new-agent-7', due: '2026-10-25' }],
      }),
    )
    const response = await h.request('POST', '/secretary/chat', {
      revision: 0,
      text: '按需求准备',
      intent: 'plan',
      language: 'zh',
      brief: { ...emptyBrief, project: '客户乙', goal: '查询价格' },
    })
    assert.equal(response.statusCode, 200, response.body)
    const request = JSON.stringify(h.requests.at(-1))
    assert.match(request, /公开报价/)
    assert.doesNotMatch(request, /不应出现的私有约束/)
    const task = response.json().board.tasks[0]
    assert.equal(task.knowledgeSnapshot.records.length, 2)
    const context = await knowledgeContext(
      h.pool,
      { tenantId: h.tenant, userId: h.bob },
      { project: '客户乙', question: '价格' },
    )
    assert.equal(context.records.length, 0)
  } finally {
    await h.close()
  }
})
