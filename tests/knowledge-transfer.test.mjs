import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { workflowExample } from '../apps/api/src/reuse-transfer.mjs'
import { createDepartmentEngine } from '../apps/api/src/department-engine.mjs'

test('portable workflow imports, exports, previews and creates a real dependency draft without executing', async () => {
  const h = await setup()
  try {
    const preview = await h.request('POST', '/reuse/import-preview', {
      filename: 'workflow.json',
      text: JSON.stringify(workflowExample),
      kind: 'template',
    })
    assert.equal(preview.statusCode, 200, preview.body)
    assert.equal((await h.request('GET', '/reuse')).json().items.length, 0)
    const saved = await h.request('POST', '/reuse/import', preview.json())
    assert.equal(saved.statusCode, 200, saved.body)
    const entry = saved.json().items[0]
    const exported = await h.request('GET', `/reuse/${entry.id}/export`)
    assert.deepEqual(exported.json(), workflowExample)
    assert.equal(
      (await h.request('GET', `/reuse/${entry.id}/export`, undefined, h.bob)).statusCode,
      404,
    )
    assert.equal(
      (await h.request('POST', `/reuse/${entry.id}/preview`, { version: 1, values: {} }))
        .statusCode,
      400,
    )
    const values = { 项目: '隔离客户', 目标: '整理产品资料', 验收要求: '引用来源' }
    const ready = await h.request('POST', `/reuse/${entry.id}/preview`, { version: 1, values })
    assert.equal(ready.statusCode, 200, ready.body)
    const created = await h.request('POST', `/reuse/${entry.id}/draft`, {
      version: 1,
      values,
      requestId: randomUUID(),
      due: '2026-10-30',
    })
    assert.equal(created.statusCode, 200, created.body)
    const tasks = created.json().board.tasks
    assert.equal(tasks.length, 2)
    assert.ok(tasks.every((t) => t.status === 'draft' && !t.publishRequired))
    assert.deepEqual(tasks[1].dependsOn, [tasks[0].id])
    assert.equal(h.requests.length, 0)
    assert.equal((await h.query('SELECT count(*)::int n FROM task_jobs')).rows[0].n, 0)
    const dispatched = await h.request('POST', '/secretary', {
      revision: created.json().revision,
      today: '2026-10-26',
      action: { type: 'dispatch', batchId: created.json().batchId },
    })
    assert.equal(dispatched.statusCode, 200, dispatched.body)
    const calls = []
    const engine = createDepartmentEngine({
      pool: h.pool,
      env: { NODE_ENV: 'test', OPERATIONS_CONFIG_KEY: Buffer.alloc(32, 9).toString('base64') },
      fetcher: async (url, options) => {
        calls.push(JSON.parse(options.body))
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: `隔离成果第${calls.length}步：已核对产品资料` } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })
    await engine.tick()
    await engine.tick()
    const finished = (await h.request('GET', '/secretary')).json().board.tasks
    assert.ok(finished.every((t) => t.status === 'completed'))
    assert.equal(calls.length, 2)
    assert.match(JSON.stringify(calls[1]), /隔离成果第1步/)
  } finally {
    await h.close()
  }
})

