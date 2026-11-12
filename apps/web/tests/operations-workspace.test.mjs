import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let vite, browser, http, origin, cacheDir
before(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'ops-ui-vite-'))
  vite = await createServer({
    cacheDir,
    // Avoid a late dependency discovery reloading the mounted test page.
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
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    esbuild: { jsx: 'automatic' },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    plugins: [
      {
        name: 'ops-test',
        resolveId: (id) => (id === '/__ops.js' ? id : undefined),
        load: (id) =>
          id === '/__ops.js'
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {DepartmentChat} from '/src/saas/DepartmentChat.tsx';import {OperationsWorkspace} from '/src/saas/operations/OperationsWorkspace.tsx';const root=createRoot(document.getElementById('root'));window.mount=(mode='ops',base='/api/tenants/a',handoff)=>flushSync(()=>root.render(React.createElement(mode==='chat'?DepartmentChat:OperationsWorkspace,{base,department:'content_ops',canEdit:true,openSettings:()=>{},onOperations:brief=>{window.handed=brief},handoff})));window.mountEmployee=async()=>{await import('/src/index.css');await import('/src/saas/saas.css');const {EmployeeDialog}=await import('/src/saas/EmployeeDialog.tsx');const {TEAM_ROSTER}=await import('/src/data/team.ts');const noop=()=>{};flushSync(()=>root.render(React.createElement(EmployeeDialog,{employee:TEAM_ROSTER.find(x=>x.id==='app-agent'),base:'/api/tenants/a',close:noop,openSettings:noop,openSkills:noop,openOperations:noop,onTool:noop,tasks:[],onRun:noop,onTaskOperations:noop,busyTask:'',canEdit:true})));};window.mountVideoEditor=async(videos=[{url:'/test-video.mp4'}])=>{await import('/src/index.css');await import('/src/saas/saas.css');const {VideoEditor}=await import('/src/saas/operations/VideoEditor.tsx');flushSync(()=>root.render(React.createElement(VideoEditor,{key:'editor',root:'/api/tenants/a/operations',taskId:'aaaaaaaaaaaaaaaaaaaaaaaa',videos,canEdit:true})));};window.mountProvisioning=async(base='/api/tenants/a/operations',canEdit=true)=>{const {VideoProvisioningStatus}=await import('/src/saas/operations/VideoProvisioningStatus.tsx');flushSync(()=>root.render(React.createElement(VideoProvisioningStatus,{key:base,root:base,canEdit,onReady:()=>{window.provisionReady=(window.provisionReady||0)+1}})));};window.ready=true;`
            : undefined,
      },
    ],
  })
})
after(async () => {
  await browser?.close()
  await new Promise((r) => (http ? http.close(r) : r()))
  await vite?.close()
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true })
})
const opt = { skip: process.env.OPERATIONS_UI_BROWSER_TESTS !== '1' }
test(
  'actual YeFan popup keeps readable history, input and send reachable at laptop/mobile sizes',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', respond)
      for (const size of [
        { width: 878, height: 668 },
        { width: 390, height: 760 },
      ]) {
        await p.setViewportSize(size)
        await p.evaluate(() => window.mountEmployee())
        await p.getByRole('button', { name: '发送', exact: true }).waitFor()
        const box = await p.evaluate(() => {
          const r = (e) => {
            const x = e.getBoundingClientRect()
            return { top: x.top, bottom: x.bottom, height: x.height }
          }
          return {
            log: r(document.querySelector('.department-messages')),
            input: r(document.querySelector('textarea')),
            send: r([...document.querySelectorAll('button')].find((b) => b.textContent === '发送')),
          }
        })
        assert.ok(box.send.bottom <= size.height - 8, JSON.stringify(box))
        assert.ok(box.input.height >= 110, JSON.stringify(box))
        assert.ok(box.log.height >= 180, JSON.stringify(box))
      }
    } finally {
      await p.close()
    }
  },
)
async function page() {
  if (!http) {
    http = httpServer((req, res) =>
      req.url === '/test'
        ? (res.setHeader('content-type', 'text/html'),
          res.setHeader('Content-Security-Policy', "media-src 'self' blob:"), res.end('<div id="root"></div><script type="module" src="/__ops.js"></script>'))
        : vite.middlewares(req, res, () => {
            res.statusCode = 404
            res.end()
          }),
    )
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}`
    browser = await (
      await import('playwright')
    ).chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
      // Optional deterministic OS audio sink for CI; does not test physical speakers.
      args: process.env.PLAYWRIGHT_FAKE_AUDIO === '1' ? ['--disable-audio-output'] : [],
    })
  }
  const p = await browser.newPage()
  p.setDefaultTimeout(8000)
  await p.goto(origin + '/test')
  await p.waitForFunction(() => window.ready)
  return p
}
const brief = {
  id: 'brief-a',
  title: '产品视频',
  text: '原始要求：30秒，不发布\n叶凡：分镜',
  sourceMessageId: 'answer',
  sourceRevision: 3,
  createdAt: '2026-10-17T00:00:00Z',
  messages: [],
}

test(
  'video editor submits ordered trims and timed subtitles once and shows the saved download',
  opt,
  async () => {
    const p = await page()
    let body,
      calls = 0,
      saved
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().url().endsWith('/video-access')) return privateAccess(r)
        if (r.request().url().endsWith('/edits/check')) return r.fulfill({ json: { width: 720, height: 1280, duration: 4, warnings: [] } })
        if (r.request().method() === 'POST') {
          calls++
          body = r.request().postDataJSON()
          saved = {
            id: body.requestId,
            spec: { ...body, musicName: 'test.wav' },
            state: 'completed',
            phase: '成片已保存，可以预览和下载',
            result: { width: 720, height: 1280, duration: 4, bytes: 1000 },
            createdAt: new Date().toISOString(),
          }
          return r.fulfill({ json: { edit: saved } })
        }
        return r.fulfill({ json: { items: saved ? [saved] : [] } })
      })
      await p.evaluate(() => window.mountVideoEditor())
      await p.getByRole('button', { name: '打开视频剪辑', exact: true }).click()
      await p.getByRole('spinbutton', { name: '片段1结束', exact: true }).fill('2')
      await p.getByRole('button', { name: '添加片段', exact: true }).click()
      await p.getByRole('spinbutton', { name: '片段2开始', exact: true }).fill('2')
      await p.getByRole('spinbutton', { name: '片段2结束', exact: true }).fill('4')
      await p.getByRole('button', { name: '添加字幕', exact: true }).click()
      await p.getByRole('textbox', { name: '字幕1文字', exact: true }).fill('演示字幕 100%')
      await p.getByRole('button', { name: '导出剪辑成片', exact: true }).click()
      await p.getByRole('button', { name: '下载剪辑成片', exact: true }).waitFor()
      assert.equal(calls, 1)
      assert.deepEqual(
        body.segments.map((s) => [s.start, s.end]),
        [
          [0, 2],
          [2, 4],
        ],
      )
      assert.equal(body.subtitles[0].text, '演示字幕 100%')
      assert.equal(body.subtitles[0].end, 4)
      assert.equal(await p.getByRole('button', { name: '下载剪辑成片', exact: true }).isEnabled(), true)
      const savedId = saved.id
      await p.getByRole('button', { name: '载入这份剪辑设置', exact: true }).click()
      assert.equal(
        await p.getByRole('spinbutton', { name: '片段2开始', exact: true }).inputValue(),
        '2',
      )
      await p.getByRole('button', { name: '导出剪辑成片', exact: true }).click()
      await p.waitForFunction(() => !document.querySelector('.video-editor fieldset').disabled)
      assert.equal(calls, 2)
      assert.equal(body.musicFromEditId, savedId)
      assert.equal(body.music, undefined)
      for (const width of [1440, 768, 390]) {
        await p.setViewportSize({ width, height: 900 })
        const layout = await p.evaluate(() => ({
          page: document.documentElement.scrollWidth,
          width: innerWidth,
          button: document.querySelector('.video-editor .primary').getBoundingClientRect().width,
        }))
        assert.ok(layout.page <= layout.width + 1, JSON.stringify(layout))
        assert.ok(layout.button >= 44)
        if (process.env.VIDEO_EDIT_SCREENSHOTS)
          await p.screenshot({
            path: `${process.env.VIDEO_EDIT_SCREENSHOTS}/editor-${width}.png`,
            fullPage: true,
          })
      }
    } finally {
      await p.close()
    }
  },
)

