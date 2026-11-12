import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setup } from './archive-api-fixture.mjs'
import { beginBilling, finishBilling } from '../../apps/api/src/billing.mjs'
export async function billingFixture() {
  const h = await setup(),
    root = fileURLToPath(new URL('../../apps/web', import.meta.url)),
    cache = await mkdtemp(join(tmpdir(), 'billing-browser-'))
  const taskId = randomUUID()
  await h.query('INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3)', [
    h.tenant,
    h.alice,
    {
      tasks: [{ id: taskId, dept: 'review-agent', title: '费用测试调研' }],
      messages: [],
      batches: [],
    },
  ])
  await h.request('POST', '/billing/prices', {
    model: 'fixture-model',
    input: '1000000',
    output: '2000000',
    saleInput: '2000000',
    saleOutput: '3000000',
    reference: '模拟合同-001',
  })
  const ctx = { tenantId: h.tenant, userId: h.alice, taskId, billingStep: '调研报告汇总' }
  const id = await beginBilling(h.pool, ctx, {
    model: 'fixture-model',
    department: 'market_research',
    input: 1000,
    output: 1000,
  })
  await finishBilling(
    h.pool,
    ctx,
    id,
    'completed',
    { input: 1000, output: 1000 },
    'fixture-receipt-001',
  )
  const unknownId = await beginBilling(h.pool, ctx, {
    model: 'fixture-model',
    department: 'market_research',
    input: 1000,
    output: 1000,
  })
  await finishBilling(h.pool, ctx, unknownId, 'unknown', undefined, 'fixture-receipt-002')
  const vite = await createServer({
    root,
    cacheDir: cache,
    configFile: false,
    resolve: { alias: { '@': root + '/src' } },
    esbuild: { jsx: 'automatic' },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
      ],
    },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    plugins: [
      {
        name: 'billing-fixture',
        resolveId: (id) => (id === '/fixture.js' ? id : undefined),
        load: (id) =>
          id === '/fixture.js'
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import {Usage} from '/src/saas/Usage.tsx';import '/src/index.css';import '/src/saas/saas.css';createRoot(document.getElementById('root')).render(React.createElement(Usage,{base:'/api/tenants/${h.tenant}'}));`
            : undefined,
      },
    ],
  })
  let member = false
  const server = httpServer(async (req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Wishtaday 费用隔离验证</title><header style="padding:16px 24px;font:16px sans-serif;color:#26372e;border-bottom:1px solid #e1e7e2">◈ Wishtaday · 费用隔离验证空间</header><div id="root"></div><script type="module" src="/fixture.js"></script>',
      )
    }
    if (req.url === '/@vite/client') {
      res.setHeader('Content-Type', 'application/javascript')
      return res.end(
        'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=url=>url;',
      )
    }
    if (req.url.startsWith('/api/')) {
      try {
        let body = ''
        for await (const chunk of req) body += chunk
        const r = await h.request(
          req.method,
          req.url,
          body ? JSON.parse(body) : undefined,
          member ? h.bob : h.alice,
        )
        res.statusCode = r.statusCode
        res.setHeader('Content-Type', 'application/json')
        return res.end(r.body)
      } catch {
        res.statusCode = 500
        return res.end('{"error":"fixture failure"}')
      }
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    h,
    taskId,
    unknownId,
    setMember: (value) => {
      member = value
    },
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((r) => server.close(r))
      await vite.close()
      await h.close()
      await rm(cache, { recursive: true, force: true })
    },
  }
}
