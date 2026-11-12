import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setup } from '../../../tests/helpers/archive-api-fixture.mjs'

test('browser: skill creation to binding, recruitment seats, work-aware office and responsive record pages', {skip:process.env.STAFF_BROWSER_TESTS!=='1',timeout:180000},async()=>{
 const h=await setup(),cache=await mkdtemp(join(tmpdir(),'staff-ui-'))
 let vite,http,browser
 try{
  h.setAnswer(()=> '## 验收结果\n客户需要每周报告。\n来源：试运行样例。\n未提供预算，需进一步确认。')
  await h.upload('访谈记录与需求清单.txt',Buffer.from('客户需要每周报告。'))
  await h.upload('品牌素材使用说明.txt',Buffer.from('用于隔离界面测试。'))
  const base=h.base
  vite=await createServer({cacheDir:cache,configFile:false,root:fileURLToPath(new URL('..',import.meta.url)),resolve:{alias:{'@':fileURLToPath(new URL('../src',import.meta.url))}},esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime','pixi.js','pixi.js/unsafe-eval','@esotericsoftware/spine-pixi-v8','eventemitter3']},server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',plugins:[{name:'staff-fixture',resolveId:id=>id==='/__staff.js'?id:undefined,load:id=>id==='/__staff.js'?`
    import React from 'react';import{createRoot}from'react-dom/client';import{Skills}from'/src/saas/Skills.tsx';import{Recruitment}from'/src/saas/Recruitment.tsx';import{Settings}from'/src/saas/Settings.tsx';import{WorkspaceErrorBoundary}from'/src/saas/WorkspaceErrorBoundary.tsx';import{ArchiveRoom,TaskCenter}from'/src/saas/TaskCenter.tsx';import{setCsrf}from'/src/saas/api.ts';import '/src/index.css';import '/src/saas/saas.css';
    setCsrf(${JSON.stringify(h.alice)});const base=${JSON.stringify(base)};const root=createRoot(document.getElementById('root'));const view=location.hash.includes('view=secretary')?'recovered':new URL(location.href).searchParams.get('view');
    function SkillsPage(){const[view,setView]=React.useState('studio');return React.createElement(Skills,{base,employeeId:'file-agent',onEmployee(){},returnProfile(){},canEdit:true,view,onView:setView,revision:0,onInstalled(){},openOperations(){}})}
    const tasks=[{id:'fixture-task',dept:'file-agent',title:'整理客户访谈与需求清单',summary:'已提取三项客户需求并保留来源。',status:'completed',due:'今天',priority:'normal',attachmentIds:[],outputKind:'text'}];
    if(view==='office'){root.render(React.createElement('div',{id:'office',style:{height:'640px'}}));setTimeout(async()=>{await import('pixi.js/unsafe-eval');const{OfficeScene}=await import('/src/scene/OfficeScene.ts');window.scene=new OfficeScene();await window.scene.init(document.getElementById('office'),960,640);window.scene.setAutomatic(false);window.officeReady=true},100)}
    else if(view==='recovered')root.render(React.createElement('h1',null,'秘书页面已恢复'));
    else if(view==='settings')root.render(React.createElement(Settings,{base,canEdit:true}));
    else if(view==='crash')root.render(React.createElement(WorkspaceErrorBoundary,{tenantId:'test'},React.createElement(()=>{throw new Error('intentional boundary test')})));
    else if(view==='recruitment')root.render(React.createElement(Recruitment,{base,canEdit:true,onOpenEmployee(){},onOpenSkills(id){window.skillEmployee=id}}));
    else if(view==='archive')root.render(React.createElement(ArchiveRoom,{base,onTask(){}}));
    else if(view==='tasks')root.render(React.createElement(TaskCenter,{base,board:{tasks},filter:'all',onFilter(){},onSelect(){},canEdit:true,onUpdate(){},onOperations(){}}));
    else root.render(React.createElement(SkillsPage));
  `:undefined}]})
  http=httpServer((req,res)=>req.url?.startsWith('/test')?(res.setHeader('content-type','text/html'),res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:1200px;margin:auto;padding:16px"></div><script type="module" src="/__staff.js"></script>')):vite.middlewares(req,res,()=>{res.statusCode=404;res.end()}))
  await new Promise(r=>http.listen(0,'127.0.0.1',r))
  browser=await(await import('playwright')).chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL||undefined})
  const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
  p.on('pageerror',e=>errors.push(e.message))
  await p.route('**/@vite/client',route=>route.fulfill({contentType:'application/javascript',body:'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){},invalidate(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=(u)=>u;'}))
  await p.route('**/api/**',async route=>{
   const request=route.request();const response=await h.request(request.method(),new URL(request.url()).pathname+new URL(request.url()).search,request.postData()?JSON.parse(request.postData()):undefined)
   await route.fulfill({status:response.statusCode,headers:{'content-type':response.headers['content-type']||'application/json'},body:response.rawPayload})
  })
  const url=`http://127.0.0.1:${http.address().port}/test`
  await p.goto(url)
  await p.getByLabel('技能名称',{exact:true}).fill('客户访谈整理')
  await p.getByLabel('希望员工做到什么',{exact:true}).fill('提取需求、保留来源，不编造预算。')
  await p.getByRole('button',{name:'生成技能草稿',exact:true}).click()
  await p.getByText('草稿已生成，请编辑检查后试运行。',{exact:true}).waitFor()
  await p.getByLabel('技能内容',{exact:true}).fill('先列原文，再列客户需求，缺失数据明确标注。')
  await p.getByRole('button',{name:'保存新版本',exact:true}).click()
  await p.getByText('草稿已保存，尚未绑定员工。',{exact:true}).waitFor()
  await p.getByLabel('试运行样例',{exact:true}).fill('客户需要每周报告。')
  await p.getByRole('button',{name:'试运行当前版本',exact:true}).click()
  await p.getByRole('checkbox',{name:'我已检查输出，确认此技能适合所选员工'}).check()
  await p.getByRole('button',{name:'确认启用并绑定所选员工'}).click()
  await p.getByText('已启用并绑定所选员工。其他员工的技能保持不变。',{exact:true}).waitFor()
  assert.equal((await h.query('SELECT department FROM skill_assignments')).rows[0].department,'archive')
  await p.reload();await p.getByRole('button',{name:/客户访谈整理.*v3/}).click()
  await p.getByLabel('技能内容',{exact:true}).waitFor()
  await mkdir('/tmp/wishtaday-staff-ui',{recursive:true})
  for(const width of [1440,768,390]){
   await p.setViewportSize({width,height:1000});await p.screenshot({path:`/tmp/wishtaday-staff-ui/skills-${width}.png`,fullPage:true})
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`skills overflow at ${width}`)
  }
  await p.setViewportSize({width:1440,height:1000});await p.goto(url+'?view=recruitment')
  await p.getByRole('button',{name:'龙傲天 · 员工设置',exact:true}).click()
  const drawer=p.getByRole('dialog',{name:'龙傲天',exact:true})
  await drawer.getByRole('button',{name:'下岗 · 释放工位',exact:true}).click()
  await drawer.getByText('已下岗，可以调整岗位、能力和技能。',{exact:true}).waitFor()
  await drawer.getByRole('button',{name:'关闭员工设置',exact:true}).click()
  await p.getByRole('button',{name:'程知遥 · 员工设置',exact:true}).click()
  let settings=p.getByRole('dialog',{name:'程知遥',exact:true})
  await settings.getByLabel('岗位名称',{exact:true}).fill('销售方案顾问')
  await settings.getByLabel('能力与工作职责',{exact:true}).fill('根据客户需求整理方案，列出信息缺口与跟进计划。')
  assert.equal(await settings.getByRole('button',{name:'上岗 · 加入办公室',exact:true}).isDisabled(),true)
  await p.keyboard.press('Escape')
  await settings.getByText('还有未保存的修改，是否放弃并关闭？',{exact:true}).waitFor()
  await settings.getByRole('button',{name:'继续编辑',exact:true}).click()
  await settings.getByRole('button',{name:'员工技能 · 0/8',exact:true}).click()
  await settings.getByRole('checkbox').first().check()
  await settings.getByRole('button',{name:'保存员工设置',exact:true}).click()
  await settings.getByText('员工设置已保存，后续任务按此设置工作。',{exact:true}).waitFor()
  await settings.getByRole('button',{name:'打开技能库，查找或创建技能',exact:true}).click()
  assert.equal(await p.evaluate(()=>window.skillEmployee),'cheng-zhiyao')
  await settings.getByRole('button',{name:'岗位与能力',exact:true}).click()
  for(const width of [1440,768,390]){
    await p.setViewportSize({width,height:1000})
    await p.screenshot({path:`/tmp/wishtaday-staff-ui/recruitment-settings-${width}.png`,fullPage:true})
    assert.ok(await settings.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'employee settings must not overflow horizontally')
  }
  await settings.getByRole('button',{name:'上岗 · 加入办公室',exact:true}).click()
  await settings.getByRole('button',{name:'下岗 · 释放工位',exact:true}).waitFor()
  assert.equal(await settings.getByLabel('岗位名称',{exact:true}).isDisabled(),false)
  await p.reload();await p.getByRole('button',{name:'程知遥 · 员工设置',exact:true}).click()
  settings=p.getByRole('dialog',{name:'程知遥',exact:true})
  await settings.getByRole('button',{name:'下岗 · 释放工位',exact:true}).waitFor()
  assert.equal(await settings.getByLabel('岗位名称',{exact:true}).inputValue(),'销售方案顾问')
  await settings.getByRole('button',{name:'员工技能 · 1/8',exact:true}).click()
  assert.equal(await settings.getByRole('checkbox').first().isChecked(),true)
  await settings.getByRole('button',{name:'关闭员工设置',exact:true}).click()
  await p.setViewportSize({width:1440,height:1000});await p.screenshot({path:'/tmp/wishtaday-staff-ui/recruitment.png',fullPage:true})
  for(const view of ['archive','tasks'])for(const width of [1440,768,390]){
   await p.setViewportSize({width,height:1000});await p.goto(url+'?view='+view);await p.locator('.results-page').waitFor()
   if(view==='archive')await p.getByRole('heading',{name:'访谈记录与需求清单.txt',exact:true}).waitFor()
   if(view==='tasks') assert.ok(await p.locator('.result-card').evaluate(e=>e.getBoundingClientRect().width/e.parentElement.getBoundingClientRect().width)>.9,'task row must use available width')
   await p.screenshot({path:`/tmp/wishtaday-staff-ui/${view}-${width}.png`,fullPage:true})
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view} overflow at ${width}`)
  }
  await p.setViewportSize({width:1200,height:850});await p.goto(url+'?view=office');await p.waitForFunction(()=>window.officeReady).catch(e=>{throw new Error(errors.join('\n')||e.message)})
  const duty=(await h.request('GET','/employees/duty')).json().items
  await p.evaluate(duty=>{
   const statuses=Object.fromEntries(duty.map(d=>[d.employeeId,{seat:d.seat,status:'idle',label:'空闲',labelEn:'Idle',color:0x4a9c59}]))
   window.scene.setWorkIndicators(statuses);window.scene.requestDeskVisit(1,3,'test');statuses.marvis.status='working';statuses.marvis.label='工作中';window.scene.setWorkIndicators(statuses);window.scene.requestDeskVisit(1,3,'must not interrupt')
  },duty)
  assert.equal(await p.evaluate(()=>window.scene.getAgents().filter(a=>a.onDuty).length),9)
  assert.equal(await p.evaluate(()=>window.scene.getAgents().find(a=>a.id==='code-agent').onDuty),false)
  assert.equal(await p.evaluate(()=>window.scene.getAgents().find(a=>a.id==='cheng-zhiyao').assignedDeskId),'desk-1')
  assert.notEqual(await p.evaluate(()=>window.scene.getAgents().find(a=>a.id==='marvis').mission?.phase),'goto')
  await p.screenshot({path:'/tmp/wishtaday-staff-ui/office.png'})
  // Reuse the intern's actual desk, not a roster index: four reserve identities in turn.
  assert.equal((await h.request('PUT','/employees/duty/cheng-zhiyao',{onDuty:false})).statusCode,200)
  assert.equal((await h.request('PUT','/employees/duty/code-agent',{onDuty:true})).statusCode,200)
  let previous='new-agent-9'
  for(const id of ['cheng-zhiyao','xu-zhining','su-ying','shen-qinglan']){
    assert.equal((await h.request('PUT',`/employees/duty/${previous}`,{onDuty:false})).statusCode,200)
    assert.equal((await h.request('PUT',`/employees/duty/${id}`,{onDuty:true})).statusCode,200)
    const items=(await h.request('GET','/employees/duty')).json().items
    assert.equal(items.find(e=>e.employeeId===id).seat,8)
    await p.evaluate(items=>window.scene.setWorkIndicators(Object.fromEntries(items.map(d=>[d.employeeId,{seat:d.seat,status:'idle',label:'空闲',labelEn:'Idle',color:0x4a9c59}]))),items)
    const result=await p.evaluate(({id,previous})=>{
      const scene=window.scene,entity=scene.agentEntities.get(id)
      for(let n=0;n<40;n++)scene.onTick({deltaTime:3})
      const start={visible:entity.visible,oldVisible:scene.agentEntities.get(previous).visible,variant:entity.libraryCharacter?.variant,libraryVisible:entity.libraryCharacter?.visible,spineVisible:entity.spineChar?.visible,pose:entity.libraryCharacter?.motion.pose}
      const index=scene.getAgents().findIndex(a=>a.id===id)
      scene.requestDeskVisit(index+1,1,'换岗形象验证')
      const walks=new Set(),sheets=new Set()
      for(let n=0;n<2200;n++){
        scene.onTick({deltaTime:3})
        const pose=entity.libraryCharacter.motion.pose;sheets.add(pose.sheet)
        if(pose.sheet==='walk')walks.add(pose.frame)
      }
      return {start,walks:[...walks],sheets:[...sheets],returned:!entity.data.mission,debug:{mission:entity.data.mission,state:entity.data.state,x:entity.data.x,y:entity.data.y,targetX:entity.data.targetX,targetY:entity.data.targetY,holds:entity.holdsMovement,direction:entity.libraryCharacter.motion.direction,targetDirection:entity.libraryCharacter.motion.targetDirection},finalPose:entity.libraryCharacter.motion.pose,visibleCount:[...scene.agentEntities.values()].filter(e=>e.visible).length}
    },{id,previous})
    assert.deepEqual(result.start,{visible:true,oldVisible:false,variant:id,libraryVisible:true,spineVisible:false,pose:{sheet:'sit-back',frame:7,flip:false}})
    assert.equal(result.walks.length,8,`${id}: all walk poses used`)
    assert.ok(result.sheets.includes('turn'))
    assert.equal(result.returned,true,JSON.stringify(result.debug))
    assert.equal(result.finalPose.sheet,'sit-back')
    assert.equal(result.visibleCount,9)
    await p.screenshot({path:`/tmp/wishtaday-staff-ui/replacement-${id}.png`})
    const alpha=await p.evaluate(async id=>{
      const i=new Image();i.src=`/assets/characters/${id}-library-v3/motion.png`;await i.decode()
      const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0)
      const pixels=ctx.getImageData(0,0,i.width,i.height).data
      let transparent=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]===0)transparent++
      const cells=[]
      for(let row=0;row<6;row++)for(let col=0;col<4;col++){
        let count=0;for(let y=row*i.height/6;y<(row+1)*i.height/6;y++)for(let x=col*i.width/4;x<(col+1)*i.width/4;x++)if(pixels[(y*i.width+x)*4+3]>220)count++
        cells.push(count)
      }
      return {ratio:transparent/(i.width*i.height),cells}
    },id)
    assert.ok(alpha.ratio>.5,`${id}: actual transparent background`)
    assert.ok(alpha.cells.every(n=>n>1000),`${id}: every frame has a visible character`)
    previous=id
  }
  await p.goto(url+'?view=settings')
  await p.getByRole('heading',{name:'部门与岗位',exact:true}).waitFor()
  await p.getByRole('button',{name:'新建部门',exact:true}).click()
  await p.getByLabel('部门名称',{exact:true}).fill('客户服务部')
  p.once('dialog',d=>d.dismiss())
  await p.getByRole('button',{name:'公司模型与连接',exact:true}).click()
  assert.equal(await p.getByLabel('部门名称',{exact:true}).inputValue(),'客户服务部','navigation cancellation preserves unsaved department')
  await p.getByLabel('部门职责',{exact:true}).fill('整理客户问题与解决方案')
  await p.getByLabel('部门文字模型',{exact:true}).fill('test-support-model')
  await p.getByRole('button',{name:'新增岗位',exact:true}).click()
  await p.getByLabel('岗位名称',{exact:true}).fill('客户成功专员')
  await p.getByLabel('岗位能力模板',{exact:true}).fill('整理问题，逐项核实并给出建议')
  await p.getByRole('button',{name:'保存部门与岗位',exact:true}).click()
  await p.getByText(/部门和岗位已保存/).waitFor()
  for(const width of [1440,768,390]){
    await p.setViewportSize({width,height:1000})
    await p.screenshot({path:`/tmp/wishtaday-staff-ui/organization-${width}.png`,fullPage:true})
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`organization overflow at ${width}`)
  }
  await p.reload();await p.getByRole('button',{name:/客户服务部.*1 个岗位/}).click()
  assert.equal(await p.getByLabel('部门文字模型',{exact:true}).inputValue(),'test-support-model')
  await p.goto(url+'?view=recruitment')
  await p.getByRole('button',{name:'程知遥 · 员工设置',exact:true}).click()
  settings=p.getByRole('dialog',{name:'程知遥',exact:true})
  await settings.getByLabel('所属部门',{exact:true}).selectOption({label:'客户服务部'})
  await settings.getByLabel('选择岗位模板',{exact:true}).selectOption({label:'客户成功专员'})
  assert.equal(await settings.getByLabel('岗位名称',{exact:true}).inputValue(),'客户成功专员')
  await settings.getByRole('button',{name:'员工模型',exact:true}).click()
  await settings.getByLabel('员工文字模型',{exact:true}).fill('personal-employee-model')
  await settings.getByRole('button',{name:'保存员工设置',exact:true}).click()
  await settings.getByText('员工设置已保存，后续任务按此设置工作。',{exact:true}).waitFor()
  const assigned=(await h.request('GET','/employees/cheng-zhiyao/role')).json()
  assert.equal(assigned.departmentName,'客户服务部');assert.equal(assigned.jobTitle,'客户成功专员')
  assert.equal(assigned.modelOverrides.text,'personal-employee-model');assert.equal(assigned.skillIds.length,1)
  await settings.getByRole('button',{name:'关闭员工设置',exact:true}).click()
  await p.setViewportSize({width:1200,height:850})
  await p.getByRole('button',{name:'创建员工',exact:true}).click()
  const create=p.getByRole('dialog',{name:'创建新员工',exact:true})
  await create.getByLabel('员工姓名',{exact:true}).fill('浏览器新员工')
  await create.getByLabel('使用角色形象',{exact:true}).selectOption('cheng-zhiyao')
  await create.getByLabel('新员工所属部门',{exact:true}).selectOption('archive')
  await create.getByLabel('新员工岗位名称',{exact:true}).fill('访谈分析师')
  await create.getByLabel('新员工能力与职责',{exact:true}).fill('提取访谈依据和客户需求')
  await create.getByRole('button',{name:'创建独立员工',exact:true}).click()
  await p.getByRole('button',{name:'浏览器新员工 · 员工设置',exact:true}).waitFor()
  const custom=(await h.request('GET','/employees')).json().employees.find(e=>e.name==='浏览器新员工')
  assert.ok(custom)
  await h.request('PUT',`/employees/duty/${previous}`,{onDuty:false})
  await p.getByRole('button',{name:'浏览器新员工 · 员工设置',exact:true}).click()
  const customDialog=p.getByRole('dialog',{name:'浏览器新员工',exact:true})
  await customDialog.getByRole('button',{name:'上岗 · 加入办公室',exact:true}).click()
  await customDialog.getByRole('button',{name:'下岗 · 释放工位',exact:true}).waitFor()
  await p.goto(url+'?view=office');await p.waitForFunction(()=>window.officeReady)
  const customDuty=(await h.request('GET','/employees/duty')).json().items
  await p.evaluate(items=>window.scene.setWorkIndicators(Object.fromEntries(items.map(d=>[d.employeeId,{seat:d.seat,custom:d.custom,employeeName:d.name,avatarId:d.avatarId,status:'idle',label:'空闲',labelEn:'Idle',color:0x4a9c59}]))),customDuty)
  const customScene=await p.evaluate(id=>{
    const scene=window.scene;for(let n=0;n<40;n++)scene.onTick({deltaTime:3})
    const e=scene.agentEntities.get(id)
    return {name:e?.data.name,variant:e?.libraryCharacter?.variant,visible:e?.visible,pose:e?.libraryCharacter?.motion.pose.sheet,count:scene.getAgents().filter(a=>a.onDuty).length}
  },custom.id)
  assert.deepEqual(customScene,{name:'浏览器新员工',variant:'cheng-zhiyao',visible:true,pose:'sit-back',count:9})
  await p.screenshot({path:'/tmp/wishtaday-staff-ui/custom-employee-office.png'})
  await p.goto(url+'?view=settings');await p.getByRole('button',{name:'我的 4yi Key',exact:true}).click()
  const keyPanel=p.getByRole('region',{name:'个人 4yi API Key',exact:true})
  const keyInput=keyPanel.getByLabel('个人 4yi API Key',{exact:true})
  assert.equal(await keyInput.getAttribute('type'),'password')
  await keyInput.fill('synthetic-ui-personal-key')
  await keyPanel.getByRole('button',{name:'保存个人 Key',exact:true}).click()
  await keyPanel.getByText(/你的个人 Key 已加密保存/).waitFor()
  assert.equal(await keyInput.inputValue(),'')
  await keyPanel.getByRole('button',{name:'验证连接（不生成）',exact:true}).click()
  await keyPanel.getByText(/连接验证通过/).waitFor()
  for(const width of [1440,390]){
    await p.setViewportSize({width,height:900})
    await p.screenshot({path:`/tmp/wishtaday-staff-ui/personal-key-${width}.png`,fullPage:true})
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
  }
  assert.equal(await p.evaluate(()=>JSON.stringify(localStorage).includes('synthetic-ui-personal-key')),false)
  await keyPanel.getByRole('button',{name:'移除个人 Key',exact:true}).click()
  await keyPanel.getByRole('button',{name:'确认移除',exact:true}).click()
  await keyPanel.getByText(/个人 Key 已移除/).waitFor()
  assert.equal((await h.request('GET','/personal-api-key',undefined,h.bob)).json().configured,true)
  assert.deepEqual(errors,[])
  await p.goto(url+'?view=crash')
  await p.getByRole('alert').getByRole('heading',{name:'这个页面暂时无法显示'}).waitFor()
  await p.getByRole('button',{name:'返回私人秘书',exact:true}).click()
  await p.waitForURL(u=>u.hash==='#workspace=test&view=secretary')
  await p.getByRole('heading',{name:'秘书页面已恢复',exact:true}).waitFor()

 }finally{await browser?.close();if(http)await new Promise(r=>http.close(r));await vite?.close();await h.close();await rm(cache,{recursive:true,force:true})}
})