test('video editor recovers an uncertain export with the original request ID', opt, async () => {
  const p = await page()
  let calls = 0,
    body,
    saved
  try {
    await p.route('**/api/**', (r) => {
      const url = r.request().url()
      if (url.endsWith('/edits/check')) return r.fulfill({ json: { width: 720, height: 1280, duration: 4, warnings: [] } })
      if (r.request().method() === 'POST') {
        calls++
        body = r.request().postDataJSON()
        saved = {
          id: body.requestId,
          spec: body,
          state: 'queued',
          phase: '等待处理',
          createdAt: new Date().toISOString(),
        }
        return r.abort('failed')
      }
      if (url.includes('/video-edits/')) return r.fulfill({ json: { edit: saved } })
      return r.fulfill({ json: { items: saved ? [saved] : [] } })
    })
    await p.evaluate(() => window.mountVideoEditor())
    await p.getByRole('button', { name: '打开视频剪辑', exact: true }).click()
    await p.getByRole('button', { name: '导出剪辑成片', exact: true }).click()
    await p.getByRole('button', { name: '核对这次导出', exact: true }).waitFor()
    assert.equal(
      await p.getByRole('button', { name: '导出剪辑成片', exact: true }).isDisabled(),
      true,
    )
    await p.getByRole('button', { name: '核对这次导出', exact: true }).click()
    await p.waitForFunction(
      () => ![...document.querySelectorAll('button')].some((b) => b.textContent === '核对这次导出'),
    )
    assert.equal(calls, 1)
  } finally {
    await p.close()
  }
})

test('selected video format reaches submission and restores with its saved task', opt, async () => {
  const p = await page()
  let body
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
        body = r.request().postDataJSON()
        return r.fulfill({
          contentType: 'text/event-stream',
          body: 'data: {"taskId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n\n',
        })
      }
      if (u.includes('/submissions/'))
        return r.fulfill({
          json: { submission: { state: 'submitted', runtimeTaskId: 'a'.repeat(24) } },
        })
      if (u.endsWith('/tasks/' + 'a'.repeat(24)))
        return r.fulfill({
          json: {
            status: 'completed',
            videoFormat: { ratio: '9:16', resolution: '1080p' },
            messages: [{ text: '保存的竖屏任务' }],
          },
        })
      return respond(r)
    })
    await p.evaluate(() => window.mount())
    await p.getByRole('checkbox', { name: '指定视频规格' }).check()
    await p.getByLabel('视频比例', { exact: true }).selectOption('9:16')
    await p.getByLabel('视频分辨率', { exact: true }).selectOption('1080p')
    await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('咖啡视频，不发布')
    await p.getByRole('button', { name: '开始制作', exact: true }).click()
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.deepEqual(body.videoFormat, { ratio: '9:16', resolution: '1080p' })
    await p.getByRole('button', { name: '新建任务', exact: true }).click()
    assert.equal(await p.getByRole('checkbox', { name: '指定视频规格' }).isChecked(), false)
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'restore-format',
        text: '',
        runtimeTaskId: 'a'.repeat(24),
      }),
    )
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.equal(await p.getByLabel('视频比例', { exact: true }).inputValue(), '9:16')
    assert.equal(await p.getByLabel('视频分辨率', { exact: true }).inputValue(), '1080p')
    await p.getByRole('checkbox', { name: '指定视频规格' }).uncheck()
    await p
      .getByRole('textbox', { name: '工作要求', exact: true })
      .fill('按工作要求，取消之前指定的规格')
    await p.getByRole('button', { name: '继续这个任务', exact: true }).click()
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.equal(body.videoFormat, null)
  } finally {
    await p.close()
  }
})

