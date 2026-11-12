import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttp } from 'node:http'
import { createServer } from 'vite'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setup } from '../../../tests/helpers/archive-api-fixture.mjs'

const opt = { skip: process.env.TASK_PROBLEMS_BROWSER_TESTS !== '1' }
test('real task recovery UI saves locally scoped settings, gates paid resume, preserves drafts after conflict and navigates dependencies', opt, async () => {
  const h = await setup(), cache = await mkdtemp(join(tmpdir(),'task-problems-ui-'))
  let vite, server, browser, mutations = 0
  const taskId = 'design', task = { id: taskId, title: '4yi AI 短视频分镜（隔离验收）', dept: 'new-agent-7', engine: 'department-v1', status: 'blocked', outputKind: 'text', summary: '原任务要求：给出可制作分镜', executionNote: '模型输出额度已耗尽，成果未完整返回', publishRequired: false }
  const waiting = { ...task, id:'video',title:'制作待审视频',dept:'app-agent',status:'queued',dependsOn:['design'] }
  const board = {tasks:[task,waiting],messages:[],batches:[]}
  try {
    await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board,revision) VALUES($1,$2,$3,0)',[h.tenant,h.alice,JSON.stringify(board)])
    await h.query("INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'blocked')",[h.tenant,h.alice,taskId])
    const base = `/api/tenants/${h.tenant}`
    vite = await createServer({ configFile:false, cacheDir:cache, root:fileURLToPath(new URL('..',import.meta.url)), resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}}, esbuild:{jsx:'automatic'}, optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']}, server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom', plugins:[{name:'task-problem-fixture',resolveId:id=>id==='/fixture.jsx'?id:undefined,load:id=>id==='/fixture.jsx'?`import React from 'react';import {createRoot} from 'react-dom/client';import {TaskRecovery} from '/src/saas/TaskRecovery.tsx';import {TaskProgress} from '/src/saas/TaskProgress.tsx';import {setCsrf} from '/src/saas/api.ts';setCsrf('${h.alice}');const root=createRoot(document.getElementById('root'));function App(){const [selected,select]=React.useState('');window.showTask=select;return <main><h1>Wishtaday · 任务处理验收</h1><h2>4yi AI 短视频分镜</h2>{!selected?<TaskProgress compact tasks={${JSON.stringify(board.tasks)}} base='${base}' onOpen={t=>select(t.id)} onRun={()=>{throw Error('Unexpected direct run')}} onOperations={()=>{}}/>:<TaskRecovery key={selected} base='${base}' taskId={selected} onSelect={select} onUpdate={b=>{window.updated=b}}/>}</main>}root.render(<App/>);`:undefined}] })
    server = createHttp(async (req,res)=>{
      if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html lang="zh"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#f5f6f7;font:16px/1.5 system-ui;color:#202328}main{max-width:850px;margin:24px auto;padding:0 16px}h1{font-size:24px}h2{font-size:20px}button{font:inherit}</style></head><body><div id="root"></div><script type="module" src="/fixture.jsx"></script></body></html>');return}
      if(req.url?.startsWith('/api/')){
        try{
          const chunks=[];for await(const chunk of req)chunks.push(chunk)
          const body=Buffer.concat(chunks).toString()
          if(req.method!=='GET'){mutations++;await new Promise(r=>setTimeout(r,200))}
          const r=await h.app.inject({method:req.method,url:req.url,payload:body||undefined,headers:{cookie:req.headers.cookie||'',origin:'https://archive.test','x-csrf-token':req.headers['x-csrf-token']||'',...(body?{'content-type':'application/json'}:{})}})
          res.writeHead(r.statusCode,{'content-type':'application/json'});res.end(r.body)
        }catch{res.writeHead(500);res.end('{}')}
        return
      }
      vite.middlewares(req,res,()=>{res.writeHead(404);res.end()})
    })
    await new Promise(r=>server.listen(0,'127.0.0.1',r))
    const origin=`http://127.0.0.1:${server.address().port}`
    browser=await (await import('playwright')).chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||'chrome'})
    const p=await browser.newPage(),errors=[]
    p.on('pageerror',e=>errors.push(e.message))
    await p.context().addCookies([{name:'office_session',value:h.alice,url:origin}])
    await p.route('**/@vite/client',r=>r.fulfill({contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){},invalidate(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=url=>url;'}))
    await p.goto(origin)
    const designCard=p.locator('details.execution-card').filter({has:p.locator('.execution-title',{hasText:'4yi AI 短视频分镜'})})
    await designCard.locator('summary').click()
    await designCard.getByRole('button',{name:'处理任务问题'}).click()
    await p.getByRole('heading',{name:'回复超过单次长度上限'}).waitFor()
    assert.equal(await p.getByRole('button',{name:'恢复此步骤',exact:true}).isDisabled(),true)
    const dir=fileURLToPath(new URL('../../../docs/task-problems-evidence-2026-10-26/',import.meta.url));await mkdir(dir,{recursive:true})
    for(const width of [1440,768,390]){
      await p.setViewportSize({width,height:1000})
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
      await p.screenshot({path:join(dir,`task-problem-${width}.png`),fullPage:true})
    }
    await writeFile('/private/tmp/task-problem-visual.html',await p.evaluate(()=>{const doc=document.documentElement.cloneNode(true);doc.querySelectorAll('script,link').forEach(n=>n.remove());return '<!doctype html>'+doc.outerHTML}))
    await p.getByLabel('本任务单次输出长度').selectOption('8192')
    await p.getByRole('button',{name:'填入精简交付建议'}).click()
    await p.getByRole('button',{name:'仅保存设置，不执行'}).click()
    await p.getByText('设置已保存，仅影响本任务；尚未恢复或产生模型调用。').waitFor()
    assert.equal(h.requests.length,0)
    assert.equal((await h.query('SELECT state FROM task_jobs WHERE task_id=$1',[taskId])).rows[0].state,'blocked')
    await p.reload();await p.evaluate(()=>window.showTask('design'))
    await p.getByLabel('本任务单次输出长度').waitFor()
    assert.equal(await p.getByLabel('本任务单次输出长度').inputValue(),'8192')
    await h.query('UPDATE secretary_workspaces SET revision=revision+1 WHERE tenant_id=$1 AND user_id=$2',[h.tenant,h.alice])
    await p.getByLabel('补充交付要求（可精简，最多2000字）').fill('冲突期间保留这份草稿')
    await p.getByRole('button',{name:'仅保存设置，不执行'}).click()
    await p.getByRole('alert').filter({hasText:'任务已更新'}).waitFor()
    assert.equal(await p.getByLabel('补充交付要求（可精简，最多2000字）').inputValue(),'冲突期间保留这份草稿')
    await p.getByRole('button',{name:'重新读取任务与已保存设置'}).click()
    await p.getByLabel('本任务单次输出长度').waitFor()
    await p.getByRole('checkbox').check()
    const before=mutations
    await p.getByRole('button',{name:'恢复此步骤',exact:true}).evaluate(button=>{button.click();button.click()})
    await p.getByText('已恢复当前步骤，等待后台执行；前置成果保留。').waitFor()
    assert.equal(mutations-before,1)
    assert.equal((await h.query('SELECT state FROM task_jobs WHERE task_id=$1',[taskId])).rows[0].state,'queued')
    await p.evaluate(()=>window.showTask('video'))
    await p.getByRole('heading',{name:'前置任务尚未完成'}).waitFor()
    await p.getByRole('button',{name:'处理前置任务：4yi AI 短视频分镜（隔离验收）'}).click()
    await p.getByRole('heading',{name:'任务需要处理',exact:true}).waitFor()
    assert.equal(await p.getByLabel('本任务单次输出长度').count(),0)
    assert.deepEqual(errors,[]);assert.equal(h.requests.length,0)
    await writeFile(join(dir,'browser-summary.json'),JSON.stringify({savedWithoutExecution:true,settingsSurviveReload:true,conflictPreservesDraft:true,doubleClickSubmissions:1,dependencyNavigation:true,widths:[1440,768,390],paidModelCalls:0},null,2))
  }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await vite?.close();await rm(cache,{recursive:true,force:true});await h.close()}
})
