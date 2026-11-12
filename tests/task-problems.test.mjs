import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { taskProblem } from '../apps/api/src/task-problems.mjs'
import { performDepartmentTask, persistDepartmentResult } from '../apps/api/src/secretary-execution.mjs'

const design = { id: 'design', title: '视频文案与分镜设计', dept: 'new-agent-7', engine: 'department-v1', status: 'blocked', summary: '保留原需求', request: '交付分镜', outputKind: 'text', dependsOn: [], publishRequired: false, executionNote: '模型输出额度已耗尽，成果未完整返回' }
test('task problem classification explains length without confusing balance and routes dependencies first', () => {
  const classify = (t) => taskProblem({ tasks: [t] }, t)
  assert.equal(classify(design).code, 'output_limit')
  assert.equal(classify(design).settings.maxOutputTokens, 4096)
  assert.equal(classify(design).adjustable, true)
  assert.match(classify(design).description, /不代表账户余额不足/)
  for (const [note, code, destination] of [['任务金额预算不足','budget','usage'],['模型连接失败','connection','settings'],['附件不存在','material','archive'],['模型请求结果未知','uncertain','usage']]) {
    const result = classify({ ...design, executionNote: note })
    assert.equal(result.code, code); assert.equal(result.destination, destination)
  }
  assert.equal(classify({ ...design, runtimeTaskId: 'external' }).adjustable, false)
  assert.equal(classify({ ...design, runtimeTaskId: 'external', executionNote: '企业额度不足' }).hasExternalRun, true)
  const waiting = { ...design, id: 'video', dept: 'app-agent', status: 'queued', dependsOn: ['design'] }
  const state = taskProblem({ tasks: [design, waiting] }, waiting)
  assert.equal(state.code, 'dependency'); assert.equal(state.dependencies[0].id, 'design')
  assert.equal(state.adjustable, false)
})

test('per-task output settings reach execution; truncated text is preserved without completing or archiving it', async () => {
  let request, calls = 0
  const task = { ...design, executionSettings: { maxOutputTokens: 8192, deliveryNote: '只给四段紧凑分镜' } }
  const result = await performDepartmentTask({ task, ctx: {}, policy: {}, inputs: { text: '\n已完成调研', attachments: { parts: [] } }, call: async r => { calls++; request = r; return { choices: [{ finish_reason: 'length', message: { content: '第一镜：已返回的未完成文本' } }] } } })
  assert.equal(calls, 1); assert.equal(request.body.max_tokens, 8192)
  assert.match(request.body.messages[1].content, /只给四段紧凑分镜/)
  assert.match(request.body.messages[1].content, /已完成调研/)
  const stored = structuredClone(task)
  await persistDepartmentResult({ query: () => { throw Error('Partial output must not archive or write files') } }, {}, stored, result)
  assert.equal(stored.status, 'blocked'); assert.equal(stored.summary, '保留原需求')
  assert.equal(stored.request, '交付分镜'); assert.match(stored.partialResult.text, /未完成文本/)
  assert.equal(stored.problem.limit, 8192)
  assert.equal(stored.archiveFileId, undefined)
})

test('task problem API isolates ownership, saves without execution, requires confirmation and rejects concurrent/stale recovery', async () => {
  const h = await setup(), taskId = randomUUID(), sibling = { ...design, id: randomUUID(), status: 'completed', summary: '已完成的调研不得重跑', engine: 'research-v1', executionNote: '调研完成' }
  const blocked = { ...design, id: taskId, dependsOn: [sibling.id] }
  const downstream = { ...design, id: randomUUID(), dept: 'app-agent', status: 'queued', dependsOn: [taskId] }
  const board = { tasks: [sibling, blocked, downstream], messages: [], batches: [] }
  const path = `/tasks/${taskId}/recovery`
  try {
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board,revision) VALUES($1,$2,$3,0)', [h.tenant,h.alice,JSON.stringify(board)])
    await h.query("INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'blocked')", [h.tenant,h.alice,taskId])
    const config = (await h.query('SELECT encrypted_config FROM operations_settings WHERE tenant_id=$1',[h.tenant])).rows[0].encrypted_config
    assert.equal((await h.request('GET',path,undefined,h.bob)).statusCode,403)
    assert.equal((await h.request('GET',`/api/tenants/${h.other}${path}`)).statusCode,404)
    const initial = (await h.request('GET',path)).json()
    assert.equal(initial.problem.code, 'output_limit')
    assert.equal((await h.request('GET',`/tasks/${downstream.id}/recovery`)).json().problem.dependencies[0].id, taskId)
    const settings = { maxOutputTokens: 8192, deliveryNote: '只交付必需的分镜与字幕' }
    assert.equal((await h.request('PATCH',path,{revision:0,settings:{...settings,model:'forbidden'}})).statusCode,400)
    assert.equal((await h.request('PATCH',path,{revision:0,settings:{...settings,maxOutputTokens:999999}})).statusCode,400)
    assert.equal((await h.request('PATCH',path,{revision:0,settings:{...settings,deliveryNote:'x'.repeat(2001)}})).statusCode,400)
    const saved = await h.request('PATCH',path,{revision:0,settings})
    assert.equal(saved.statusCode,200,saved.body)
    assert.equal(saved.json().revision,1)
    const actual = saved.json().board.tasks[1]
    assert.deepEqual(actual.executionSettings,settings); assert.equal(actual.status,'blocked')
    assert.equal(actual.request,blocked.request); assert.deepEqual(saved.json().board.tasks[0],sibling)
    assert.equal((await h.query('SELECT state FROM task_jobs WHERE task_id=$1',[taskId])).rows[0].state,'blocked')
    assert.equal(h.requests.length,0)
    assert.equal((await h.request('POST',path,{revision:1})).statusCode,409)
    assert.equal((await h.request('PATCH',path,{revision:0,settings})).statusCode,409)
    const resumes = await Promise.all([1,2].map(()=>h.request('POST',path,{revision:1,acknowledgeRisk:true,settings})))
    assert.deepEqual(resumes.map(r=>r.statusCode).sort(),[200,409])
    const resumed = resumes.find(r=>r.statusCode===200).json()
    assert.equal(resumed.board.tasks[1].status,'queued')
    assert.equal(resumed.board.tasks[1].recoveryHistory.length,1)
    assert.deepEqual(resumed.board.tasks[0],sibling); assert.deepEqual(resumed.board.tasks[2],downstream)
    assert.equal((await h.request('PATCH',path,{revision:resumed.revision,settings})).statusCode,409)
    assert.equal((await h.query('SELECT encrypted_config FROM operations_settings WHERE tenant_id=$1',[h.tenant])).rows[0].encrypted_config,config)
    assert.equal(h.requests.length,0)
  } finally { await h.close() }
})
