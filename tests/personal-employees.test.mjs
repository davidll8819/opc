import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { personalToken } from './helpers/personal-token.mjs'
import { gatewayToken } from '../apps/api/src/operations/policy.mjs'
import {createOperationsDriver,legacyMediaOwner} from '../apps/api/src/operations/driver.mjs'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const ok=r=>{assert.equal(r.statusCode,200,r.body);return r.json()}

test('personal gateway accepts the SDK beta Messages flag without permitting arbitrary queries or shared credentials',async()=>{
 const calls=[],bridgeSecret='synthetic-runtime-bridge-secret'
 const h=await setup(undefined,{operationsDriver:{binding:async tenantId=>({tenantId,bridgeSecret})},modelFetch:async(url,options)=>{calls.push({url,headers:options.headers});return Response.json({content:[{type:'text',text:'OK'}],usage:{input_tokens:2,output_tokens:1}})}})
 try{
  const settings=ok(await h.request('GET','/operations/settings'));settings.policy.tiers.fast='claude-test-model'
  ok(await h.request('PUT','/operations/settings',settings.policy))
  const url=`/integrations/model-gateway/${h.tenant}/api/anthropic/v1/messages`
  const authorization=`Bearer ${await personalToken(bridgeSecret,h.tenant,h.alice)}`
  const request=(suffix,token=authorization)=>h.app.inject({method:'POST',url:url+suffix,headers:{authorization:token},payload:{model:'office-content-ops',messages:[{role:'user',content:'test'}],max_tokens:32}})
  assert.equal((await request('?beta=true')).statusCode,200)
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://app.4yi.ai/api/anthropic/v1/messages')
  assert.equal(calls[0].headers.authorization,`Bearer synthetic-personal-${h.alice}`)
  for(const query of ['?beta=false','?beta=true&url=https://other.invalid','?beta=true&beta=true'])assert.equal((await request(query)).statusCode,404)
  assert.equal((await request('?beta=true',`Bearer ${gatewayToken(bridgeSecret,h.tenant)}`)).statusCode,403)
  assert.equal(calls.length,1,'invalid requests never reach a paid provider')
 }finally{await h.close()}
})

test('only the original owner can explicitly import a retained legacy key into their own personal account',async()=>{
 const h=await setup(undefined,{personalKeys:false});try{
  const before=(await h.query('SELECT encrypted_config FROM operations_settings')).rows
  assert.equal(ok(await h.request('GET','/personal-api-key')).legacyAvailable,true)
  assert.equal(ok(await h.request('GET','/personal-api-key',undefined,h.bob)).legacyAvailable,false)
  assert.equal((await h.request('POST','/personal-api-key/import-legacy',{revision:0,confirmed:true},h.bob)).statusCode,403)
  await h.query("UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2",[h.tenant,h.bob])
  assert.equal((await h.request('POST','/personal-api-key/import-legacy',{revision:0,confirmed:true},h.bob)).statusCode,409)
  assert.equal((await h.request('POST','/personal-api-key/import-legacy',{revision:0,confirmed:false})).statusCode,400)
  const imported=ok(await h.request('POST','/personal-api-key/import-legacy',{revision:0,confirmed:true}));assert.equal(imported.configured,true)
  assert.equal(JSON.stringify(imported).includes('synthetic-key'),false)
  assert.equal(ok(await h.request('GET','/personal-api-key',undefined,h.bob)).configured,false)
  assert.equal((await h.request('POST','/personal-api-key/import-legacy',{revision:1,confirmed:true})).statusCode,409)
  assert.deepEqual((await h.query('SELECT encrypted_config FROM operations_settings')).rows,before)
 }finally{await h.close()}
})