test('saved video previews show actual dimensions and fail a mismatched format', opt, async () => {
  const p = await page()
  try {
    await p.route('**/api/**', (r) =>
      r
        .request()
        .url()
        .endsWith('/tasks/' + 'a'.repeat(24))
        ? r.fulfill({
            json: {
              status: 'completed',
              messages: [
                {
                  text: JSON.stringify({
                    status: 'SUCCESS',
                    videoUrl: 'https://example.test/saved.mp4',
                    specification: {
                      requested: { ratio: '9:16', resolution: '1080P' },
                      actual: { width: 1920, height: 1080 },
                      matches: false,
                    },
                  }),
                },
              ],
            },
          })
        : respond(r),
    )
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'mismatch',
        text: '',
        runtimeTaskId: 'a'.repeat(24),
      }),
    )
    await p.getByText('实际：1920 × 1080', { exact: true }).waitFor()
    await p.getByText('要求：9:16 · 1080p', { exact: true }).waitFor()
    assert.equal(await p.getByRole('button', { name: '下载视频 1', exact: true }).isEnabled(), true)
    assert.equal(await p.locator('a[href="https://example.test/saved.mp4"]').count(), 0)
    assert.equal(
      await p.getByText('视频规格未通过，请核对成品；不会自动重新生成。', { exact: true }).count(),
      1,
    )
    assert.equal(await p.getByText('视频规格验收通过', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'a temporary missing reservation after network failure never enables a second paid request',
  opt,
  async () => {
    const p = await page()
    let posts = 0
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
          posts++
          return r.fulfill({ status: 502, json: { message: 'proxy lost response' } })
        }
        if (u.includes('/submissions/'))
          return r.fulfill({ status: 404, json: { message: 'not found yet' } })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('preview')
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByRole('button', { name: '核对提交记录', exact: true }).waitFor()
      assert.equal(
        await p.getByRole('button', { name: '开始制作', exact: true }).isEnabled(),
        false,
      )
      assert.equal(posts, 1)
    } finally {
      await p.close()
    }
  },
)
test('late stop response cannot reload the old task after selecting a new one', opt, async () => {
  const p = await page()
  let held, entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/abort')) {
        held = r
        entered()
        return
      }
      if (u.endsWith('/tasks'))
        return r.fulfill({
          json: { list: [{ id: 'e'.repeat(24), title: '任务B', status: 'completed' }] },
        })
      if (u.endsWith('/tasks/' + 'd'.repeat(24)))
        return r.fulfill({ json: { status: 'running', messages: [{ text: '任务A记录' }] } })
      if (u.endsWith('/tasks/' + 'e'.repeat(24)))
        return r.fulfill({ json: { status: 'completed', messages: [{ text: '任务B记录' }] } })
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'start',
        text: 'A',
        runtimeTaskId: 'd'.repeat(24),
      }),
    )
    await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
    await p.getByRole('button', { name: '停止制作', exact: true }).click()
    await started
    await p.getByRole('button', { name: /任务B ·/ }).click()
    await p.getByText('任务B记录', { exact: true }).waitFor()
    const res = p.waitForResponse((r) => r.url().endsWith('/abort'))
    await held.fulfill({ json: { requested: true } })
    await (await res).finished()
    await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
    assert.equal(await p.getByText('任务A记录', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'recovering a saved submission restores its source even when chat has expired',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (u.endsWith('/submissions'))
          return r.fulfill({
            json: {
              items: [
                { requestId: 'request-saved', state: 'submitted', createdAt: brief.createdAt },
              ],
            },
          })
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: {
              submission: { state: 'submitted', runtimeTaskId: 'f'.repeat(24), briefId: brief.id },
            },
          })
        if (u.endsWith('/briefs/' + brief.id)) return r.fulfill({ json: { brief } })
        if (u.endsWith('/tasks/' + 'f'.repeat(24)))
          return r.fulfill({ json: { status: 'completed', messages: [{ text: '成品' }] } })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('button', { name: /request-/ }).click()
      await p.getByText('方案来源 · 叶凡对话', { exact: true }).waitFor()
      await p.getByText('查看保存的工作要求与方案原文', { exact: true }).click()
      assert.match(await p.locator('.ops-brief-source pre').innerText(), /30秒，不发布/)
    } finally {
      await p.close()
    }
  },
)
// This suite isolates UI behavior. Private storage/session enforcement is exercised
// by tests/private-video.test.mjs and scripts/verify-private-video.mjs.
function privateAccess(r) {
  const body = r.request().postDataJSON()
  return r.fulfill({ json: {
    url: body.kind === 'source' ? body.url : '/test-video.mp4',
    expiresAt: Date.now() + 300000,
  } })
}
async function respond(r) {
  if (r.request().url().endsWith('/video-access')) return privateAccess(r)
  const url = r.request().url()
  if (url.endsWith('/employees')) return r.fulfill({ json: { employees: [] } })
  return r.fulfill({
    json: url.endsWith('/status')
      ? { ready: true, reason: 'ready' }
      : url.endsWith('/conversation')
        ? { revision: 3, messages: [{ id: 'answer', role: 'assistant', text: '已拟定分镜' }] }
        : url.endsWith('/briefs')
          ? { brief }
          : url.includes('/accounts')
            ? { list: [] }
            : { items: [], list: [] },
  })
}
test(
  'YeFan can draft all three kinds and hand a saved reply off without generation',
  opt,
  async () => {
    const p = await page()
    let posts = []
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST')
          posts.push([r.request().url(), r.request().postDataJSON()])
        return respond(r)
      })
      await p.evaluate(() => window.mount('chat'))
      await p.getByRole('button', { name: '视频脚本与分镜', exact: true }).click()
      assert.match(
        await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        /时长/,
      )
      await p.getByRole('button', { name: '带入运营工作台', exact: true }).click()
      await p.waitForFunction(() => window.handed)
      assert.equal(await p.evaluate(() => window.handed.id), 'brief-a')
      assert.equal(posts.length, 1)
      assert.equal(posts[0][1].revision, 3)
      assert.equal(posts[0][1].messageId, 'answer')
    } finally {
      await p.close()
    }
  },
)
test(
  'handoff waits for click; EOF queries real status and shows image/video previews',
  opt,
  async () => {
    const p = await page()
    let posts = 0
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
          posts++
          return r.fulfill({
            contentType: 'text/event-stream',
            body: 'data: ' + JSON.stringify({ taskId: 'a'.repeat(24), text: '已接收' }) + '\n\n',
          })
        }
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: { submission: { state: 'submitted', runtimeTaskId: 'a'.repeat(24) } },
          })
        if (u.endsWith('/tasks/' + 'a'.repeat(24)))
          return r.fulfill({
            json: {
              status: 'completed',
              messages: [
                {
                  text: '制作完成',
                  medias: [
                    { type: 'IMAGE', url: 'https://assets.test/a.png' },
                    { type: 'VIDEO', url: 'https://assets.test/a.mp4' },
                  ],
                },
              ],
            },
          })
        return respond(r)
      })
      await p.evaluate(
        (b) => window.mount('ops', '/api/tenants/a', { id: 'handoff', text: '先做预览', brief: b }),
        brief,
      )
      await p.getByText('方案来源 · 叶凡对话', { exact: true }).waitFor()
      assert.equal(posts, 0)
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByText('视频已生成，等待验收', { exact: true }).waitFor()
      assert.equal(posts, 1)
      assert.equal(await p.locator('.ops-assets img').count(), 1)
      assert.equal(await p.locator('.ops-assets video').count(), 1)
    } finally {
      await p.close()
    }
  },
)
test('uncertain submission blocks a fresh request and offers recovery', opt, async () => {
  const p = await page()
  let posts = 0
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
        posts++
        return r.fulfill({ status: 502, json: { message: '连接断开' } })
      }
      if (u.includes('/submissions/'))
        return r.fulfill({ json: { submission: { state: 'uncertain', runtimeTaskId: null } } })
      return respond(r)
    })
    await p.evaluate(() => window.mount())
    await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('生成视频')
    await p.getByRole('button', { name: '开始制作', exact: true }).click()
    await p.getByText('提交结果待核对，请勿重复生成', { exact: true }).waitFor()
    assert.equal(await p.getByRole('button', { name: '开始制作', exact: true }).isEnabled(), false)
    await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
    assert.equal(posts, 1)
    assert.equal(await p.getByRole('button', { name: '新建任务', exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'SSE ending while runtime runs is not completion; later real status completes it',
  opt,
  async () => {
    const p = await page()
    let completed = false
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks'))
          return r.fulfill({
            contentType: 'text/event-stream',
            body: 'data: ' + JSON.stringify({ taskId: 'b'.repeat(24) }) + '\n\n',
          })
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: { submission: { state: 'submitted', runtimeTaskId: 'b'.repeat(24) } },
          })
        if (u.endsWith('/tasks/' + 'b'.repeat(24)))
          return r.fulfill({
            json: {
              status: completed ? 'completed' : 'running',
              messages: [{ text: 'runtime log' }],
            },
          })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('制作')
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
      assert.equal(await p.getByText('制作已完成，请验收成果', { exact: true }).count(), 0)
      assert.equal(
        await p.getByRole('button', { name: '继续这个任务', exact: true }).isEnabled(),
        false,
      )
      completed = true
      await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
      await p.getByText('制作已完成，请验收成果', { exact: true }).waitFor()
    } finally {
      await p.close()
    }
  },
)
test('a delayed handoff task cannot replace a newer handoff or another tenant', opt, async () => {
  const p = await page()
  let held, entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.route('**/api/**', (r) => {
      if (
        r
          .request()
          .url()
          .endsWith('/tasks/' + 'c'.repeat(24))
      ) {
        held = r
        entered()
        return
      }
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'old',
        text: '旧交接',
        runtimeTaskId: 'c'.repeat(24),
      }),
    )
    await started
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', { id: 'new', text: '新的工作要求' }),
    )
    const response = p.waitForResponse((r) => r.url().endsWith('/tasks/' + 'c'.repeat(24)))
    await held.fulfill({ json: { status: 'completed', messages: [{ text: '过期内容' }] } })
    await (await response).finished()
    assert.equal(
      await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
      '新的工作要求',
    )
    assert.equal(await p.getByText('过期内容', { exact: true }).count(), 0)
    await p.evaluate(() => window.mount('ops', '/api/tenants/other'))
    assert.equal(await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(), '')
    assert.equal(await p.getByText('过期内容', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test('selecting a slow task cancels the old running task poll', opt, async () => {
  const p = await page()
  let aRequests = 0,
    held,
    entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.clock.install()
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/tasks'))
        return r.fulfill({
          json: { list: [{ id: 'e'.repeat(24), title: '慢任务B', status: 'completed' }] },
        })
      if (u.endsWith('/tasks/' + 'd'.repeat(24))) {
        aRequests++
        return r.fulfill({ json: { status: 'running', messages: [{ text: 'A正在制作' }] } })
      }
      if (u.endsWith('/tasks/' + 'e'.repeat(24))) {
        held = r
        entered()
        return
      }
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'old-poll',
        text: 'A',
        runtimeTaskId: 'd'.repeat(24),
      }),
    )
    await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
    await p.getByRole('button', { name: /慢任务B ·/ }).click()
    await started
    await p.clock.runFor(6000)
    assert.equal(aRequests, 1)
    await held.fulfill({ json: { status: 'completed', messages: [{ text: '慢任务B结果' }] } })
    await p.getByText('慢任务B结果', { exact: true }).waitFor()
  } finally {
    await p.close()
  }
})

