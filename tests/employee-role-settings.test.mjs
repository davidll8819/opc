import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setup} from './helpers/archive-api-fixture.mjs'
import {withEmployeeRole} from '../apps/api/src/employee-duty.mjs'
const ok=r=>{assert.ok([200,201].includes(r.statusCode),r.body);return r.json()}
const input=(role,more={})=>({jobTitle:role.jobTitle,capabilities:role.capabilities,profileRevision:role.profileRevision,skillIds:role.skillIds,skillRevision:role.skillRevision,...more})
test('off-duty role + skills save atomically, survive seating changes, and remain isolated by tenant and employee',async()=>{
 const h=await setup();try{
  const configs=(await h.query('SELECT encrypted_config FROM operations_settings')).rows
  const path='/employees/file-agent/role'
  let role=ok(await h.request('GET',path))
  const update=input(role,{jobTitle:'客户成功顾问',capabilities:'先整理客户需求，列出跟进计划，不编造客户资料。'})
  assert.equal((await h.request('PUT',path,update,h.bob)).statusCode,403)
  ok(await h.request('PUT','/employees/duty/file-agent',{onDuty:false}))
  const upload=ok(await h.request('POST','/skills/uploads',{filename:'SKILL.md',kind:'capability',contentBase64:Buffer.from('---\nname: client-followup\ndescription: 客户跟进方法\n---\n列出跟进步骤和责任人。').toString('base64')}))
  role=ok(await h.request('PUT',path,{...update,skillIds:[upload.skill.id]}))
  assert.equal(role.profileRevision,1)
  assert.deepEqual(role.skillIds,[upload.skill.id])
  assert.equal(ok(await h.request('GET','/employees/code-agent/role')).jobTitle,'程序部')
  assert.equal(ok(await h.request('GET',`/api/tenants/${h.other}${path}`)).jobTitle,'资料室')
  assert.equal((await h.request('PUT',path,update)).statusCode,409,'stale role revision')
  assert.equal((await h.request('PUT',path,input(role,{jobTitle:'  '}))).statusCode,400)
  assert.equal((await h.request('PUT',path,input(role,{capabilities:'x'.repeat(4001)}))).statusCode,400)
  const foreign=ok(await h.request('POST',`/api/tenants/${h.other}/skills/uploads`,{filename:'SKILL.md',kind:'capability',contentBase64:Buffer.from('---\nname: foreign-skill\ndescription: Different tenant\n---\nForeign method').toString('base64')}))
  assert.equal((await h.request('PUT',path,input(role,{jobTitle:'不应保存',skillIds:[foreign.skill.id]}))).statusCode,404)
  assert.equal(ok(await h.request('GET',path)).jobTitle,'客户成功顾问')
  ok(await h.request('PUT','/employees/duty/file-agent',{onDuty:true}))
  ok(await h.request('PUT','/employees/duty/code-agent',{onDuty:false}))
  ok(await h.request('PUT','/employees/duty/cheng-zhiyao',{onDuty:true}))
  const persisted=ok(await h.request('GET',path))
  assert.equal(persisted.jobTitle,'客户成功顾问');assert.equal(persisted.profileRevision,1);assert.deepEqual(persisted.skillIds,[upload.skill.id])
  const profile=ok(await h.request('GET','/employees')).employees.find(e=>e.id==='file-agent')
  assert.equal(profile.department,'客户成功顾问');assert.equal(profile.responsibility,update.capabilities)
  const status=ok(await h.request('GET','/workspace/status')).departments.find(e=>e.id==='archive')
  assert.equal(status.jobTitle,'客户成功顾问')
  h.setAnswer(body=>{assert.ok(body.messages[0].content.includes('客户成功顾问'));assert.ok(body.messages[0].content.includes(update.capabilities));return '客户跟进计划：明确需求、确认时间、回访。'})
  const chat=ok(await h.request('POST','/departments/archive/chat',{text:'安排跟进计划',revision:0}));assert.match(chat.messages.at(-1).text,/跟进计划/)
  const task={id:randomUUID(),dept:'file-agent',title:'制定客户跟进计划',summary:'客户需要周报',request:'客户需要周报',status:'queued',due:'2026-11-10',outputKind:'text',attachmentIds:[]}
  await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)',[h.tenant,h.alice,JSON.stringify({tasks:[task],messages:[],batches:[]})])
  const result=ok(await h.request('POST',`/secretary/tasks/${task.id}/run`,{})).board.tasks[0]
  assert.equal(result.status,'completed');assert.ok(result.archiveFileId)
  assert.deepEqual((await h.query('SELECT encrypted_config FROM operations_settings')).rows,configs)
 }finally{await h.close()}
})
test('concurrent skill edits are not overwritten by role editor and custom prompts preserve request and protocol',async()=>{
 const h=await setup();try{
  const path='/employees/file-agent/role';ok(await h.request('PUT','/employees/duty/file-agent',{onDuty:false}))
  const role=ok(await h.request('GET',path))
  const upload=ok(await h.request('POST','/skills/uploads',{filename:'SKILL.md',kind:'capability',contentBase64:Buffer.from('---\nname: concurrent-skill\ndescription: Test\n---\nReview output.').toString('base64')}))
  const skills=ok(await h.request('GET','/employees/file-agent/skills'))
  ok(await h.request('PUT','/employees/file-agent/skills',{skillIds:[upload.skill.id],revision:skills.revision}))
  assert.equal((await h.request('PUT',path,input(role,{jobTitle:'不应覆盖'}))).statusCode,409)
  assert.deepEqual(ok(await h.request('GET','/employees/file-agent/skills')).skillIds,[upload.skill.id])
  const profile={profileRevision:1,jobTitle:'项目顾问',capabilities:'给出可核对的方案。'}
  const body={messages:[{role:'system',content:'Keep safety constraints'},{role:'user',content:'hello'}]}
  const changed=withEmployeeRole(body,'/api/v1/chat/completions',profile)
  assert.equal(body.messages[0].content,'Keep safety constraints')
  assert.ok(changed.messages[0].content.startsWith('Keep safety constraints'))
  assert.ok(changed.messages[0].content.includes(profile.capabilities))
  assert.equal(withEmployeeRole(body,'/api/v1/images/generations',profile),body)
  assert.equal(withEmployeeRole(body,'/api/v1/chat/completions',{profileRevision:0}),body)
  const anthropic=withEmployeeRole({system:'Existing',messages:[]},'/api/anthropic/v1/messages',profile)
  assert.equal(anthropic.system[0].text,'Existing');assert.ok(anthropic.system[1].text.includes(profile.jobTitle))
 }finally{await h.close()}
})