test('database role cannot read another personal key even inside the same workspace',async()=>{
 const h=await setup();try{
  await h.query('CREATE ROLE personal_test_reader')
  await h.query('GRANT USAGE ON SCHEMA public TO personal_test_reader')
  await h.query('GRANT SELECT,UPDATE ON personal_model_keys TO personal_test_reader')
  await h.query('SET ROLE personal_test_reader')
  await h.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[h.tenant,h.alice])
  assert.equal((await h.query('SELECT user_id FROM personal_model_keys')).rows.length,1)
  assert.equal((await h.query('SELECT user_id FROM personal_model_keys WHERE user_id=$1',[h.bob])).rows.length,0)
  assert.equal((await h.query('UPDATE personal_model_keys SET revision=revision+1 WHERE user_id=$1 RETURNING user_id',[h.bob])).rows.length,0)
  await h.query("SELECT set_config('app.user_id','',false)")
  assert.equal((await h.query('SELECT user_id FROM personal_model_keys')).rows.length,0)
 }finally{await h.query('RESET ROLE');await h.close()}
})

test('historical video identity is limited to saved owner mappings and read-only task paths',async()=>{
 const h=await setup(),dir=await mkdtemp(join(tmpdir(),'personal-driver-')),original=globalThis.fetch,claims=[]
 try{
  const old='aaaaaaaaaaaaaaaaaaaaaaaa',task='bbbbbbbbbbbbbbbbbbbbbbbb'
  await h.query('INSERT INTO legacy_runtime_tasks VALUES($1,$2,$3)',[h.tenant,h.alice,task])
  const file=join(dir,'runtime.json');await writeFile(file,JSON.stringify({[h.tenant]:{userId:old,aiUrl:'https://runtime.test',serverUrl:'https://server.test',jwtSecret:'synthetic-jwt-secret',bridgeSecret:'synthetic-bridge-secret'}}),{mode:0o600})
  globalThis.fetch=async(url,options)=>{
   const payload=JSON.parse(Buffer.from(options.headers.authorization.split('.')[1],'base64url').toString());claims.push(payload)
   if(url.endsWith(task)&&payload.id!==old)return new Response('{}',{status:404})
   return Response.json({data:{id:task,savedVideos:[]}})
  }
  const driver=createOperationsDriver({OPERATIONS_RUNTIMES_FILE:file},{pool:h.pool}),a=await driver.binding(h.tenant,h.alice),b=await driver.binding(h.tenant,h.bob)
  const result=await driver.request(a,'ai',`/agent/tasks/${task}`)
  assert.equal(claims.at(-1).officeLegacyRead,`/agent/tasks/${task}`)
  assert.equal(result[legacyMediaOwner],old);assert.equal(JSON.stringify(result).includes(old),false)
  await assert.rejects(driver.request(b,'ai',`/agent/tasks/${task}`))
  await assert.rejects(driver.request(a,'ai','/agent/tasks',{method:'POST',body:{taskId:task,prompt:'resume'}}),/创建新任务/)
  await driver.request(a,'ai','/agent/tasks',{method:'POST',body:{prompt:'new'}})
  assert.equal(claims.at(-1).id,a.userId);assert.equal(claims.at(-1).officeLegacyRead,undefined)
 }finally{globalThis.fetch=original;await h.close();await rm(dir,{recursive:true,force:true})}
})

