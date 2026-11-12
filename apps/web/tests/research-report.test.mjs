import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let vite, http, browser, cache, module, markdown, render, React
const original = { id: 'research-one', dept: 'review-agent', engine: 'research-v1', status: 'completed', title: '竞品调研', summary: '## 结论 / Summary\n原报告结论\n\n## 建议 / Recommendations\n1. 核对官方证据', quality: { status: 'partial', issues: [], questions: [{ id: 'R1Q1', question: '官方价格是多少？', status: 'missing', reason: '未读取到官方价格', evidence: [] }] } }
before(async () => {
  cache = await mkdtemp(join(tmpdir(), 'research-ui-'))
  vite = await createServer({ cacheDir: cache, configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } }, esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom',
    plugins: [{ name: 'research-fixture', resolveId: id => id === '/__research.js' ? id : undefined,
      load: id => id === '/__research.js' ? `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {ResearchReport} from '/src/saas/ResearchReport.tsx';import '/src/index.css';import '/src/saas/saas.css';const root=createRoot(document.getElementById('root'));window.mount=(task)=>flushSync(()=>root.render(React.createElement(ResearchReport,{key:task.id,task,base:'/api/tenants/a',canEdit:true,onUpdate:board=>window.updated=board,onSelect:id=>window.selected=id})));window.ready=true;` : undefined }] })
  module = await vite.ssrLoadModule('/src/saas/research-markdown.ts')
  markdown = (await vite.ssrLoadModule('/src/saas/ReportMarkdown.tsx')).ReportMarkdown
  React = await import('react'); render = (await import('react-dom/server')).renderToStaticMarkup
})
after(async () => { await browser?.close(); if (http) await new Promise(r => http.close(r)); await vite?.close(); await rm(cache, { recursive: true, force: true }) })
test('report renderer escapes scripts, blocks active URLs and images, renders tables and source links', () => {
  const html = render(React.createElement(markdown, { text: '<script>alert(1)</script>\n[bad](javascript:alert)\n![tracking](https://tracker.test/pixel)\n**重点** [S1]\n| 产品 | 证据 |\n| --- | --- |\n| A | 待补查 |', sources: [{ id: 'S1', url: 'https://example.com/source' }] }))
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('<img'))
  assert.match(html, /<table>/); assert.match(html, /<strong>重点/); assert.match(html, /href="https:\/\/example.com\/source"/)
  assert.equal(module.safeSourceUrl('https://user:password@example.com'), undefined)
  assert.equal(module.safeSourceUrl('data:text/html,x'), undefined)
  assert.equal(module.legacyReportSections(original.summary).summary, '原报告结论')
  assert.equal(module.legacyReportSections('## 事实 / Findings\n历史表格').findings, '历史表格')
  assert.equal(module.legacyReportSections('## 事实与对比 / Findings\n## R1 主题\n事实 [S1]\n## 分析 / Analysis\n推断').findings, '## R1 主题\n事实 [S1]')
  assert.match(render(React.createElement(markdown, { text: '3. 第三项' })), /start="3"/)
})
test('actual browser preserves gaps, gates acceptance and cost, submits once and fits three widths', { skip: process.env.RESEARCH_UI_BROWSER_TESTS !== '1' }, async () => {
  http = httpServer((req, res) => req.url === '/test' ? (res.setHeader('content-type', 'text/html'), res.end('<main style="max-width:900px;margin:24px auto;padding:16px;background:white"><div id="root"></div></main><script type="module" src="/__research.js"></script>')) : vite.middlewares(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(r => http.listen(0, '127.0.0.1', r))
  browser = await (await import('playwright')).chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  const p = await browser.newPage(); await p.goto(`http://127.0.0.1:${http.address().port}/test`); await p.waitForFunction(() => window.ready)
  const errors = []; p.on('pageerror', e => errors.push(e.message))
  await p.evaluate(task => window.mount(task), original)
  assert.equal(await p.getByRole('button', { name: '接受当前成果' }).isDisabled(), true)
  await p.getByLabel('我已了解上述缺口，接受当前交付范围').check()
  await p.route('**/accept', async route => { assert.equal(route.request().postDataJSON().acknowledgeGaps, true); await route.fulfill({ json: { board: { tasks: [original] } } }) })
  await p.getByRole('button', { name: '接受当前成果' }).click(); await p.waitForFunction(() => window.updated)
  await p.getByText('需要补充的证据', { exact: true }).click()
  assert.equal(await p.getByText('未读取到官方价格', { exact: true }).first().isVisible(), true)
  await p.getByText('补充调研，保留原报告', { exact: true }).click()
  await p.getByLabel('本轮重点要补查什么').fill('只补查官方价格')
  assert.equal(await p.getByRole('button', { name: '创建补查任务' }).isDisabled(), true)
  await p.getByLabel('我了解补查会使用现有模型额度，实际费用由服务商计费').check()
  let submits = 0, payload
  await p.route('**/follow-up', async route => { submits++; payload = route.request().postDataJSON(); await new Promise(r => setTimeout(r, 150)); await route.fulfill({ json: { taskId: 'new-task', board: { tasks: [original] } } }) })
  const evidence = fileURLToPath(new URL('../../../docs/research-batch-evidence-2026-10-24', import.meta.url)); await mkdir(evidence, { recursive: true })
  for (const width of [1440, 768, 390]) {
    await p.setViewportSize({ width, height: 900 })
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await p.evaluate(() => window.scrollTo(0, 0))
    await p.screenshot({ path: join(evidence, `review-${width}.png`), fullPage: true })
  }
  await p.getByRole('button', { name: '创建补查任务' }).click(); await p.waitForFunction(() => window.selected === 'new-task')
  assert.equal(submits, 1); assert.equal(payload.feedback, '只补查官方价格'); assert.equal(payload.acknowledgeCost, true); assert.match(payload.requestId, /^[a-f0-9-]{36}$/)
  assert.deepEqual(errors, []); await p.close()
})