test('completed export archives explicitly; failure retries the same version without generating again', opt, async () => {
  const p = await page()
  let archives = 0, renders = 0
  const saved = { id: '11111111-1111-4111-8111-111111111111', spec: { title: '真实流程成片' }, state: 'completed', phase: '导出完成', result: { width: 1280, height: 720, duration: 4, bytes: 1000 }, createdAt: new Date().toISOString() }
  try {
    await p.route('**/api/**', r => {
      if(r.request().url().endsWith('/video-access'))return privateAccess(r)
      if (r.request().method() === 'POST') {
        if (r.request().url().endsWith('/archive')) {
          archives++
          if (archives === 1) return r.fulfill({status:409,json:{error:'资料空间已满，归档未完成'}})
          saved.result.archive = { fileId: 'saved-video', manifestId: 'saved-record', archivedAt: new Date().toISOString() }
          return r.fulfill({json:{archive:saved.result.archive}})
        }
        renders++
      }
      return r.fulfill({json:{items:[saved]}})
    })
    await p.evaluate(() => window.mountVideoEditor())
    await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.getByRole('button',{name:'确认成片并归档',exact:true}).click()
    await p.getByText('资料空间已满，归档未完成',{exact:true}).waitFor()
    await p.getByRole('button',{name:'确认成片并归档',exact:true}).click()
    await p.getByText('已确认并归档到任务成果和资料室。尚未对外发布。',{exact:true}).waitFor()
    assert.equal(archives,2)
    assert.equal(renders,0)
    assert.equal(await p.getByRole('button',{name:'下载归档成片',exact:true}).isEnabled(),true)
    assert.equal(await p.getByRole('button',{name:'确认成片并归档',exact:true}).count(),0)
  } finally { await p.close() }
})

test('quota warning preserves the generated video and editing entry', opt, async () => {
  const p = await page()
  const warning = '企业今日模型额度不足，后续文字整理中断；已保存的视频可继续剪辑、下载和归档。请等待次日或由管理员确认额度。'
  try {
    await p.route('**/api/**', r => {
      if (r.request().url().endsWith('/tasks/' + 'f'.repeat(24))) return r.fulfill({json:{
        status:'completed', completionWarning:warning, messages:[],
        savedVideos:[{status:'SUCCESS',videoUrl:'https://assets.test/confirmed.mp4'}],
      }})
      return respond(r)
    })
    await p.evaluate(()=>window.mount('ops','/api/tenants/a',{id:'quota',text:'本次视频',runtimeTaskId:'f'.repeat(24)}))
    await p.getByText(warning,{exact:true}).waitFor()
    await p.getByRole('button',{name:'打开视频剪辑',exact:true}).waitFor()
    assert.equal(await p.locator('.ops-assets video').count(),1)
    assert.equal(await p.getByText('制作已完成，请验收成果',{exact:true}).count(),0)
  } finally { await p.close() }
})

test('video draft survives refresh with music and incomplete subtitles; failed save keeps typing; conflicts never overwrite',opt,async()=>{
  const p=await page();let saved=null,revision=0,fail=false,conflict=false,puts=0
  try {
    await p.route('**/api/**',r=>{
      if(r.request().url().endsWith('/edit-draft')){
        if(r.request().method()==='PUT'){
          puts++
          if(fail)return r.fulfill({status:503,json:{error:'保存服务暂时不可用'}})
          if(conflict)return r.fulfill({status:409,json:{error:'另一个窗口已更新草稿'}})
          saved=r.request().postDataJSON().content;revision++
        }
        return r.fulfill({json:{content:saved,revision}})
      }
      return r.fulfill({json:{items:[]}})
    })
    const mount=async()=>{await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()}
    await mount()
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('自动保存验收')
    await p.getByRole('button',{name:'添加字幕',exact:true}).click()
    await p.locator('input[type=file]').setInputFiles({name:'测试配乐.wav',mimeType:'audio/wav',buffer:Buffer.from('draft-test-audio')})
    await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    assert.equal(saved.music.name,'测试配乐.wav');assert.equal(saved.draft.subtitles[0].text,'')
    await p.reload();await p.waitForFunction(()=>window.ready);await mount()
    await p.getByText('已恢复上次草稿',{exact:true}).waitFor()
    assert.equal(await p.getByRole('textbox',{name:'成片名称',exact:true}).inputValue(),'自动保存验收')
    assert.equal(await p.getByRole('textbox',{name:'字幕1文字',exact:true}).inputValue(),'')
    assert.ok(await p.getByText(/测试配乐.wav/).count())
    fail=true
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('网络故障时继续输入')
    await p.getByText(/草稿未保存：保存服务暂时不可用/).waitFor()
    assert.equal(await p.getByRole('textbox',{name:'成片名称',exact:true}).inputValue(),'网络故障时继续输入')
    fail=false
    await p.getByRole('button',{name:'重试保存草稿',exact:true}).click()
    await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    conflict=true
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('不能覆盖另一窗口')
    await p.getByText(/草稿未保存：另一个窗口已更新草稿/).waitFor()
    const count=puts
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('继续保留本窗口内容')
    await p.waitForTimeout(700)
    assert.equal(puts,count);assert.equal(saved.draft.title,'网络故障时继续输入')
  }finally{await p.close()}
})

