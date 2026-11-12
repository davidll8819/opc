import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let vite, http, browser, cache, routing
before(async () => {
  cache = await mkdtemp(join(tmpdir(), 'onboarding-ui-'))
  vite = await createServer({ cacheDir: cache, configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom',
    plugins: [{ name: 'onboarding-fixture', resolveId: id => id === '/__onboarding.js' ? id : undefined, load: id => id === '/__onboarding.js' ? `import React from 'react';import {createRoot} from 'react-dom/client';import {Workspace} from '/src/saas/Workspace.tsx';import '/src/index.css';import '/src/saas/saas.css';const root=createRoot(document.getElementById('root'));window.mount=(role='owner')=>root.render(React.createElement(Workspace,{key:role,tenant:{id:'tenant-a',name:'隔离测试工作空间',plan:'enterprise',role}}));window.mount();` : undefined }] })
  routing = await vite.ssrLoadModule('/src/saas/workspace-route.ts')
})
after(async () => { await browser?.close(); if (http) await new Promise(r => http.close(r)); await vite?.close(); await rm(cache, { recursive: true, force: true }) })
test('workspace links are scoped and validate routes without including task contents', () => {
  const hash = routing.workspaceHash('tenant-a', { tab: 'tasks', filter: 'attention', task: 'task-a' })
  assert.deepEqual(routing.readWorkspaceRoute(hash, 'tenant-a'), { tab: 'tasks', filter: 'attention', task: 'task-a' })
  assert.equal(routing.readWorkspaceRoute(hash, 'tenant-b').tab, 'secretary')
  assert.equal(routing.readWorkspaceRoute('', 'tenant-a').tab, 'secretary')
  assert.equal(routing.readWorkspaceRoute('#workspace=tenant-a&view=start', 'tenant-a').tab, 'secretary')
  assert.equal(routing.readWorkspaceRoute('#workspace=tenant-a&view=evil', 'tenant-a').tab, 'secretary')
  assert.equal(routing.readWorkspaceRoute('#workspace=tenant-a&view=tasks&task=%3Cscript%3E&filter=evil', 'tenant-a').task, undefined)
})
test('browser: secretary default, direct request, delayed reply, task link reload/back and permissions', { skip: process.env.ONBOARDING_BROWSER_TESTS !== '1' }, async () => {
  http = httpServer((req, res) => req.url?.startsWith('/test') ? (res.setHeader('content-type', 'text/html'), res.end('<div id="root"></div><script type="module" src="/__onboarding.js"></script>')) : vite.middlewares(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(r => http.listen(0, '127.0.0.1', r))
  browser = await (await import('playwright')).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = []
  // The isolated middleware server has no HMR socket. Stub only Vite's development
  // hot-reload client; application networking and errors remain fully observable.
  await p.route('**/@vite/client', route => route.fulfill({ contentType: 'application/javascript', body: 'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){},invalidate(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=(url)=>url;' }))
  p.on('pageerror', e => errors.push(e.message))
  let saved = { revision: 0, board: { tasks: [], batches: [], messages: [] } }, submits = 0, payload, release
  const responseGate = new Promise(resolve => { release = resolve })
  await p.route('**/api/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method()
    if (url.pathname.endsWith('/secretary/chat')) {
      submits++; payload = route.request().postDataJSON()
      await responseGate
      const task = { id: 'task-a', batchId: 'batch-a', dept: 'review-agent', engine: 'research-v1', title: '隔离测试调研', due: '2026-10-25', status: 'draft', summary: '准备执行', request: '测试需求' }
      saved = { revision: 1, board: { tasks: [task], batches: [{ id: 'batch-a', status: 'draft' }], messages: [{ id: 'u', role: 'user', text: payload.text }, { id: 'a', role: 'assistant', text: '请确认分工', batchId: 'batch-a' }] } }
      return route.fulfill({ json: saved })
    }
    if (url.pathname.endsWith('/secretary')) return route.fulfill({ json: saved })
    if (url.pathname.endsWith('/workspace/status')) return route.fulfill({ json: { departments: [{ id: 'secretary', ready: true }], uptime: 10, memoryMb: 100 } })
    if (method !== 'GET') throw Error('Unexpected mutation in onboarding test')
    return route.fulfill({ json: { items: [], reminders: [], tasks: [], files: [] } })
  })
  const url = `http://127.0.0.1:${http.address().port}/test`
  await p.goto(url)
  await p.getByRole('button', { name: '消息 与婉儿对话', exact: true }).click()
  await p.getByLabel('给秘书的指令').waitFor()
  assert.equal(await p.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '开始工作', exact: true }).count(), 0)
  const evidence = fileURLToPath(new URL('../../../docs/secretary-entry-evidence-2026-11-03', import.meta.url)); await mkdir(evidence, { recursive: true })
  for (const width of [1440, 768, 390]) {
    await p.setViewportSize({ width, height: 1000 })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: join(evidence, `secretary-${width}.png`), fullPage: true })
  }
  assert.equal(submits, 0)
  await p.setViewportSize({ width: 1440, height: 1000 })
  await p.getByLabel('给秘书的指令').fill('帮我调研秋季产品的竞品，并安排各部门工作。')
  await p.getByRole('button', { name: '发送', exact: false }).last().click()
  await p.waitForFunction(() => document.querySelector('[aria-label="给秘书的指令"]')?.disabled === false)
  await p.getByLabel('给秘书的指令').fill('等待期间写的新草稿')
  release()
  await p.getByText('请确认分工', { exact: true }).waitFor()
  assert.equal(submits, 1)
  assert.equal(payload.text, '帮我调研秋季产品的竞品，并安排各部门工作。')
  assert.equal(payload.brief, undefined)
  assert.equal(await p.getByLabel('给秘书的指令').inputValue(), '等待期间写的新草稿')
  await p.getByRole('button', { name: '隔离测试调研' }).click()
  await p.getByRole('heading', { name: '隔离测试调研' }).waitFor()
  assert.match(p.url(), /task=task-a/)
  await p.reload()
  await p.getByRole('heading', { name: '隔离测试调研' }).waitFor()
  for (const width of [1440, 768, 390]) {
    await p.setViewportSize({ width, height: 1000 })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.screenshot({ path: join(evidence, `task-${width}.png`), fullPage: true })
  }
  await p.getByRole('button', { name: '返回任务列表' }).click()
  await p.getByRole('button', { name: '待我处理', exact: true }).click()
  assert.equal(await p.locator('.result-card').count(), 1)
  await p.goBack()
  await p.goBack()
  await p.getByRole('heading', { name: '隔离测试调研' }).waitFor()
  await p.evaluate(() => { location.hash = ''; window.mount('member') })
  await p.getByRole('button', { name: '消息 与婉儿对话', exact: true }).click()
  await p.getByLabel('给秘书的指令').waitFor()
  assert.equal(await p.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '开始工作', exact: true }).count(), 0)
  assert.equal(await p.getByLabel('给秘书的指令').isDisabled(), true)
  assert.deepEqual(errors, [])
  await p.close()
})
