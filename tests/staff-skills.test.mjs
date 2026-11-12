import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { EMPLOYEES, modelDepartment } from '../packages/employees/registry.mjs'
import { resolveDepartment, defaultPolicy } from '../apps/api/src/operations/policy.mjs'

const ok=r=>{assert.equal(r.statusCode,200,r.body);return r.json()}
test('staff seats are isolated, bounded and preserve employee skills; reserves inherit models without copying settings',async()=>{
 const h=await setup();try{
  const before=(await h.query('SELECT encrypted_config FROM operations_settings')).rows
  assert.equal(EMPLOYEES.length,13)
  const initial=ok(await h.request('GET','/employees/duty'))
  assert.equal(initial.items.filter(i=>i.seat!==null).length,9)
  assert.equal((await h.request('PUT','/employees/duty/xu-zhining',{onDuty:true})).statusCode,409)
  assert.equal((await h.request('PUT','/employees/duty/code-agent',{onDuty:false},h.bob)).statusCode,403)
  ok(await h.request('PUT','/employees/duty/code-agent',{onDuty:false}))
  const outcomes=await Promise.all(['xu-zhining','cheng-zhiyao'].map(id=>h.request('PUT',`/employees/duty/${id}`,{onDuty:true})))
  assert.deepEqual(outcomes.map(r=>r.statusCode).sort(),[200,409])
  const after=ok(await h.request('GET','/employees/duty'))
  assert.equal(after.items.filter(i=>i.seat!==null).length,9)
  assert.equal(new Set(after.items.filter(i=>i.seat!==null).map(i=>i.seat)).size,9)
  assert.equal((await h.request('POST','/departments/cheng_zhiyao/chat',{text:'hi',revision:0})).statusCode,409)
  assert.equal(ok(await h.request('GET',`/api/tenants/${h.other}/employees/duty`)).items.find(i=>i.employeeId==='code-agent').seat,1)
  assert.deepEqual((await h.query('SELECT encrypted_config FROM operations_settings')).rows,before)
  assert.equal(modelDepartment('cheng_zhiyao'),'dev')
  const policy=defaultPolicy();policy.tiers.strong='example';assert.equal(resolveDepartment(policy,'cheng_zhiyao').model,'example')
  const lease=randomUUID();await h.query('INSERT INTO employee_work_leases(id,tenant_id,employee_id) VALUES($1,$2,$3)',[lease,h.tenant,'file-agent'])
  assert.equal((await h.request('PUT','/employees/duty/file-agent',{onDuty:false})).statusCode,409)
 }finally{await h.close()}
})
test('skill studio lifecycle: edit, actual gateway trial, explicit binding, immutable update and tenant isolation',async()=>{
 const h=await setup();try{
  h.setAnswer(()=> '## 工作结果\n这是通过模型测试通道返回的结果。')
  const create={title:'整理访谈',requirement:'从访谈中提取客户需求',instructions:'列出需求及原文依据，不编造。'}
  assert.equal((await h.request('POST','/skills/studio',create,h.bob)).statusCode,403)
  let d=ok(await h.request('POST','/skills/studio',create));const path=`/skills/studio/${d.id}`
  assert.equal((await h.query('SELECT * FROM skill_assignments')).rows.length,0)
  assert.equal((await h.request('GET',`/api/tenants/${h.other}${path}`)).statusCode,404)
  assert.equal((await h.request('POST',`${path}/enable`,{version:1,trialId:randomUUID(),employeeId:'file-agent',confirmed:true})).statusCode,409)
  const run={requestId:randomUUID(),version:1,employeeId:'file-agent',kind:'trial',input:'客户希望自动导出每周报告。'}
  const result=ok(await h.request('POST',`${path}/run`,run));assert.equal(result.state,'completed')
  assert.equal(h.requests.length,1)
  assert.ok(h.requests[0].messages.some(m=>m.content.includes('列出需求及原文依据')))
  ok(await h.request('POST',`${path}/run`,run));assert.equal(h.requests.length,1,'idempotent request must not charge twice')
  const release={version:1,trialId:run.requestId,employeeId:'file-agent',confirmed:true}
  const enabled=ok(await h.request('POST',`${path}/enable`,release));assert.ok(enabled.installedId)
  const bound=ok(await h.request('GET','/employees/file-agent/skills'));assert.ok(bound.skillIds.includes(enabled.installedId))
  assert.equal(ok(await h.request('GET','/employees/code-agent/skills')).skillIds.length,0)
  ok(await h.request('PUT','/employees/duty/file-agent',{onDuty:false}))
  assert.ok(ok(await h.request('GET','/employees/file-agent/skills')).skillIds.includes(enabled.installedId))
  ok(await h.request('PUT','/employees/duty/file-agent',{onDuty:true}))
  d=ok(await h.request('PUT',path,{...create,instructions:'新版：先引用原文，再列需求。',version:1}));assert.equal(d.version,2)
  assert.equal((await h.request('POST',`${path}/enable`,release)).statusCode,409)
  assert.equal((await h.request('PUT',path,{...create,version:1})).statusCode,409)
  assert.equal(ok(await h.request('GET','/employees/file-agent/skills')).skillIds[0],enabled.installedId,'editing never changes current binding')
  const run2={...run,requestId:randomUUID(),version:2};ok(await h.request('POST',`${path}/run`,run2))
  const v2=ok(await h.request('POST',`${path}/enable`,{...release,version:2,trialId:run2.requestId}))
  assert.notEqual(v2.installedId,enabled.installedId)
  assert.deepEqual(ok(await h.request('GET','/employees/file-agent/skills')).skillIds,[v2.installedId])
  assert.equal((await h.query('SELECT * FROM installed_skills')).rows.length,2)
  const detail=ok(await h.request('GET',path));assert.equal(detail.versions.length,2)
  assert.equal((await h.request('POST',`${path}/run`,{...run,input:'changed'})).statusCode,409)
 }finally{await h.close()}
})
test('delayed generation preserves concurrent edits, failed trials cannot activate and do not auto-retry',async()=>{
 const h=await setup();try{
  const create={title:'延迟草稿',requirement:'整理来源',instructions:'旧版'}
  const draft=ok(await h.request('POST','/skills/studio',create)),path=`/skills/studio/${draft.id}`
  let started,finish;const startedPromise=new Promise(r=>started=r);const wait=new Promise(r=>finish=r)
  h.setAnswer(async()=>{started();await wait;return '生成的版本内容'})
  const input={requestId:randomUUID(),version:1,employeeId:'file-agent',kind:'generate',input:'生成草稿'}
  const pending=h.request('POST',`${path}/run`,input);await startedPromise
  ok(await h.request('PUT',path,{...create,instructions:'用户新编辑',version:1}))
  assert.equal((await h.request('PUT','/employees/duty/file-agent',{onDuty:false})).statusCode,409)
  finish();ok(await pending)
  const detail=ok(await h.request('GET',path));assert.equal(detail.instructions,'用户新编辑');assert.equal(detail.runs[0].output,'生成的版本内容')
  h.setAnswer(()=>new Response('{}',{status:503,headers:{'content-type':'application/json'}}))
  const failure={...input,requestId:randomUUID(),version:2,kind:'trial'}
  assert.equal((await h.request('POST',`${path}/run`,failure)).statusCode,502)
  assert.equal(h.requests.length,2)
  const old=ok(await h.request('POST',`${path}/run`,failure));assert.equal(old.state,'failed');assert.equal(h.requests.length,2)
  assert.equal((await h.request('POST',`${path}/enable`,{version:2,trialId:failure.requestId,employeeId:'file-agent',confirmed:true})).statusCode,409)
 }finally{await h.close()}
})