test('real video metadata defaults to landscape 1080p; cover preview matches target aspect; saved choice wins',opt,async()=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises')
  const file=join(cacheDir,'preview.mp4')
  await promisify(execFile)(fileURLToPath(new URL('../../../.local/media-tools/bin/ffmpeg',import.meta.url)),['-y','-f','lavfi','-i','color=c=blue:s=1920x1080:r=30:d=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',file])
  const bytes=await readFile(file),p=await page();let content=null,revision=0
  try {
    await p.route('**/test-video.mp4',r=>r.fulfill({contentType:'video/mp4',body:bytes}))
    await p.route('**/api/**',r=>{
      if(r.request().url().endsWith('/edit-draft')){
        if(r.request().method()==='PUT'){content=r.request().postDataJSON().content;revision++}
        return r.fulfill({json:{content,revision}})
      }
      return r.fulfill({json:{items:[]}})
    })
    await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('video')?.videoWidth===1920)
    await p.waitForFunction(()=>document.querySelector('select option[value="16:9"]')?.selected)
    assert.equal(await p.getByRole('combobox',{name:'导出清晰度',exact:true}).inputValue(),'1080p')
    assert.equal(await p.getByRole('spinbutton',{name:'片段1结束',exact:true}).inputValue(),'1')
    await p.getByRole('combobox',{name:'成片比例',exact:true}).selectOption('9:16')
    await p.getByRole('combobox',{name:'画面适配',exact:true}).selectOption('cover')
    await p.getByText(/当前将居中裁掉画面边缘/).waitFor()
    for(const width of [390,940,1440]){
      await p.setViewportSize({width,height:900})
      const result=await p.locator('video').first().evaluate(v=>({ratio:v.getBoundingClientRect().width/v.getBoundingClientRect().height,fit:getComputedStyle(v).objectFit,overflow:document.documentElement.scrollWidth>innerWidth}))
      assert.ok(Math.abs(result.ratio-9/16)<0.01,JSON.stringify(result));assert.equal(result.fit,'cover');assert.equal(result.overflow,false)
    }
    await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    await p.reload();await p.waitForFunction(()=>window.ready);await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('video')?.videoWidth===1920)
    assert.equal(await p.getByRole('combobox',{name:'成片比例',exact:true}).inputValue(),'9:16')
    assert.equal(await p.getByRole('combobox',{name:'画面适配',exact:true}).inputValue(),'cover')
  }finally{await p.close()}
})

test('slow draft save serializes newer typing and never restores a stale response over it',opt,async()=>{
  const p=await page();let held,content=null,revision=0;const titles=[]
  try {
    await p.route('**/api/**',r=>{
      if(r.request().url().endsWith('/edit-draft')){
        if(r.request().method()==='PUT'){
          const body=r.request().postDataJSON();titles.push(body.content.draft.title)
          if(titles.length===1){held=r;content=body.content;return}
          assert.equal(body.revision,1);content=body.content;revision++
        }
        return r.fulfill({json:{content,revision}})
      }
      return r.fulfill({json:{items:[]}})
    })
    await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('第一份草稿')
    await p.waitForRequest(r=>r.method()==='PUT' && r.url().endsWith('/edit-draft'))
    await p.getByRole('textbox',{name:'成片名称',exact:true}).fill('请求期间输入的新草稿')
    revision=1;await held.fulfill({json:{content,revision}})
    await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    assert.deepEqual(titles,['第一份草稿','请求期间输入的新草稿'])
    assert.equal(content.draft.title,'请求期间输入的新草稿')
    assert.equal(await p.getByRole('textbox',{name:'成片名称',exact:true}).inputValue(),'请求期间输入的新草稿')
  }finally{await p.close()}
})