test('personal keys fail closed, encrypt at rest, separate users and workspaces, and retain monotonic revisions',async()=>{
 const calls=[],h=await setup(undefined,{personalKeys:false,modelFetch:async(url,options)=>{calls.push({url,authorization:options.headers.authorization});return Response.json({data:[{id:'test-model',type:'text'}]})}})
 try{
  assert.equal(ok(await h.request('GET','/personal-api-key')).configured,false)
  assert.equal((await h.request('GET','/operations/models')).statusCode,409)
  assert.equal(calls.length,0,'workspace credential must never be used as fallback')
  for(const [user,key] of [[h.alice,'synthetic-alice-key'],[h.bob,'synthetic-bob-key']]){
   const saved=ok(await h.request('PUT','/personal-api-key',{apiKey:key,revision:0},user));assert.equal(saved.revision,1);assert.equal(saved.configured,true)
   const view=await h.request('GET','/personal-api-key',undefined,user);assert.equal(view.body.includes(key),false)
   const rows=(await h.query('SELECT encrypted_key FROM personal_model_keys WHERE user_id=$1',[user])).rows;assert.equal(rows[0].encrypted_key.includes(key),false)
  }
  await Promise.all([h.request('POST','/personal-api-key/verify',{},h.alice),h.request('POST','/personal-api-key/verify',{},h.bob)]).then(rs=>rs.forEach(ok))
  assert.deepEqual(new Set(calls.map(c=>c.authorization)),new Set(['Bearer synthetic-alice-key','Bearer synthetic-bob-key']))
  assert.equal(ok(await h.request('GET',`/api/tenants/${h.other}/personal-api-key`)).configured,false)
  assert.equal((await h.request('PUT','/personal-api-key',{apiKey:'synthetic-stale-key',revision:0})).statusCode,409)
  assert.equal(ok(await h.request('DELETE','/personal-api-key',{revision:1})).revision,2)
  assert.equal((await h.request('POST','/personal-api-key/verify',{})).statusCode,409)
  assert.equal(ok(await h.request('GET','/personal-api-key',undefined,h.bob)).configured,true)
  assert.equal(ok(await h.request('PUT','/personal-api-key',{apiKey:'synthetic-alice-next',revision:2})).revision,3)
 }finally{await h.close()}
})

test('video gateway carries each user identity through creation, polling and download; blocks cross-user, rotation, shared token and revoked membership',async()=>{
 const bridgeSecret='synthetic-runtime-bridge-secret',calls=[]
 const h=await setup(undefined,{operationsDriver:{binding:async tenantId=>({tenantId,bridgeSecret})},modelFetch:async(url,options)=>{
  const auth=options.headers.authorization;calls.push({url,auth});await new Promise(r=>setTimeout(r,5))
  if(options.method==='POST')return Response.json({id:`video-${auth.endsWith(h.alice)?'alice':'bob'}`,status:'queued'})
  return url.endsWith('/artifact')?new Response('synthetic-video-bytes',{headers:{'content-type':'video/mp4'}}):Response.json({status:'completed'})
 }})
 try{
  const policy=ok(await h.request('GET','/operations/settings')).policy;policy.tiers.video='sora-2';ok(await h.request('PUT','/operations/settings',{policy}))
  const prefix=`/integrations/model-gateway/${h.tenant}/api/v1/videos/generations`
  const headers=async user=>({authorization:`Bearer ${await personalToken(bridgeSecret,h.tenant,user)}`})
  const alice=await headers(h.alice),bob=await headers(h.bob)
  const create=headers=>h.app.inject({method:'POST',url:prefix,headers,payload:{prompt:'test clip'}})
  const results=await Promise.all([create(alice),create(bob)]);results.forEach(ok)
  assert.equal(calls.length,2);assert.equal(new Set(calls.map(c=>c.auth)).size,2)
  assert.equal((await h.app.inject({url:`${prefix}/video-alice`,headers:bob})).statusCode,404)
  ok(await h.app.inject({url:`${prefix}/video-alice`,headers:alice}))
  const download=await h.app.inject({url:`${prefix}/video-alice/artifact`,headers:alice});assert.equal(download.statusCode,200);assert.equal(download.body,'synthetic-video-bytes')
  const before=calls.length
  assert.equal((await create({authorization:`Bearer ${gatewayToken(bridgeSecret,h.tenant)}`})).statusCode,403)
  ok(await h.request('PUT','/personal-api-key',{apiKey:'synthetic-rotated-personal',revision:1}))
  assert.equal((await h.app.inject({url:`${prefix}/video-alice`,headers:alice})).statusCode,409)
  assert.equal(calls.length,before)
  await h.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[h.tenant,h.bob])
  assert.equal((await h.app.inject({url:`${prefix}/video-bob`,headers:bob})).statusCode,403)
 }finally{await h.close()}
})

