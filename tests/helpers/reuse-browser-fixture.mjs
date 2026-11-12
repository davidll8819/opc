import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setup } from './archive-api-fixture.mjs'
export async function reuseFixture({ taskView = false } = {}) {
  const h = await setup(),
    root = fileURLToPath(new URL('../../apps/web', import.meta.url)),
    cache = await mkdtemp(join(tmpdir(), 'reuse-browser-'))
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
  const sourceTask = {
    id: taskId,
    batchId: 'source-batch',
    dept: 'file-agent',
    title: '产品说明整理',
    status: 'completed',
    engine: 'research-v1',
    summary: '旧客户私有内容不应带入模板',
    finishedAt: '2026-10-24T00:00:00Z',
  }
  await h.query('UPDATE secretary_workspaces SET board=$3 WHERE tenant_id=$1 AND user_id=$2', [
    h.tenant,
    h.alice,
    { tasks: [sourceTask], messages: [], batches: [] },
  ])
  await h.request('POST', '/reuse', {
    kind: 'brand',
    title: '客户乙用语规范',
    project: '客户乙',
    enabled: true,
    body: {
      content: '用清楚、具体的句子介绍产品，避免无法证实的效果承诺。',
      source: '隔离测试：品牌确认记录',
    },
  })
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
        name: 'reuse-fixture',
        resolveId: (id) => (id === '/fixture.js' ? id : undefined),
        load: (id) =>
          id === '/fixture.js'
            ? taskView ? `import React from 'react';import {createRoot} from 'react-dom/client';import {TaskCenter} from '/src/saas/TaskCenter.tsx';import '/src/index.css';import '/src/saas/saas.css';function Demo(){const [counter,setCounter]=React.useState(0);const task={...${JSON.stringify(sourceTask)},executionNote:'状态刷新 '+counter};return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>setCounter(n=>n+1)},'刷新状态 '+counter),React.createElement(TaskCenter,{base:'/api/tenants/${h.tenant}',board:{tasks:[task],batches:[],messages:[]},filter:'all',selected:task.id,onFilter:()=>{},onSelect:()=>{},onRun:()=>{},onOperations:()=>{},canEdit:true,busyId:'',onUpdate:()=>{}}));}createRoot(document.getElementById('root')).render(React.createElement(Demo));` : `import React from 'react';import {createRoot} from 'react-dom/client';import {ReuseWorkspace,TaskReuseDetails} from '/src/saas/ReuseWorkspace.tsx';import '/src/index.css';import '/src/saas/saas.css';const base='/api/tenants/${h.tenant}';function Demo(){const [board,setBoard]=React.useState({tasks:[${JSON.stringify(sourceTask)}],messages:[],batches:[]});return React.createElement(React.Fragment,null,React.createElement(ReuseWorkspace,{base,board,canRun:true,onDraft:b=>{setBoard(b);document.getElementById('draft-result').textContent='待确认分工已创建';},onTask:id=>{document.getElementById('draft-result').textContent='打开任务 '+id;}}),React.createElement(TaskReuseDetails,{base,task:${JSON.stringify(sourceTask)}}));}createRoot(document.getElementById('root')).render(React.createElement(Demo));`
            : undefined,
      },
    ],
  })
  let member = false
  const server = httpServer(async (req, res) => {
    if (req.url === '/favicon.ico') { res.statusCode = 204; return res.end() }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.end(
        '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Wishtaday 工作知识隔离验证</title><header style="padding:16px 24px;font:16px sans-serif;color:#26372e;border-bottom:1px solid #e1e7e2">◈ Wishtaday · 工作知识隔离验证空间</header><div id="root"></div><p id="draft-result"></p><script type="module" src="/fixture.js"></script>',
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