function servePreviewMedia(route,bytes,mime){
  const range=/^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '')
  const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1
  return route.fulfill({status:range?206:200,headers:{'content-type':mime,'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})},body:bytes.subarray(start,end+1)})
}

test('real draft preview plays cuts, live captions and looping music; seek, pause, volumes and unmount stay in sync',opt,async()=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises')
  const ffmpeg=fileURLToPath(new URL('../../../.local/media-tools/bin/ffmpeg',import.meta.url)),videoFile=join(cacheDir,'live-preview.mp4'),audioFile=join(cacheDir,'live-music.wav')
  await promisify(execFile)(ffmpeg,['-y','-f','lavfi','-i','color=c=blue:s=640x360:r=30:d=4','-f','lavfi','-i','sine=frequency=220:duration=4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',videoFile])
  await promisify(execFile)(ffmpeg,['-y','-f','lavfi','-i','sine=frequency=440:duration=0.7','-c:a','pcm_s16le',audioFile])
  const bytes=await readFile(videoFile),music=await readFile(audioFile),p=await page();let exports=0
  const draft={title:'预览验收',segments:[{url:'/test-video.mp4',start:0.2,end:1.6},{url:'/test-video.mp4',start:2.1,end:3.5}],subtitles:[{start:0,end:1.4,text:'第一段中文字幕'},{start:1.4,end:2.8,text:'第二段中文字幕'}],ratio:'16:9',resolution:'720p',fit:'contain',originalVolume:0.65,musicVolume:0.25}
  try{
    await p.route('**/test-video.mp4',r=>servePreviewMedia(r,bytes,'video/mp4'))
    await p.route('**/api/**',r=>{
      if(r.request().url().endsWith('/edit-draft'))return r.fulfill({json:{content:{draft,formatInitialized:true,savedMusic:{id:'11111111-1111-4111-8111-111111111111',name:'循环配乐.wav'}},revision:1}})
      if(r.request().url().endsWith('/music'))return servePreviewMedia(r,music,'audio/wav')
      if(r.request().url().endsWith('/video-access'))return privateAccess(r)
      if(r.request().method()==='POST')exports++
      return r.fulfill({json:{items:[]}})
    })
    await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('video')?.readyState>=2 && document.querySelector('audio')?.readyState>=2)
    await p.getByTestId('preview-caption').getByText('第一段中文字幕',{exact:true}).waitFor()
    await p.getByRole('textbox',{name:'字幕1文字',exact:true}).fill('立即更新字幕')
    assert.equal(await p.getByTestId('preview-caption').textContent(),'立即更新字幕')
    await p.getByRole('button',{name:'播放完整预览',exact:true}).click()
    await p.waitForFunction(()=>{const a=document.querySelector('audio'),v=document.querySelector('video');return !a.paused&&!v.paused&&v.currentTime>0.35})
    await p.getByRole('button',{name:'暂停预览',exact:true}).click()
    const paused=await p.evaluate(()=>({v:document.querySelector('video').paused,a:document.querySelector('audio').paused,volume:document.querySelector('video').volume,music:document.querySelector('audio').volume}))
    assert.deepEqual(paused,{v:true,a:true,volume:0.65,music:0.25})
    await p.getByRole('slider',{name:'原声音量',exact:true}).fill('0.3')
    await p.getByRole('slider',{name:'配乐音量',exact:true}).fill('0.6')
    await p.getByRole('slider',{name:'成片预览进度',exact:true}).fill('1.7')
    await p.waitForFunction(()=>Math.abs(document.querySelector('video').currentTime-2.4)<0.04)
    assert.equal(await p.getByTestId('preview-caption').textContent(),'第二段中文字幕')
    const synced=await p.evaluate(()=>({musicTime:document.querySelector('audio').currentTime,volume:document.querySelector('video').volume,music:document.querySelector('audio').volume}))
    assert.ok(Math.abs(synced.musicTime-0.3)<0.04);assert.equal(synced.volume,0.3);assert.equal(synced.music,0.6)
    await p.locator('input[type=file]').setInputFiles({name:'实时上传.wav',mimeType:'audio/wav',buffer:music})
    await p.waitForFunction(()=>document.querySelector('audio')?.readyState>=2 && document.querySelector('audio').src.startsWith('blob:'))
    await p.getByRole('button',{name:'从头预览',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('video')?.readyState>=2 && !document.querySelector('video').seeking)
    await p.getByRole('button',{name:'播放完整预览',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('[aria-label="预览时间"]')?.textContent.startsWith('2.80'))
    assert.equal(await p.getByTestId('preview-caption').count(),0)
    assert.equal(await p.getByRole('combobox',{name:'预览片段',exact:true}).inputValue(),'1')
    assert.equal(await p.locator('audio').evaluate(a=>a.paused),true)
    await p.getByRole('button',{name:'播放完整预览',exact:true}).click()
    await p.waitForFunction(()=>!document.querySelector('audio').paused)
    await p.evaluate(()=>{window.previewMedia=[document.querySelector('video'),document.querySelector('audio')]})
    await p.getByRole('button',{name:'收起剪辑',exact:true}).click()
    assert.equal(await p.evaluate(()=>window.previewMedia.every(m=>m.paused)),true)
    await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.locator('input[type=file]').setInputFiles({name:'损坏测试.wav',mimeType:'audio/wav',buffer:Buffer.from('not audio')})
    await p.getByText('配乐无法播放，请重新选择MP3、WAV或M4A文件。',{exact:true}).waitFor()
    await p.getByRole('button',{name:'移除配乐',exact:true}).click()
    await p.locator('audio').waitFor({state:'detached'})
    assert.equal(await p.locator('audio').count(),0)
    await p.getByRole('spinbutton',{name:'片段1结束',exact:true}).fill('0')
    assert.equal(await p.getByRole('button',{name:'播放完整预览',exact:true}).isEnabled(),false)
    assert.equal(exports,0,'preview must not render or invoke models')
  }finally{await p.close()}
})

test('preflight blocks invalid media, confirms warnings and rechecks changed settings', opt, async () => {
  const p = await page()
  let mode = 'broken', checks = 0, exports = 0
  try {
    await p.route('**/api/**', r => {
      const u = r.request().url()
      if (u.endsWith('/edits/check')) {
        checks++
        if (mode === 'broken') return r.fulfill({status: 422, json: {error: '配乐无法读取，请换成可播放的音频文件'}})
        if (mode === 'offline') return r.abort('failed')
        return r.fulfill({json: {width: 720, height: 1280, duration: 5, warnings: ['片段1会裁掉部分画面，请先核对预览']}})
      }
      if (r.request().method() === 'POST') {
        exports++
        const body = r.request().postDataJSON()
        return r.fulfill({json: {edit: {id: body.requestId, spec: body, state: 'queued', phase: '等待处理'}}})
      }
      return r.fulfill({json: {items: []}})
    })
    await p.evaluate(() => window.mountVideoEditor())
    await p.getByRole('button', {name:'打开视频剪辑',exact:true}).click()
    const submit = () => p.getByRole('button', {name:'导出剪辑成片',exact:true}).click()
    await submit()
    await p.getByText('配乐无法读取，请换成可播放的音频文件',{exact:true}).waitFor()
    assert.equal(exports, 0)
    assert.equal(await p.getByRole('button',{name:'核对这次导出',exact:true}).count(),0)
    mode = 'offline'
    await submit()
    await p.waitForFunction(() => !document.querySelector('.video-editor fieldset').disabled)
    assert.equal(exports,0)
    assert.equal(await p.getByRole('button',{name:'核对这次导出',exact:true}).count(),0)
    mode = 'warnings'
    await submit()
    await p.getByRole('button',{name:'确认提示并导出',exact:true}).waitFor()
    assert.equal(exports,0)
    await p.getByRole('spinbutton',{name:'片段1结束',exact:true}).fill('3')
    await p.getByText('设置已修改，导出时会重新检查。',{exact:true}).waitFor()
    await submit()
    await p.getByRole('button',{name:'确认提示并导出',exact:true}).waitFor()
    assert.equal(exports,0)
    await p.getByRole('button',{name:'确认提示并导出',exact:true}).click()
    await p.waitForFunction(() => !document.querySelector('.video-editor fieldset').disabled)
    assert.equal(exports,1)
    assert.equal(checks,5)
  } finally { await p.close() }
})

test('quota failure without a generated video never offers a completed film or automatic retry', opt, async () => {
  const p=await page(),warning='企业今日模型额度不足，本次制作未完成，尚未确认可用视频。请等待次日或由管理员确认额度后，再手动继续原任务。'
  let posts=0
  try{
    await p.route('**/api/**',r=>{
      if(r.request().method()==='POST')posts++
      if(r.request().url().endsWith('/tasks/'+'f'.repeat(24)))return r.fulfill({json:{status:'completed',completionWarning:warning,messages:[],savedVideos:[]}})
      return respond(r)
    })
    await p.evaluate(()=>window.mount('ops','/api/tenants/a',{id:'no-video-quota',text:'四镜头任务',runtimeTaskId:'f'.repeat(24)}))
    await p.getByText(warning,{exact:true}).waitFor()
    assert.equal(await p.getByRole('button',{name:'打开视频剪辑',exact:true}).count(),0)
    assert.equal(await p.getByText('制作已完成，请验收成果',{exact:true}).count(),0)
    assert.equal(await p.locator('.ops-assets video').count(),0)
    assert.equal(posts,0)
  }finally{await p.close()}
})

test('single-shot replacement stages, validates, cancels, undoes and persists without changing captions or music', opt, async () => {
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises')
  const ffmpeg=fileURLToPath(new URL('../../../.local/media-tools/bin/ffmpeg',import.meta.url))
  const goodFile=join(cacheDir,'replacement-good.mp4'),shortFile=join(cacheDir,'replacement-short.mp4'),musicFile=join(cacheDir,'replacement-music.wav')
  for(const [file,length,color] of [[goodFile,6,'green'],[shortFile,1,'red']])
    await promisify(execFile)(ffmpeg,['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=320x180:r=30:d=${length}`,'-c:v','libx264','-pix_fmt','yuv420p',file])
  await promisify(execFile)(ffmpeg,['-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',musicFile])
  const good=await readFile(goodFile),short=await readFile(shortFile),audio=await readFile(musicFile)
  for(const uploaded of [false,true]) {
    const p=await page(), urls=['/test-video.mp4','/replacement-good.mp4','/replacement-short.mp4','/replacement-broken.mp4']
    const before={draft:{title:'保留其他设置',segments:[{url:urls[0],start:0.5,end:2.5},{url:urls[0],start:1,end:4},{url:urls[0],start:0,end:2}],subtitles:[{start:0,end:3,text:'第一条字幕'},{start:3,end:7,text:'第二条字幕'}],ratio:'16:9',resolution:'1080p',fit:'cover',originalVolume:0.3,musicVolume:0.4},formatInitialized:true,...(uploaded?{music:{name:'上传配乐.wav',base64:audio.toString('base64')}}:{savedMusic:{id:'11111111-1111-4111-8111-111111111111',name:'历史配乐.wav'}})}
    let saved=structuredClone(before),revision=1,puts=0,posts=0
    async function changeAndSave(action) {
      const response=p.waitForResponse(r=>r.request().method()==='PUT' && r.url().endsWith('/edit-draft'))
      await action();await (await response).finished()
      await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    }
    try {
      await p.route('**/*.mp4',r=> r.request().url().endsWith('replacement-broken.mp4') ? r.fulfill({status:404}) : servePreviewMedia(r,r.request().url().endsWith('replacement-short.mp4')?short:good,'video/mp4'))
      await p.route('**/api/**',r=>{
        if(r.request().url().endsWith('/edit-draft')) {
          if(r.request().method()==='PUT'){saved=r.request().postDataJSON().content;revision++;puts++}
          return r.fulfill({json:{content:saved,revision}})
        }
        if(r.request().url().endsWith('/music'))return servePreviewMedia(r,audio,'audio/wav')
        if(r.request().method()==='POST')posts++
        return r.fulfill({json:{items:[]}})
      })
      await p.evaluate(urls=>window.mountVideoEditor(urls.map(url=>({url}))),urls)
      await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
      await p.getByRole('button',{name:'替换片段2',exact:true}).click()
      const apply=p.getByRole('button',{name:'确认替换片段 2',exact:true})
      await p.waitForFunction(()=>document.querySelector('[aria-label="替换素材预览"]')?.readyState>=2)
      await apply.waitFor();assert.equal(await apply.isEnabled(),true)
      assert.equal(await p.getByRole('button',{name:'导出剪辑成片',exact:true}).isEnabled(),false)
      if(!uploaded) for(const width of [1440,768,390]) {
        await p.setViewportSize({width,height:900})
        const panel=p.getByRole('region',{name:'替换片段2',exact:true})
        await panel.scrollIntoViewIfNeeded()
        const layout=await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,controls:[...el.querySelectorAll('input,select,button')].map(c=>{const r=c.getBoundingClientRect();return {left:r.left,right:r.right,height:r.height}})}))
        assert.ok(layout.scroll<=layout.width+1,`replacement panel overflows at ${width}`)
        assert.ok(layout.controls.every(c=>c.left>=0 && c.right<=width && c.height>=32),`replacement controls clipped at ${width}`)
        await panel.screenshot({path:fileURLToPath(new URL(`../../../docs/six-improvements-evidence-2026-10-23/replacement-panel-${width}.png`,import.meta.url))})
      }
      await p.getByRole('button',{name:'取消替换',exact:true}).click()
      assert.deepEqual(saved,before);assert.equal(puts,0)
      await p.getByRole('button',{name:'替换片段2',exact:true}).click()
      await p.getByLabel('替换素材',{exact:true}).selectOption(urls[2])
      await p.getByText(/新素材时长1.00秒，无法截取/).waitFor()
      assert.equal(await apply.isEnabled(),false);assert.deepEqual(saved,before)
      await p.getByLabel('替换素材',{exact:true}).selectOption(urls[3])
      await p.getByText('素材无法播放，请重试或选择其他素材。',{exact:true}).waitFor()
      assert.equal(await apply.isEnabled(),false)
      await p.getByLabel('替换素材',{exact:true}).selectOption(urls[1])
      await p.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认替换片段 2')?.disabled)
      await p.getByLabel('新素材开始（秒）',{exact:true}).fill('')
      assert.equal(await apply.isEnabled(),false)
      await p.getByLabel('新素材开始（秒）',{exact:true}).fill('2')
      await changeAndSave(()=>apply.click())
      const expected=structuredClone(before);expected.draft.segments[1]={url:urls[1],start:2,end:5}
      assert.deepEqual(saved,expected)
      await p.getByLabel('字幕1文字',{exact:true}).fill('替换后修改字幕')
      await changeAndSave(()=>p.getByRole('button',{name:'撤销本次替换',exact:true}).click())
      const undone=structuredClone(before);undone.draft.subtitles[0].text='替换后修改字幕'
      assert.deepEqual(saved,undone)
      await p.getByRole('button',{name:'替换片段2',exact:true}).click()
      await p.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='确认替换片段 2')?.disabled)
      await changeAndSave(()=>apply.click())
      const restored=structuredClone(undone);restored.draft.segments[1].url=urls[1]
      assert.deepEqual(saved,restored)
      await p.reload();await p.waitForFunction(()=>window.ready)
      await p.evaluate(urls=>window.mountVideoEditor(urls.map(url=>({url}))),urls)
      await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
      await p.getByText('已恢复上次草稿',{exact:true}).waitFor()
      await p.getByRole('combobox',{name:'预览片段',exact:true}).selectOption('1')
      await p.waitForFunction(()=>document.querySelector('[aria-label="剪辑原素材预览"]')?.currentSrc.endsWith('/replacement-good.mp4'))
      assert.equal(await p.getByLabel('字幕1文字',{exact:true}).inputValue(),'替换后修改字幕')
      assert.deepEqual(saved,restored);assert.equal(posts,0,'replacement never calls generation or export')
    }finally{await p.close()}
  }
})

