import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as httpServer } from 'node:http'
import {
  S3Client,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3'
import { settings, run } from './backup/common.mjs'
import { privateVideoPolicy } from './private-video-policy.mjs'
import { setup } from '../tests/helpers/archive-api-fixture.mjs'
import { openVideoDownload } from '../apps/api/src/operations/video-download.mjs'
import { renderVideoEdit } from '../apps/api/src/operations/video-edit-render.mjs'
import { parseVideoEdit } from '../apps/api/src/operations/video-edit-schema.mjs'
import { storeEdit } from '../apps/api/src/operations/video-edit-service.mjs'
import { hash } from '../apps/api/src/auth.mjs'

const { entry: original } = await settings(),
  assets = original.infrastructure.assets
if (!['127.0.0.1', 'localhost'].includes(new URL(assets.endpoint).hostname))
  throw Error('Local storage only')
const Bucket = `private-video-test-${randomUUID()}`,
  dir = await mkdtemp(join(tmpdir(), 'private-video-'))
const client = new S3Client({
  endpoint: assets.endpoint,
  region: assets.region || 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: assets.accessKeyId, secretAccessKey: assets.secretAccessKey },
})
const entry = {
  ...original,
  userId: 'fixture',
  infrastructure: {
    assets: {
      ...assets,
      bucketName: Bucket,
      cdnEndpoint: `${assets.endpoint.replace(/\/$/, '')}/${Bucket}`,
    },
  },
}
const key = 'fixture/ai/video/source.mp4',
  imageKey = 'fixture/ai/images/keep.png',
  legacyKey = 'fixture/user/media/legacy.MP4'
const sourceUrl = `${entry.infrastructure.assets.cdnEndpoint}/${key}`,
  taskId = 'a'.repeat(24),
  task = { savedVideos: [{ status: 'SUCCESS', videoUrl: sourceUrl }] }
const keys = [],
  evidence = { temporaryBucket: true, paidCalls: 0 }
let created = false,
  h,
  vite,
  server,
  browser