test('a newly created employee uses its role and independent versioned skill in chats and archived tasks without restarting',async()=>{
 const h=await setup();try{
  const before=(await h.query('SELECT encrypted_config FROM operations_settings')).rows
  const input={name:'新建测试员',avatarId:'file-agent',departmentId:'archive',jobTitle:'访谈整理员',capabilities:'整理访谈，输出原文和需求表'}
  assert.equal((await h.request('POST','/employees',input,h.bob)).statusCode,403)
  const employee=ok(await h.request('POST','/employees',input)),id=employee.id
  assert.equal((await h.request('POST','/employees',input)).statusCode,409)
  const listed=ok(await h.request('GET','/employees')).employees.find(e=>e.id===id);assert.equal(listed.name,input.name);assert.equal(listed.department,input.jobTitle)
  assert.equal((await h.request('GET',`/api/tenants/${h.other}/employees/${id}/skills`)).statusCode,404)
  assert.equal((await h.request('POST',`/departments/${id}/chat`,{text:'未上岗不能接正式任务',revision:0})).statusCode,409)
  const create={title:'访谈独立规则',requirement:'输出有依据的需求',instructions:'必须使用独立技能标记 FIRST_RULE。'}
  const draft=ok(await h.request('POST','/skills/studio',create)),path=`/skills/studio/${draft.id}`
  h.setAnswer(body=>{
   if(body.tools?.some(t=>t.function?.name==='read_skill')&&body.messages.at(-1).role!=='tool'){
    const path=body.messages.map(m=>typeof m.content==='string'?m.content:'').join('\n').match(/([a-f0-9-]{36}\/SKILL.md)/)?.[1]
    if(path)return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-current-skill',type:'function',function:{name:'read_skill',arguments:JSON.stringify({path})}}]}}],usage:{prompt_tokens:5,completion_tokens:5}})
   }
   return '访谈结果：FIRST_RULE 客户需要每周报告。'
  })
  const trial={requestId:randomUUID(),version:1,employeeId:id,kind:'trial',input:'客户说：需要每周报告。'}
  assert.equal(ok(await h.request('POST',`${path}/run`,trial)).state,'completed')
  const enabled=ok(await h.request('POST',`${path}/enable`,{version:1,trialId:trial.requestId,employeeId:id,confirmed:true}))
  assert.deepEqual(ok(await h.request('GET',`/employees/${id}/skills`)).skillIds,[enabled.installedId])
  assert.deepEqual(ok(await h.request('GET','/employees/file-agent/skills')).skillIds,[])
  ok(await h.request('PUT','/employees/duty/code-agent',{onDuty:false}));ok(await h.request('PUT',`/employees/duty/${id}`,{onDuty:true}))
  const chat=ok(await h.request('POST',`/departments/${id}/chat`,{text:'整理访谈',revision:0}));assert.match(chat.messages.at(-1).text,/FIRST_RULE/)
  const sent=JSON.stringify(h.requests.at(-1).messages);assert.match(sent,/FIRST_RULE/);assert.match(sent,/新建测试员/);assert.match(sent,/访谈整理员/)
  const task={id:randomUUID(),dept:id,title:'新员工文字任务',summary:'整理访谈',request:'整理访谈',status:'queued',due:'2026-11-11',outputKind:'text',attachmentIds:[]}
  await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)',[h.tenant,h.alice,JSON.stringify({tasks:[task],messages:[],batches:[]})])
  const done=ok(await h.request('POST',`/secretary/tasks/${task.id}/run`,{})).board.tasks[0];assert.equal(done.status,'completed');assert.ok(done.archiveFileId)
  assert.equal((await h.request('GET',`/files/${done.archiveFileId}/download`)).statusCode,200)
  ok(await h.request('PUT',path,{...create,version:1,instructions:'新版独立技能 SECOND_RULE。'}))
  const next={...trial,requestId:randomUUID(),version:2};ok(await h.request('POST',`${path}/run`,next));ok(await h.request('POST',`${path}/enable`,{version:2,trialId:next.requestId,employeeId:id,confirmed:true}))
  ok(await h.request('POST',`/departments/${id}/chat`,{text:'使用新规则',revision:chat.revision}))
  assert.ok(h.requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('SECOND_RULE')))
  assert.deepEqual((await h.query('SELECT encrypted_config FROM operations_settings')).rows,before)
 }finally{await h.close()}
})
