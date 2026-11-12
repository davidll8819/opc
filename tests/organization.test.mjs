import test from 'node:test'
import assert from 'node:assert/strict'
import {setup} from './helpers/archive-api-fixture.mjs'
import {loadPolicy,createModelGateway} from '../apps/api/src/operations/gateway.mjs'
import {diagnosticRevision} from '../apps/api/src/employee-diagnostics.mjs'
import {randomUUID} from 'node:crypto'
import {resolveCapability} from '../apps/api/src/operations/policy.mjs'
import {transaction} from '../apps/api/src/db.mjs'
const ok=r=>{assert.equal(r.statusCode,200,r.body);return r.json()}
const models=text=>({text,search:'',image:'',video:''})
const roleInput=r=>({jobTitle:r.jobTitle,capabilities:r.capabilities,profileRevision:r.profileRevision,skillIds:r.skillIds,skillRevision:r.skillRevision,departmentId:r.departmentId,jobId:r.jobId,modelOverrides:r.modelOverrides})
test('custom departments, jobs and employee overrides are tenant scoped and used by actual calls without rewriting legacy settings',async()=>{
 const h=await setup();try{
  const before=(await h.query('SELECT * FROM operations_settings')).rows
  const original=ok(await h.request('GET','/organization'))
  assert.equal(original.departments.length,9)
  let org=ok(await h.request('PUT','/organization',{...original,departments:[...original.departments,{id:'dept-sales',name:'电商部',description:'面向店铺的选品与内容运营',models:models('sales-text')}],jobs:[...original.jobs,{id:'job-buyer',departmentId:'dept-sales',name:'选品分析师',capabilities:'对比商品需求、成本和竞争情况，给出选品建议'}]}))
  assert.equal((await h.request('PUT','/organization',org,h.bob)).statusCode,403)
  assert.equal((await h.request('PUT','/organization',original)).statusCode,409)
  assert.equal(ok(await h.request('GET',`/api/tenants/${h.other}/organization`)).departments.length,9)
  const path='/employees/code-agent/role'
  let profile=ok(await h.request('GET',path))
  const seat=profile.seat
  profile=ok(await h.request('PUT',path,{...roleInput(profile),departmentId:'dept-sales',jobId:'job-buyer',jobTitle:'选品分析师',capabilities:'比较供应链，不编造销量',organizationRevision:org.revision}))
  assert.equal(profile.seat,seat,'editing on duty preserves desk')
  assert.equal(profile.departmentName,'电商部')
  const lease=randomUUID()
  await h.query('INSERT INTO employee_work_leases(id,tenant_id,employee_id) VALUES($1,$2,$3)',[lease,h.tenant,'code-agent'])
  assert.equal((await h.request('PUT',path,roleInput(profile))).statusCode,409,'active work blocks profile mutation')
  assert.equal((await h.request('PUT','/organization',org)).statusCode,409,'active work blocks department mutation')
  await h.query('DELETE FROM employee_work_leases WHERE id=$1',[lease])
  assert.equal((await h.request('PUT',path,{...roleInput(profile),departmentId:'another-tenant-dept'})).statusCode,404)
  assert.equal((await h.request('PUT',path,{...roleInput(profile),jobId:'job_archive'})).statusCode,400)
  assert.equal((await h.request('PUT','/organization',{...org,departments:org.departments.filter(d=>d.id!=='dept-sales'),jobs:org.jobs.filter(j=>j.departmentId!=='dept-sales')})).statusCode,409)
  h.setAnswer(()=> '选品分析完成')
  ok(await h.request('POST','/departments/dev/messages',{prompt:'请分析选品'}))
  assert.equal(h.requests.at(-1).model,'sales-text')
  assert.match(h.requests.at(-1).messages.find(m=>m.role==='system').content,/电商部/)
  assert.match(h.requests.at(-1).messages.find(m=>m.role==='system').content,/比较供应链/)
  assert.match(h.requests.at(-1).messages.find(m=>m.role==='system').content,/面向店铺的选品/)
  const env={OPERATIONS_CONFIG_KEY:Buffer.alloc(32,9).toString('base64')},ctx={tenantId:h.tenant,userId:h.alice}
  const frozen=(await transaction(h.pool,db=>loadPolicy(db,h.tenant,env),ctx)).policy
  const savedPolicy=await transaction(h.pool,db=>loadPolicy(db,h.tenant,env),ctx)
  await h.query('INSERT INTO employee_diagnostic_history(tenant_id,user_id,department,config_revision,result) VALUES($1,$2,$3,$4,$5)',[h.tenant,h.alice,'dev',diagnosticRevision(savedPolicy),JSON.stringify({department:'dev',checks:[]})])
  assert.equal(ok(await h.request('GET','/employees/self-check/history')).items[0].stale,false)
  profile=ok(await h.request('PUT',path,{...roleInput(profile),jobTitle:'独立顾问',capabilities:'新任务方法',modelOverrides:models('employee-text')}))
  ok(await h.request('POST','/departments/dev/messages',{prompt:'采用新设置'}))
  assert.equal(h.requests.at(-1).model,'employee-text')
  assert.equal(ok(await h.request('GET','/employees/self-check/history')).items[0].stale,true,'employee model edits invalidate old checks')
  let sent
  const call=createModelGateway({pool:h.pool,env,fetcher:async(_u,init)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}}))}})
  await call({ctx,policy:frozen,department:'dev',path:'/api/v1/chat/completions',body:{messages:[{role:'user',content:'继续已开始的任务'}],max_tokens:100}})
  assert.equal(sent.model,'sales-text')
  assert.match(sent.messages[0].content,/比较供应链/)
  assert.doesNotMatch(sent.messages[0].content,/新任务方法/)
  assert.deepEqual((await h.query('SELECT * FROM operations_settings')).rows,before)
  const people=ok(await h.request('GET','/employees')).employees
  assert.equal(people.find(e=>e.id==='code-agent').models.text.model,'employee-text')
  assert.notEqual(people.find(e=>e.id==='file-agent').models.text.model,'employee-text')
  assert.equal(people.find(e=>e.id==='code-agent').models.text.source,'employee')
  profile=ok(await h.request('PUT',path,{...roleInput(profile),modelOverrides:{text:'',search:'research-test',image:'image-test',video:'video-test'}}))
  const effective=(await transaction(h.pool,db=>loadPolicy(db,h.tenant,env),ctx)).policy
  assert.equal(resolveCapability(effective,'dev','text').model,'sales-text','clearing employee model inherits department')
  for(const [kind,model] of [['search','research-test'],['image','image-test'],['video','video-test']])assert.equal(resolveCapability(effective,'dev',kind).model,model)
  org=ok(await h.request('PUT','/organization',{...org,departments:[...org.departments,{id:'unused',name:'待规划部',description:'',models:models('')}]}))
  org=ok(await h.request('PUT','/organization',{...org,departments:org.departments.filter(d=>d.id!=='unused')}))
  assert.equal(org.departments.some(d=>d.id==='unused'),false)
 }finally{await h.close()}
})