test('voiceover adoption preserves music, saves captions and audio settings; versions compare and finalize', opt, async () => {
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{readFile}=await import('node:fs/promises')
  const ffmpeg=fileURLToPath(new URL('../../../.local/media-tools/bin/ffmpeg',import.meta.url))
  const mediaFile=join(cacheDir,'voice-ui-video.mp4'),audioFile=join(cacheDir,'voice-ui.mp3')
  await promisify(execFile)(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=30:d=5','-c:v','libx264','-pix_fmt','yuv420p',mediaFile])
  await promisify(execFile)(ffmpeg,['-y','-v','error','-f','lavfi','-i','sine=frequency=440:duration=1',audioFile])
  const media=await readFile(mediaFile),audio=await readFile(audioFile)
  const p=await page(), draft={title:'配音测试',segments:[{url:'/test-video.mp4',start:0,end:5}],subtitles:[{start:0,end:2,text:'旧字幕'}],ratio:'16:9',resolution:'720p',fit:'contain',originalVolume:0.3,musicVolume:0.4}
  let saved={draft,formatInitialized:true,music:{name:'原配乐.mp3',base64:audio.toString('base64')}}, revision=1,finalId=''
  const edits=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'].map((id,i)=>({id,state:'completed',phase:'已保存',spec:{...draft,title:'版本'+(i+1)},result:{width:1280,height:720,duration:5,bytes:100},createdAt:'2026-10-23T01:00:00Z'}))
  try {
    await p.route('**/test-video.mp4',r=>servePreviewMedia(r,media,'video/mp4'))
    await p.route('**/api/**',r=>{
      const url=r.request().url(),method=r.request().method()
      if(url.endsWith('/edit-draft')) {
        if(method==='PUT'){saved=r.request().postDataJSON().content;revision++}
        return r.fulfill({json:{content:saved,revision}})
      }
      if(url.endsWith('/narration')) return r.fulfill({json:{narration:{name:'中文配音.mp3',base64:audio.toString('base64')},subtitles:[{start:0,end:1,text:'新的配音字幕'}],duration:1}})
      if(url.endsWith('/final')){finalId=url.split('/').at(-2);return r.fulfill({json:{ok:true}})}
      if(url.includes('/media'))return servePreviewMedia(r,media,'video/mp4')
      return r.fulfill({json:{items:edits.map(e=>({...e,isFinal:e.id===finalId}))}})
    })
    await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.getByLabel('配音文案',{exact:true}).fill('新的配音字幕。')
    await p.getByRole('button',{name:'生成配音试听',exact:true}).click()
    await p.getByLabel('同时用配音字幕替换当前字幕',{exact:true}).check()
    await p.getByRole('button',{name:'采用这份配音',exact:true}).click()
    await p.getByLabel('配乐淡入淡出（秒）',{exact:true}).fill('1')
    await p.getByText('草稿已自动保存',{exact:true}).waitFor()
    assert.equal(saved.music.name,'原配乐.mp3');assert.equal(saved.narration.name,'中文配音.mp3')
    assert.equal(saved.draft.subtitles[0].text,'新的配音字幕');assert.equal(saved.draft.musicFade,1);assert.equal(saved.draft.duckMusic,true)
    await p.getByRole('button',{name:'播放完整预览',exact:true}).click()
    await p.waitForFunction(()=>document.querySelector('[aria-label="草稿配音"]')?.currentTime>0.2).catch(async e=>{console.log('Audio preview diagnostics',await p.evaluate(()=>({media:[...document.querySelectorAll('video,audio')].map(v=>({label:v.getAttribute('aria-label'),ready:v.readyState,time:v.currentTime,paused:v.paused,seeking:v.seeking,error:v.error?.message})),errors:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)})));throw e})
    const volumes=await p.evaluate(()=>({voice:document.querySelector('[aria-label="草稿配音"]').volume,music:document.querySelector('[aria-label="草稿配乐"]').volume}))
    assert.equal(volumes.voice,1);assert(volumes.music<=0.11)
    await p.getByRole('button',{name:'暂停预览',exact:true}).click()
    await p.getByLabel('对照版本',{exact:true}).selectOption(edits[1].id)
    assert.equal(await p.getByRole('region',{name:'版本对照',exact:true}).locator('video').count(),2)
    await p.getByRole('button',{name:'将本版本标记为定稿',exact:true}).click()
    await p.getByRole('button',{name:'当前定稿',exact:true}).waitFor();assert.equal(finalId,edits[0].id)
    await p.reload();await p.waitForFunction(()=>window.ready);await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click()
    await p.getByText('已恢复上次草稿',{exact:true}).waitFor()
    assert.equal(await p.getByLabel('字幕1文字',{exact:true}).inputValue(),'新的配音字幕')
    assert.equal(await p.getByLabel('配乐淡入淡出（秒）',{exact:true}).inputValue(),'1')
  } finally {await p.close()}
})