test('each reserve employee can chat and complete an independently archived text task after taking a seat',async()=>{
 const h=await setup();try{
  const {encryptConfig}=await import('../apps/api/src/operations/security.mjs')
  const policy=defaultPolicy();policy.tiers.fast='staff-test';policy.tiers.strong='staff-test'
  for(const key of ['outreach','dev','content_ops','market_research'])policy.departments[key]={...policy.departments[key],enabled:true,tier:'fast'}
  await h.query('UPDATE operations_settings SET encrypted_config=$2 WHERE tenant_id=$1',[h.tenant,encryptConfig({...policy,credentials:{ai:'synthetic-key'}},Buffer.alloc(32,9),h.tenant)])
  h.setAnswer(()=> '已整理工作方案：输入、步骤、验收标准。')
  ok(await h.request('PUT','/employees/duty/code-agent',{onDuty:false}))
  for(const employee of EMPLOYEES.filter(e=>e.rosterNo>9)){
   ok(await h.request('PUT',`/employees/duty/${employee.id}`,{onDuty:true}))
   const chat=ok(await h.request('POST',`/departments/${employee.departmentKey}/chat`,{text:'整理一份岗位工作方案',revision:0}))
   assert.match(chat.messages.at(-1).text,/工作方案/)
   assert.ok(h.requests.at(-1).messages[0].content.includes(employee.name))
   const task={id:randomUUID(),dept:employee.id,title:'独立文字工作',summary:'整理输入信息和工作步骤',request:'整理输入信息和工作步骤',status:'queued',due:'2026-11-10',outputKind:'text',attachmentIds:[]}
   await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET board=$3',[h.tenant,h.alice,JSON.stringify({tasks:[task],messages:[],batches:[]})])
   const completed=ok(await h.request('POST',`/secretary/tasks/${task.id}/run`,{}))
   const result=completed.board.tasks.find(t=>t.id===task.id)
   assert.equal(result.status,'completed');assert.ok(result.archiveFileId)
   assert.equal((await h.request('GET',`/files/${result.archiveFileId}/download`)).statusCode,200)
   ok(await h.request('PUT',`/employees/duty/${employee.id}`,{onDuty:false}))
  }
  assert.equal((await h.query('SELECT DISTINCT department FROM department_conversations')).rows.length,4)
 }finally{await h.close()}
})
