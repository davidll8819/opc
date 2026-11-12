import assert from 'node:assert/strict'
import {test} from 'node:test'
import {scryptSync} from 'node:crypto'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import {createServer as httpServer} from 'node:http'
import {setup} from '../../../tests/helpers/archive-api-fixture.mjs'

test('new account: login, two workspaces, personal Key, new department/employee/skill and secretary delivery', {skip:process.env.NEW_USER_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const email='new-user@test.invalid',password='isolated-test-password',salt='isolated-test-salt'
 const h=await setup(undefined,{personalKeys:false,env:{NODE_ENV:'development',AUTH_MODE:'local',APP_ORIGIN:'http://localhost:3000',LOCAL_EMAIL:email,LOCAL_PASSWORD_SALT:salt,LOCAL_PASSWORD_HASH:scryptSync(password,salt,32).toString('hex')}})
 const cache=await mkdtemp(join(tmpdir(),'new-user-ui-'));let vite,http,browser,p,step='setup'
 const report={steps:[],errors:[]};const mark=s=>{step=s;report.steps.push(s)}
 try{
  const prior=(await h.query('SELECT tenant_id,encrypted_config FROM operations_settings')).rows
  vite=await createServer({cacheDir:cache,configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}},esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','pixi.js','pixi.js/unsafe-eval','@esotericsoftware/spine-pixi-v8','eventemitter3']},server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',plugins:[{name:'new-user-fixture',resolveId:id=>id==='/__new_user.js'?id:undefined,load:id=>id==='/__new_user.js'?`import React from 'react';import{createRoot}from'react-dom/client';import SaasApp from '/src/saas/SaasApp.tsx';import '/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(SaasApp));`:undefined}]})
  http=httpServer((req,res)=>req.url?.startsWith('/test')?(res.setHeader('content-type','text/html'),res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__new_user.js"></script>')):vite.middlewares(req,res,()=>{res.statusCode=404;res.end()}))
  await new Promise(r=>http.listen(0,'127.0.0.1',r))
  browser=await(await import('playwright')).chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined})
  p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(12000)
  p.on('pageerror',e=>report.errors.push(e.name+': '+e.message))
  await p.route('**/@vite/client',route=>route.fulfill({contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){},invalidate(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=u=>u;'}))
  // Only the HTTP transport is adapted to Fastify's isolated injector. Real auth,
  // CSRF, tenant creation, persistence and application handlers are exercised.
  for(const pattern of ['**/api/**','**/auth/**','**/public/config'])await p.route(pattern,async route=>{
   const request=route.request(),u=new URL(request.url()),headers={...await request.allHeaders(),origin:'http://localhost:3000'}
   delete headers['content-length'];delete headers.host
   const response=await h.app.inject({method:request.method(),url:u.pathname+u.search,headers,payload:request.postData()||undefined})
   const outgoing={'content-type':response.headers['content-type']||'application/json'}
   if(response.headers['set-cookie'])outgoing['set-cookie']=[response.headers['set-cookie']].flat().join('\n')
   await route.fulfill({status:response.statusCode,headers:outgoing,body:response.rawPayload})
  })
  const url=`http://127.0.0.1:${http.address().port}/test`
  await p.goto(url)
  await p.getByLabel('邮箱',{exact:true}).fill(email);await p.getByLabel('密码',{exact:true}).fill(password);await p.getByRole('button',{name:'登录',exact:true}).click()
  await p.getByRole('heading',{name:'创建你的工作空间',exact:true}).waitFor();mark('fresh-login-with-no-workspace')
  await p.getByLabel('工作空间名称').fill('第一个测试空间');await p.getByRole('button',{name:'创建工作空间',exact:true}).click()
  await p.getByRole('navigation',{name:'主导航'}).waitFor();const first=await p.getByRole('combobox',{name:'切换企业'}).inputValue();assert.ok(first)
  await p.getByRole('button',{name:'＋ 工作空间',exact:true}).click();await p.getByLabel('工作空间名称').fill('第二个测试空间')
  // Two synchronous submits must not create two workspaces.
  await p.getByRole('button',{name:'创建工作空间',exact:true}).evaluate(el=>{el.form.requestSubmit();el.form.requestSubmit()})
  await p.getByRole('navigation',{name:'主导航'}).waitFor();const tenant=await p.getByRole('combobox',{name:'切换企业'}).inputValue();assert.notEqual(tenant,first)
  const base=`/api/tenants/${tenant}`
  const call=async(path,body,method=body===undefined?'GET':'POST')=>p.evaluate(async({path,body,method})=>{const me=await(await fetch('/api/me')).json();const r=await fetch(path,{method,headers:{'content-type':'application/json','x-csrf-token':me.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()}},{path,body,method})
  const me=(await call('/api/me')).body;assert.equal(me.tenants.length,2);assert.equal(me.tenants.find(t=>t.id===tenant).name,'第二个测试空间');mark('new-workspace-selected-no-double-submit')
  const nav=p.getByRole('navigation',{name:'主导航'});await nav.getByRole('button',{name:'设置',exact:true}).click()
  await p.getByRole('button',{name:'我的 4yi Key',exact:true}).click();await p.locator('.personal-key input[type="password"]').fill('synthetic-new-user-personal-key')
  await p.getByRole('button',{name:'保存个人 Key',exact:true}).click();await p.getByText('状态：已保存（不回显原文）',{exact:false}).waitFor()
  assert.equal(await p.locator('.personal-key input[type="password"]').inputValue(),'')
  await p.getByRole('button',{name:'验证连接（不生成）',exact:true}).click();await p.getByText(/连接验证通过，可读取 1 个模型/).waitFor()
  assert.equal((await call(`/api/tenants/${first}/personal-api-key`)).body.configured,false);mark('personal-key-save-verify-and-workspace-isolation')
  await p.getByRole('button',{name:'公司模型与连接',exact:true}).click();await p.getByRole('button',{name:'读取模型列表',exact:true}).click()
  for(const name of ['强推理 模型','快速 模型','低成本 模型'])await p.getByRole('combobox',{name,exact:true}).selectOption('archive-test-model')
  await p.getByRole('button',{name:'保存企业配置',exact:true}).click();await p.getByText('配置已保存，已部署的运行服务会自动使用最新密钥和档位。',{exact:true}).waitFor()
  await p.getByRole('button',{name:'部门与岗位',exact:true}).click();await p.getByRole('button',{name:'新建部门',exact:true}).click();await p.getByLabel('部门名称',{exact:true}).fill('客户验收部');await p.getByLabel('部门职责',{exact:true}).fill('整理访谈，保留依据。')
  await p.getByRole('button',{name:'保存部门与岗位',exact:true}).click();await p.getByText(/部门和岗位已保存/).waitFor();mark('new-department-configured')
  await nav.getByRole('button',{name:'招聘员工',exact:true}).click();await p.getByRole('button',{name:'创建员工',exact:true}).click()
  const create=p.getByRole('dialog',{name:'创建新员工',exact:true});await create.getByLabel('员工姓名',{exact:true}).fill('新用户测试专员');await create.getByRole('combobox',{name:'新员工所属部门'}).selectOption({label:'客户验收部'});await create.getByLabel('新员工岗位名称',{exact:true}).fill('访谈整理员');await create.getByLabel('新员工能力与职责',{exact:true}).fill('原文和结论分开，未知信息不能编造。');await create.getByRole('button',{name:'创建独立员工',exact:true}).click()
  await p.getByRole('button',{name:'新用户测试专员 · 员工设置',exact:true}).waitFor();const employee=(await call(base+'/employees')).body.employees.find(e=>e.name==='新用户测试专员');assert.ok(employee);mark('new-employee-created')
  h.setAnswer(body=>{
   const text=JSON.stringify(body.messages)
   if(text.includes('请安排测试专员完成访谈验收'))return JSON.stringify({reply:'已整理任务，请确认派发。',tasks:[{title:'新员工访谈验收',dept:employee.id,due:'2026-11-11',brief:'客户需要每周报告。请保留原文依据。',dependsOn:[]}]})
   if(body.tools?.some(t=>t.function?.name==='read_skill')&&body.messages.at(-1).role!=='tool'){
    const path=text.match(/([a-f0-9-]{36}\/SKILL.md)/)?.[1]
    if(path)return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'read-onboarding-skill',type:'function',function:{name:'read_skill',arguments:JSON.stringify({path})}}]}}],usage:{prompt_tokens:5,completion_tokens:5}})
   }
   return '## 新员工验收规则\n先列原文，再列结论。\n原文：客户需要每周报告。\n结论：每周交付一次报告。\n预算：未提供。'
  })
  await nav.getByRole('button',{name:'技能库',exact:true}).click();await p.getByRole('button',{name:'创建员工技能',exact:true}).click();await p.getByLabel('使用／试运行员工').selectOption(employee.id)
  await p.getByLabel('技能名称',{exact:true}).fill('新员工访谈规则');await p.getByLabel('希望员工做到什么',{exact:true}).fill('输出原文与结论，不编造预算。');await p.getByRole('button',{name:'生成技能草稿',exact:true}).click();await p.getByText('草稿已生成，请编辑检查后试运行。',{exact:true}).waitFor()
  await p.getByLabel('试运行样例',{exact:true}).fill('客户需要每周报告。');await p.getByRole('button',{name:'试运行当前版本',exact:true}).click();await p.getByRole('checkbox',{name:'我已检查输出，确认此技能适合所选员工'}).check();await p.getByRole('button',{name:'确认启用并绑定所选员工',exact:true}).click();await p.getByText('已启用并绑定所选员工。其他员工的技能保持不变。',{exact:true}).waitFor();mark('skill-generated-tried-enabled-and-bound')
  await nav.getByRole('button',{name:'招聘员工',exact:true}).click();await p.getByRole('button',{name:'龙傲天 · 员工设置',exact:true}).click();let drawer=p.getByRole('dialog',{name:'龙傲天',exact:true});await drawer.getByRole('button',{name:'下岗 · 释放工位',exact:true}).click();await drawer.getByText('已下岗，可以调整岗位、能力和技能。',{exact:true}).waitFor();await drawer.getByRole('button',{name:'关闭员工设置',exact:true}).click()
  await p.getByRole('button',{name:'新用户测试专员 · 员工设置',exact:true}).click();drawer=p.getByRole('dialog',{name:'新用户测试专员',exact:true});await drawer.getByRole('button',{name:'上岗 · 加入办公室',exact:true}).click();await drawer.getByRole('button',{name:'下岗 · 释放工位',exact:true}).waitFor();await drawer.getByRole('button',{name:'关闭员工设置',exact:true}).click();mark('new-employee-on-duty');await h.cache.del(`api-rate:${me.user.id}`) // Advance the synthetic throttle window after the accelerated setup clicks.
  await nav.getByRole('button',{name:'私人秘书',exact:true}).click();await p.locator('.waner-messages-button').click();await p.getByLabel('给秘书的指令').fill('请安排测试专员完成访谈验收，客户需要每周报告。');await p.getByRole('button',{name:/^发送/}).click();await p.getByRole('button',{name:/确认派发/}).waitFor();assert.match(await p.locator('.sec-task-list li').innerText(),/访谈整理员 · 新用户测试专员/);await p.getByRole('button',{name:/确认派发/}).click()
  let snapshot
  for(let i=0;i<40;i++){const response=await call(base+'/secretary');assert.equal(response.status,200,JSON.stringify(response.body));snapshot=response.body;if(snapshot.board.tasks.some(t=>t.dept===employee.id&&t.status==='completed'))break;await new Promise(r=>setTimeout(r,100))}
  const task=snapshot.board.tasks.find(t=>t.dept===employee.id);assert.equal(task?.status,'completed');assert.ok(task.archiveFileId)
  const download=await p.evaluate(async path=>{const r=await fetch(path);return {status:r.status,bytes:(await r.arrayBuffer()).byteLength}},base+'/files/'+task.archiveFileId+'/download');assert.equal(download.status,200);assert.ok(download.bytes>0)
  assert.ok(h.requests.some(r=>r.messages.some(m=>m.role==='tool'&&m.content.includes('新员工验收规则'))));mark('secretary-dispatch-execution-and-archive-download')
  const runtime=await call(base+'/operations/status');report.newWorkspaceVideo=runtime.body;assert.equal(runtime.body.ready,false);assert.match(runtime.body.reason,/运行服务尚未部署/)
  assert.deepEqual((await h.query('SELECT tenant_id,encrypted_config FROM operations_settings WHERE tenant_id=$1',[h.tenant])).rows,prior)
  await mkdir('/tmp/wishtaday-new-user-ui',{recursive:true});await p.screenshot({path:'/tmp/wishtaday-new-user-ui/completed.png',fullPage:true});assert.deepEqual(report.errors,[])
  report.passed=true
 }catch(e){report.pageText=await p?.locator('body').innerText().catch(()=>'');await p?.screenshot({path:'/tmp/wishtaday-new-user-failed.png',fullPage:true}).catch(()=>{});e.message=`${step}: ${e.message}`;throw e}
 finally{await writeFile('/tmp/wishtaday-new-user-flow.json',JSON.stringify(report,null,2));await browser?.close();if(http)await new Promise(r=>http.close(r));await vite?.close();await h.close();await rm(cache,{recursive:true,force:true})}
})