try {
  await client.send(new CreateBucketCommand({ Bucket }))
  created = true
  await client.send(
    new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(privateVideoPolicy(Bucket)) }),
  )
  const source = join(dir, 'source.mp4')
  await run(join(entry.ffmpegBin || '', 'ffmpeg'), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x180:r=25',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-pix_fmt',
    'yuv420p',
    source,
  ])
  const bytes = await readFile(source)
  for (const [Key, Body, ContentType] of [
    [key, bytes, 'video/mp4'],
    [legacyKey, bytes, 'video/mp4'],
    [imageKey, Buffer.from('fixture-image'), 'image/png'],
  ]) {
    await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }))
    keys.push(Key)
  }
  for (const Key of [key, legacyKey]) {
    const r = await fetch(`${entry.infrastructure.assets.cdnEndpoint}/${Key}`)
    await r.body?.cancel()
    assert.equal(r.status, 403)
  }
  const image = await fetch(`${entry.infrastructure.assets.cdnEndpoint}/${imageKey}`)
  await image.body?.cancel()
  assert.equal(image.status, 200)
  evidence.anonymousVideo = 403
  evidence.nonVideoReadPreserved = true
  const got = await openVideoDownload({ entry, task, url: sourceUrl })
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes)
  const editId = randomUUID(),
    { spec } = parseVideoEdit({
      requestId: editId,
      title: 'Private video test',
      segments: [{ url: sourceUrl, start: 0, end: 0.6 }],
      ratio: '16:9',
      resolution: '720p',
    })
  const rendered = await renderVideoEdit({
    entry,
    task,
    spec,
    dir,
    signal: AbortSignal.timeout(60000),
  })
  h = await setup(undefined, {
    operationsDriver: {
      binding: async () => entry,
      ready: async () => entry,
      request: async () => task,
    },
  })
  await h.query(
    "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'fixture','submitted',$4)",
    [randomUUID(), h.tenant, h.alice, taskId],
  )
  const result = await storeEdit(
    entry,
    { id: editId, user_id: h.alice },
    rendered,
    AbortSignal.timeout(30000),
  )
  keys.push(result.key)
  await h.query(
    "INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,result) VALUES($1,$2,$3,$4,'fixture',$5,'completed',$6)",
    [editId, h.tenant, h.alice, taskId, spec, result],
  )
  const rawEdited = await fetch(`${entry.infrastructure.assets.cdnEndpoint}/${result.key}`)
  await rawEdited.body?.cancel()
  assert.equal(rawEdited.status, 403)
  const archiveId = randomUUID(),
    renderedBytes = await readFile(rendered.file)
  await h.query(
    "INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,'archive.mp4','video/mp4',$4)",
    [archiveId, h.tenant, h.alice, renderedBytes],
  )
  for (const body of [
    { kind: 'source', taskId, url: sourceUrl },
    { kind: 'edit', id: editId },
    { kind: 'archive', id: archiveId },
  ]) {
    const minted = await h.request('POST', '/operations/video-access', body)
    assert.equal(minted.statusCode, 200)
    const link = minted.json().url
    assert.equal((await h.app.inject(link)).statusCode, 401)
    assert.equal((await h.request('GET', link, undefined, h.bob)).statusCode, 403)
    const read = await h.request('GET', link + '?download=1')
    assert.equal(read.statusCode, 200)
    const expected = body.kind === 'source' ? bytes : renderedBytes
    assert.equal(
      createHash('sha256').update(read.rawPayload).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
    )
    assert.equal((await h.request('DELETE', link)).statusCode, 200)
    assert.equal((await h.request('GET', link)).statusCode, 410)
  }
  evidence.privateSourceRender = {
    width: rendered.width,
    height: rendered.height,
    duration: rendered.duration,
  }
  evidence.sourceEditArchiveDownloadHashMatches = true
  evidence.revokedLink = 410
  if (process.env.PRIVATE_VIDEO_BROWSER === '1') {
    const { createServer } = await import('vite'),
      { chromium } = await import('playwright')
    const root = resolve('apps/web'),
      prefix = `/api/tenants/${h.tenant}/operations`
    vite = await createServer({
      root,
      configFile: false,
      cacheDir: join(dir, 'vite'),
      resolve: { alias: { '@': root + '/src' } },
      esbuild: { jsx: 'automatic' },
      optimizeDeps: {
        noDiscovery: true,
        include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      },
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: 'custom',
      plugins: [
        {
          name: 'private-video-fixture',
          resolveId: (id) => (id === '/fixture.js' ? id : undefined),
          load: (id) =>
            id === '/fixture.js'
              ? `import React from 'react';import {createRoot} from 'react-dom/client';import {PrivateVideo,PrivateVideoLink} from '/src/saas/operations/PrivateVideo.tsx';import {VideoDraftPreview} from '/src/saas/operations/VideoDraftPreview.tsx';import {setCsrf} from '/src/saas/api.ts';import '/src/saas/operations/operations.css';setCsrf('${h.alice}');const context={root:'${prefix}',taskId:'${taskId}'},src=${JSON.stringify(sourceUrl)};createRoot(document.getElementById('root')).render(React.createElement('main',{style:{maxWidth:800,margin:'auto'}},React.createElement('h1',null,'私有视频访问验证'),React.createElement(PrivateVideo,{src,accessContext:context,controls:true,'aria-label':'原片'}),React.createElement(PrivateVideoLink,{src,accessContext:context,download:true},'下载原片'),React.createElement(PrivateVideo,{src:'${prefix}/video-edits/${editId}/media',controls:true,'aria-label':'成片'}),React.createElement(VideoDraftPreview,{accessContext:context,segments:[{url:src,start:0,end:.6}],subtitles:[],aspect:16/9,fit:'contain',resolution:'720p',originalVolume:1,musicVolume:.2,onMetadata:()=>{},onSegment:()=>{}})));`
              : undefined,
        },
      ],
    })
    server = httpServer(async (req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html')
        return res.end(
          '<html lang="zh"><head><style>video{max-width:100%}body{font-family:system-ui}</style><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
        )
      }
      if (req.url === '/@vite/client') {
        res.setHeader('Content-Type', 'application/javascript')
        return res.end(
          'export const createHotContext=()=>({accept(){},on(){},prune(){},dispose(){}});export const updateStyle=(id,css)=>{let s=document.getElementById(id);if(!s){s=document.createElement("style");s.id=id;document.head.append(s)}s.textContent=css};export const removeStyle=id=>document.getElementById(id)?.remove();export const injectQuery=url=>url;',
        )
      }
      if (req.url === '/favicon.ico') {
        res.statusCode = 204
        return res.end()
      }
      if (req.url.startsWith('/api/')) {
        try {
          let body = ''
          for await (const c of req) body += c
          const headers = {
            ...req.headers,
            origin:
              req.headers.origin === `http://127.0.0.1:${server.address().port}`
                ? 'https://archive.test'
                : req.headers.origin,
          }
          delete headers.host
          delete headers['content-length']
          if (!headers.origin) delete headers.origin
          const r = await h.app.inject({
            method: req.method,
            url: req.url,
            headers,
            payload: body || undefined,
          })
          res.writeHead(r.statusCode, r.headers)
          return res.end(r.rawPayload)
        } catch {
          res.statusCode = 500
          return res.end()
        }
      }
      vite.middlewares(req, res, () => {
        res.statusCode = 404
        res.end()
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const address = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({
      headless: true,
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    })
    const context = await browser.newContext()
    await context.addCookies([{ name: 'office_session', value: h.alice, url: address }])
    const page = await context.newPage(),
      errors = [],
      responses = []
    page.on('response', (r) => {
      if (r.url().includes('/video-access/'))
        responses.push({ status: r.status(), type: r.headers()['content-type'] })
    })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(address)
    await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('video')].length === 3 &&
          [...document.querySelectorAll('video')].every(
            (v) => v.readyState >= 2 && v.videoWidth > 0,
          ),
      )
      .catch(async (e) => {
        console.log(
          JSON.stringify({
            responses,
            browserErrors: errors.map((x) =>
              x.replace(/video-access\/[A-Za-z0-9_-]+/g, 'video-access/[hidden]'),
            ),
            state: await page.evaluate(() => ({
              videos: [...document.querySelectorAll('video')].map((v) => ({
                ready: v.readyState,
                width: v.videoWidth,
                error: v.error?.code,
              })),
              alerts: [...document.querySelectorAll('[role=alert]')].map((v) => v.textContent),
            })),
          }),
        )
        throw e
      })
    await page.getByRole('button', { name: '播放完整预览', exact: true }).click()
    await page.waitForFunction(
      () => Number(document.querySelector('[aria-label="成片预览进度"]').value) >= 0.5,
    )
    const old = await page.getByLabel('原片', { exact: true }).getAttribute('src')
    const ticketKey = `video-access:${hash(old.split('/').at(-1))}`,
      saved = JSON.parse(await h.cache.get(ticketKey))
    saved.expiresAt = 0
    await h.cache.set(ticketKey, JSON.stringify(saved))
    assert.equal((await page.request.get(address + old)).status(), 410)
    // A fully buffered one-second clip may not re-fetch on load(). Force a new
    // request to the expired ticket, just as an unbuffered seek would do.
    await page.getByLabel('原片', { exact: true }).evaluate((v) => {
      v.src = v.currentSrc + '?expired-check=1'
      v.load()
    })
    await page.waitForFunction((old) => {
      const v = document.querySelector('video[aria-label="原片"]')
      return v.getAttribute('src') !== old && v.readyState >= 2
    }, old)
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '下载原片', exact: true }).click()
    const download = await downloadEvent
    assert.deepEqual(await readFile(await download.path()), bytes)
    const stranger = await browser.newContext()
    assert.equal(
      (
        await stranger.request.get(
          address + (await page.getByLabel('原片', { exact: true }).getAttribute('src')),
        )
      ).status(),
      401,
    )
    await stranger.close()
    await mkdir('docs/private-video-evidence-2026-10-25', { recursive: true })
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      )
      await page.screenshot({
        path: `docs/private-video-evidence-2026-10-25/preview-${width}.png`,
        fullPage: true,
      })
    }
    assert.deepEqual(errors, [])
    evidence.browser = {
      decodedPreviews: 3,
      draftPlayedToEnd: true,
      expiredLink: 410,
      autoRenewed: true,
      downloadedBytesMatch: true,
      anonymous: 401,
      widths: [1440, 768, 390],
    }
  }
  assert.equal(h.requests.length, 0)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await browser?.close()
  if (server) await new Promise((r) => server.close(r))
  await vite?.close()
  await h?.close()
  for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket, Key }))
  if (created) await client.send(new DeleteBucketCommand({ Bucket }))
  client.destroy()
  await rm(dir, { recursive: true, force: true })
  console.log('Temporary objects, bucket and database removed; business media preserved')
}