test('template import rejects foreign formats, cycles, invalid people, malformed placeholders and executable fields', async () => {
  const h = await setup()
  try {
    const bad = [
      { format: 'n8n', nodes: [] },
      { ...workflowExample, version: 2 },
    ]
    for (const change of [
      (w) => {
        w.workflow.steps[0].dept = 'missing-person'
      },
      (w) => {
        w.workflow.steps[0].dependsOn = [1]
      },
      (w) => {
        w.workflow.steps[0].brief = '{{bad variable}}'
      },
      (w) => {
        w.workflow.steps[0].script = 'doSomething()'
      },
    ]) {
      const v = structuredClone(workflowExample)
      change(v)
      bad.push(v)
    }
    for (const data of bad) {
      const r = await h.request('POST', '/reuse/import-preview', {
        filename: 'bad.json',
        text: JSON.stringify(data),
        kind: 'template',
      })
      assert.equal(r.statusCode, 400, r.body)
    }
    const v = (
      await h.request('POST', '/reuse/import-preview', {
        filename: 'good.json',
        text: JSON.stringify(workflowExample),
        kind: 'template',
      })
    ).json().entries[0]
    assert.equal(
      (await h.request('POST', '/reuse/import', { entries: [v, { ...v, title: '' }] })).statusCode,
      400,
    )
    assert.equal((await h.request('GET', '/reuse')).json().items.length, 0)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})

test('text import segments without truncation, concurrent repeats reuse records and scopes stay isolated', async () => {
  const h = await setup()
  try {
    const text = '退款政策说明。'.repeat(1000)
    const preview = await h.request('POST', '/reuse/import-preview', {
      filename: '售后.md',
      text,
      kind: 'knowledge',
      project: '客户乙',
    })
    assert.equal(preview.statusCode, 200, preview.body)
    const entries = preview.json().entries
    assert.equal(entries.map((e) => e.body.content).join(''), text)
    assert.ok(entries.every((e) => e.body.content.length <= 4000))
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => h.request('POST', '/reuse/import', { entries })),
    )
    assert.ok(responses.every((r) => r.statusCode === 200))
    assert.equal(
      responses.reduce((n, r) => n + r.json().created, 0),
      entries.length,
    )
    assert.equal((await h.request('GET', '/reuse')).json().items.length, entries.length)
    assert.equal((await h.request('GET', '/reuse', undefined, h.bob)).json().items.length, 0)
    assert.equal((await h.request('GET', `/api/tenants/${h.other}/reuse`)).json().items.length, 0)
    assert.equal(
      (await h.request('POST', '/reuse/search', { question: '怎么退费', project: '客户甲' })).json()
        .items.length,
      0,
    )
    assert.equal(
      (await h.request('POST', '/reuse/search', { question: '怎么退费', project: '客户乙' })).json()
        .items.length,
      entries.length,
    )
    for (const payload of [
      { filename: 'bad.pdf', text: 'text' },
      { filename: 'bad.txt', text: 'x'.repeat(32001) },
      { filename: 'empty.md', text: '  ' },
      { filename: 'bad.md', text: 'a\u0000b' },
    ])
      assert.equal(
        (await h.request('POST', '/reuse/import-preview', { kind: 'knowledge', ...payload }))
          .statusCode,
        400,
      )
  } finally {
    await h.close()
  }
})

test('employee normal chat receives scoped knowledge and version provenance; stopped knowledge no longer enters new calls', async () => {
  const h = await setup()
  try {
    const entry = {
      kind: 'memory',
      title: '明确习惯',
      project: '客户乙',
      enabled: true,
      body: { content: '先写三条结论，再列来源。', source: '隔离用户确认' },
    }
    const row = (await h.request('POST', '/reuse', entry)).json()
    await h.request('POST', '/reuse', {
      ...entry,
      title: '其他客户秘密',
      project: '客户甲',
      body: { content: '不应进入本轮', source: '隔离' },
    })
    h.setAnswer(() => '收到，按要求整理。')
    const response = await h.request('POST', '/departments/archive/chat', {
      text: '帮我整理资料',
      revision: 0,
      knowledgeProject: '客户乙',
    })
    assert.equal(response.statusCode, 200, response.body)
    const sent = JSON.stringify(h.requests.at(-1))
    assert.match(sent, /先写三条结论/)
    assert.ok(!sent.includes('其他客户秘密'))
    assert.equal(response.json().messages.at(-1).knowledgeSources[0].version, 1)
    assert.equal(response.json().messages.at(-1).knowledgeSources[0].id, row.id)
    await h.request('PUT', `/reuse/${row.id}`, { ...entry, enabled: false, expectedVersion: 1 })
    const next = await h.request('POST', '/departments/archive/chat', {
      text: '继续整理',
      revision: 1,
      knowledgeProject: '客户乙',
    })
    assert.equal(next.statusCode, 200, next.body)
    assert.ok(!JSON.stringify(h.requests.at(-1)).includes('先写三条结论'))
    assert.equal(next.json().messages.at(-1).knowledgeSources, undefined)
  } finally {
    await h.close()
  }
})