test('fractional source timestamps remain valid and export without silently truncating the tail', opt, async()=>{
 const p=await page();let submitted
 const draft={title:'毫秒片尾验收',segments:[{url:'/test-video.mp4',start:0,end:5.038}],subtitles:[{start:0.001,end:5.037,text:'保留完整片尾'}],ratio:'16:9',resolution:'720p',fit:'contain',originalVolume:1,musicVolume:0.2}
 try{
  await p.route('**/api/**',r=>{
   const url=r.request().url()
   if(url.endsWith('/video-access'))return privateAccess(r)
   if(url.endsWith('/edit-draft'))return r.fulfill({json:{content:{draft,formatInitialized:true},revision:1}})
   if(url.endsWith('/edits/check'))return r.fulfill({json:{width:1280,height:720,duration:5.038,warnings:[]}})
   if(url.endsWith('/edits')&&r.request().method()==='POST'){
    submitted=r.request().postDataJSON()
    return r.fulfill({json:{edit:{id:submitted.requestId,state:'completed',phase:'已完成',spec:submitted,result:{width:1280,height:720,duration:5.038,bytes:100},createdAt:new Date().toISOString()}}})
   }
   return r.fulfill({json:{items:[]}})
  })
  await p.evaluate(()=>window.mountVideoEditor());await p.getByRole('button',{name:'打开视频剪辑',exact:true}).click();await p.getByText('已恢复上次草稿',{exact:true}).waitFor()
  assert.equal(await p.getByRole('spinbutton',{name:'片段1结束',exact:true}).inputValue(),'5.038')
  assert.deepEqual(await p.locator('.video-editor input:invalid').evaluateAll(xs=>xs.map(x=>x.getAttribute('aria-label'))),[])
  await p.getByRole('button',{name:'导出剪辑成片',exact:true}).click();await p.getByRole('button',{name:'下载剪辑成片',exact:true}).waitFor()
  assert.equal(submitted.segments[0].end,5.038);assert.equal(submitted.subtitles[0].end,5.037)
 }finally{await p.close()}
})

test('video provisioning shows failure, prevents duplicate retry, polls ready and keeps member controls read-only', opt, async () => {
  const p = await page()
  let state = 'failed', attempts = 0
  try {
    await p.route('**/api/**', respond)
    await p.route('**/operations/provisioning', route => route.fulfill({ json: {
      state, stage: state, message: state === 'failed' ? '视频服务开通失败，请重试' : state === 'queued' ? '等待开通视频服务' : '视频服务已开通', canRetry: state === 'failed',
    } }))
    await p.route('**/operations/provisioning/retry', async route => {
      attempts++; await new Promise(r => setTimeout(r, 300)); state = 'queued'
      await route.fulfill({ json: { state, stage: state, message: '等待开通视频服务', canRetry: false } })
    })
    await p.evaluate(() => window.mountProvisioning())
    for (const width of [1440, 768, 390]) {
      await p.setViewportSize({ width, height: 900 })
      await p.getByRole('button', { name: '重试开通', exact: true }).waitFor()
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await p.screenshot({ path: `/tmp/wishtaday-provisioning-${width}.png` })
    }
    await p.getByRole('button', { name: '重试开通', exact: true }).evaluate(el => { el.click(); el.click() })
    await p.getByText('等待开通视频服务', { exact: true }).waitFor()
    assert.equal(attempts, 1)
    state = 'ready'
    await p.getByText('视频服务已开通', { exact: true }).waitFor({ timeout: 8000 })
    assert.equal(await p.evaluate(() => window.provisionReady), 1)
    assert.equal(await p.getByRole('button', { name: '重试开通', exact: true }).count(), 0)
    state = 'failed'
    await p.evaluate(() => window.mountProvisioning('/api/tenants/b/operations', false))
    await p.getByText('请联系工作空间管理员开通。', { exact: true }).waitFor()
    assert.equal(await p.getByRole('button', { name: '重试开通', exact: true }).count(), 0)
  } finally { await p.close() }
})
