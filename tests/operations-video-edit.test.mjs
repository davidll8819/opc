import { checkVideoEdit } from '../apps/api/src/operations/video-edit-check.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseVideoEdit, editDimensions } from '../apps/api/src/operations/video-edit-schema.mjs'
import { saveEdit, readEdit, editPublic } from '../apps/api/src/operations/video-edit-service.mjs'
import {
  renderVideoEdit,
  probeMedia,
  mediaCommand,
} from '../apps/api/src/operations/video-edit-render.mjs'
import { transaction } from '../apps/api/src/db.mjs'
import { setup } from './helpers/archive-api-fixture.mjs'

const url = 'http://127.0.0.1:19000/bucket/owner/test.mp4'
const input = () => ({
  requestId: randomUUID(),
  title: '剪辑验收',
  segments: [{ url, start: 0, end: 2 }],
  ratio: '9:16',
  resolution: '720p',
  fit: 'contain',
  originalVolume: 1,
  musicVolume: 0.2,
  subtitles: [{ start: 0, end: 1, text: '测试字幕：100% {text} \\ 特殊字符' }],
})

test('edit recipe validates duration, subtitle timing, music size and output dimensions', () => {
  const { spec } = parseVideoEdit(input())
  assert.deepEqual(editDimensions(spec), [720, 1280])
  assert.equal(spec.duration, 2)
  assert.deepEqual(editDimensions({ ratio: '16:9', resolution: '1080p' }), [1920, 1080])
  for (const patch of [
    { segments: [{ url, start: 1, end: 0 }] },
    {
      segments: [
        { url, start: 0, end: 100 },
        { url, start: 0, end: 100 },
      ],
    },
    { subtitles: [{ start: 0, end: 3, text: '超时' }] },
    {
      subtitles: [
        { start: 0, end: 1, text: '第一条' },
        { start: 0.5, end: 2, text: '重叠' },
      ],
    },
    { music: { name: 'a', base64: 'not base64' } },
    { ratio: 'arbitrary filter' },
  ])
    assert.throws(() => parseVideoEdit({ ...input(), ...patch }))
})

test('saved edits are private and idempotent; changed content cannot reuse a submission ID', async () => {
  const h = await setup(),
    taskId = 'a'.repeat(24)
  const ctx = { tenantId: h.tenant, userId: h.alice }
  const run = (fn) => transaction(h.pool, fn, ctx)
  try {
    await h.query(
      "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'test','submitted',$4)",
      [randomUUID(), h.tenant, h.alice, taskId],
    )
    const body = {
      ...input(),
      music: { name: 'saved.wav', base64: Buffer.from('synthetic-audio').toString('base64') },
    }
    const first = await run((db) => saveEdit(db, ctx, taskId, body))
    const second = await run((db) => saveEdit(db, ctx, taskId, body))
    assert.equal(first.id, second.id)
    assert.equal(
      (await h.query('SELECT count(*)::int AS n FROM operations_video_edits')).rows[0].n,
      1,
    )
    await assert.rejects(
      run((db) => saveEdit(db, ctx, taskId, { ...body, title: '不同内容' })),
      /不同/,
    )
    for (const other of [
      { ...ctx, userId: h.bob },
      { ...ctx, tenantId: h.other },
    ]) {
      await assert.rejects(
        transaction(h.pool, (db) => readEdit(db, other, first.id), other),
        /不存在/,
      )
      await assert.rejects(
        transaction(h.pool, (db) => saveEdit(db, other, taskId, input()), other),
        /不存在/,
      )
    }
    assert.equal(editPublic(first).music, undefined)
    assert.equal(editPublic(first).fingerprint, undefined)
    const musicPath = `/operations/video-edits/${first.id}/music`
    const musicResponse = await h.request('GET', musicPath)
    assert.equal(musicResponse.statusCode, 200)
    assert.deepEqual(musicResponse.rawPayload, Buffer.from(first.music))
    assert.equal(musicResponse.headers['cache-control'], 'private, no-store')
    assert.equal((await h.request('GET', musicPath, undefined, h.bob)).statusCode, 404)
    assert.equal((await h.app.inject({ url: h.base + musicPath })).statusCode, 401)
    const partial = await h.app.inject({
      url: h.base + musicPath,
      headers: { cookie: `office_session=${h.alice}`, range: 'bytes=1-4' },
    })
    assert.equal(partial.statusCode, 206)
    assert.deepEqual(partial.rawPayload, Buffer.from(first.music).subarray(1, 5))
    assert.equal(
      (
        await h.app.inject({
          url: h.base + musicPath,
          headers: { cookie: `office_session=${h.alice}`, range: 'bytes=999999-' },
        })
      ).statusCode,
      416,
    )
    const reused = await run((db) =>
      saveEdit(db, ctx, taskId, { ...input(), musicFromEditId: first.id }),
    )
    assert.deepEqual(Buffer.from(reused.music), Buffer.from(first.music))
    assert.equal(reused.spec.musicName, 'saved.wav')
    const restarted = await run((db) => readEdit(db, ctx, first.id))
    assert.deepEqual(restarted.spec, first.spec)
    const path = `/operations/video-edits/${first.id}`
    await h.query("UPDATE operations_video_edits SET state='failed',error='测试失败' WHERE id=$1", [
      first.id,
    ])
    assert.equal((await h.request('GET', path)).statusCode, 200)
    assert.equal((await h.request('GET', path, undefined, h.bob)).statusCode, 404)
    assert.equal((await h.request('POST', path + '/retry', {}, h.bob)).statusCode, 403)
    assert.equal((await h.app.inject({ url: `${h.base}${path}` })).statusCode, 401)
  } finally {
    await h.close()
  }
})

const bin = process.env.VIDEO_EDIT_TEST_BIN || resolve('.local/media-tools/bin')
const available = await access(join(bin, 'ffmpeg')).then(
  () => true,
  () => false,
)
test(
  'real FFmpeg trims and joins silent/audio clips, burns Chinese text, mixes music and verifies output',
  { skip: !available },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'video-edit-test-'))
    const entry = {
      ffmpegBin: bin,
      userId: 'owner',
      infrastructure: { assets: { cdnEndpoint: 'http://127.0.0.1:19000/bucket' } },
    }
    const originalFetch = globalThis.fetch
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
    try {
      await mediaCommand(join(bin, 'ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:r=30:d=3',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        join(dir, 'silent.mp4'),
      ])
      await mediaCommand(join(bin, 'ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=320x180:r=30:d=3',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-c:a',
        'aac',
        '-shortest',
        join(dir, 'sound.mp4'),
      ])
      await mediaCommand(join(bin, 'ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:duration=1',
        join(dir, 'music.wav'),
      ])
      const silent = await readFile(join(dir, 'silent.mp4')),
        sound = await readFile(join(dir, 'sound.mp4'))
      const before = [hash(silent), hash(sound)]
      const url2 = url.replace('test', 'sound')
      globalThis.fetch = async (target) =>
        new Response(String(target) === url ? silent : sound, {
          headers: { 'content-type': 'video/mp4' },
        })
      const task = { savedVideos: [url, url2].map((videoUrl) => ({ videoUrl, status: 'SUCCESS' })) }
      const { spec } = parseVideoEdit({
        ...input(),
        segments: [
          { url, start: 0.5, end: 1.5 },
          { url: url2, start: 1, end: 2 },
        ],
      })
      const h = await setup(undefined, { operationsDriver: {
        binding: async () => entry,
        request: async (_entry, service, path) => {
          assert.equal(service, 'ai')
          assert.equal(path, '/agent/tasks/' + 'a'.repeat(24))
          return task
        },
      } })
      try {
        await h.query("INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'test','submitted',$4)", [randomUUID(),h.tenant,h.alice,'a'.repeat(24)])
        const path = '/operations/tasks/' + 'a'.repeat(24) + '/edits/check'
        const valid = await h.request('POST', path, input())
        assert.equal(valid.statusCode, 200, valid.body)
        assert.equal(valid.json().ok, true)
        assert.equal((await h.request('POST', path, input(), h.bob)).statusCode, 403)
        assert.equal((await h.request('POST', path.replace('a'.repeat(24), 'b'.repeat(24)), input())).statusCode, 404)
        const bad = await h.request('POST', path, {...input(), segments:[{url,start:0,end:4}]})
        assert.equal(bad.statusCode,422)
        assert.match(bad.json().error,/超出原视频时长/)
        assert.equal((await h.query('SELECT count(*)::int AS n FROM operations_video_edits')).rows[0].n,0)
      } finally { await h.close() }
      const checked = await checkVideoEdit({ entry, task, spec, music: await readFile(join(dir, 'music.wav')) })
      assert.equal(checked.width, 720)
      assert.ok(checked.warnings.some(w => w.includes('黑边')))
      assert.ok(checked.warnings.some(w => w.includes('放大')))
      assert.ok(checked.warnings.some(w => w.includes('循环')))
      await assert.rejects(checkVideoEdit({ entry, task, spec, music: Buffer.from('broken audio') }), /配乐无法读取/)
      await assert.rejects(checkVideoEdit({ entry, task, spec: { ...spec, segments: [{url, start: 0, end: 4}] } }), /片段1超出原视频时长/)
      await assert.rejects(checkVideoEdit({ entry, task, spec: { ...spec, segments: [{url: 'https://example.com/foreign.mp4', start: 0, end: 1}] } }), /本任务|视频/)
      const silentCheck = await checkVideoEdit({ entry, task, spec: { ...spec, segments: [{url, start: 0, end: 1}], fit: 'cover' } })
      assert.ok(silentCheck.warnings.some(w => w.includes('无声')))
      assert.ok(silentCheck.warnings.some(w => w.includes('裁掉')))
      const result = await renderVideoEdit({
        entry,
        task,
        spec,
        music: await readFile(join(dir, 'music.wav')),
        dir,
      })
      assert.equal(result.width, 720)
      assert.equal(result.height, 1280)
      assert.ok(Math.abs(result.duration - 2) < 0.1)
      assert.equal(result.audio, true)
      assert.deepEqual(before, [
        hash(await readFile(join(dir, 'silent.mp4'))),
        hash(await readFile(join(dir, 'sound.mp4'))),
      ])
      const probe = await probeMedia(result.file, entry)
      assert.equal(probe.codec, 'h264')
      // Decode all frames and samples, so a metadata-only success cannot hide corruption.
      await mediaCommand(join(bin, 'ffmpeg'), ['-v', 'error', '-i', result.file, '-f', 'null', '-'])
      const again = await mkdtemp(join(tmpdir(), 'video-edit-invalid-'))
      try {
        await assert.rejects(
          renderVideoEdit({
            entry,
            task,
            spec: { ...spec, segments: [{ url, start: 0, end: 10 }] },
            dir: again,
          }),
          /超出/,
        )
      } finally {
        await rm(again, { recursive: true, force: true })
      }
    } finally {
      globalThis.fetch = originalFetch
      await rm(dir, { recursive: true, force: true })
    }
  },
)

test('20-second four-source film renders, archives and downloads with identical bytes in an isolated workspace', {skip: !available}, async () => {
  const {archiveVideoEdit} = await import('../apps/api/src/operations/video-edit-archive.mjs')
  const {linkWorkbenchTask} = await import('../apps/api/src/operations/task-tracking.mjs')
  const dir = await mkdtemp(join(tmpdir(),'video-four-shot-'))
  const oldFetch = globalThis.fetch
  let h
  try {
    const files = new Map()
    for (const [i,color] of ['red','green','blue','yellow'].entries()) {
      const file=join(dir,`source-${i}.mp4`)
      await mediaCommand(join(bin,'ffmpeg'), ['-v','error','-f','lavfi','-i',`color=c=${color}:s=320x180:r=30:d=5`,'-c:v','libx264','-threads','2',file])
      files.set(url.replace('test',`shot-${i}`),await readFile(file))
    }
    await mediaCommand(join(bin,'ffmpeg'),['-v','error','-f','lavfi','-i','sine=frequency=330:duration=20',join(dir,'music.wav')])
    globalThis.fetch=async target=>new Response(files.get(String(target)),{headers:{'content-type':'video/mp4'}})
    const task={savedVideos:[...files.keys()].map(videoUrl=>({videoUrl,status:'SUCCESS'}))}
    const entry={ffmpegBin:bin,userId:'owner',infrastructure:{assets:{cdnEndpoint:'http://127.0.0.1:19000/bucket'}}}
    const body={...input(),title:'20秒四镜头技术验收',ratio:'16:9',segments:[...files.keys()].map(url=>({url,start:0,end:5})),subtitles:[0,1,2,3].map(i=>({start:i*5,end:(i+1)*5,text:`第${i+1}段：多镜头验收`})),originalVolume:0,musicVolume:0.35}
    const {spec}=parseVideoEdit(body)
    const music=await readFile(join(dir,'music.wav'))
    const result=await renderVideoEdit({entry,task,spec,music,dir})
    assert.equal(result.width,1280);assert.equal(result.height,720)
    assert.ok(Math.abs(result.duration-20)<0.1)
    assert.equal(result.audio,true)
    // Sample the center of each shot. This checks order/content, not just file metadata.
    for (const [i,expected] of [[240,0,0],[0,110,0],[0,0,240],[240,240,0]].entries()) {
      const pixel=join(dir,`pixel-${i}.rgb`)
      await mediaCommand(join(bin,'ffmpeg'),['-v','error','-ss',String(i*5+2),'-i',result.file,'-vf','crop=2:2:640:360,scale=1:1','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',pixel])
      const rgb=await readFile(pixel)
      expected.forEach((v,c)=>assert.ok(Math.abs(rgb[c]-v)<30,`shot ${i+1} color mismatch`))
    }
    h=await setup()
    const ctx={tenantId:h.tenant,userId:h.alice},runtimeId='c'.repeat(24),id=randomUUID()
    const run=fn=>transaction(h.pool,fn,ctx)
    await run(db=>linkWorkbenchTask(db,ctx,{requestId:randomUUID(),prompt:'隔离技术验收：四段各5秒，不发布'},runtimeId))
    const bytes=await readFile(result.file)
    const {file,...metadata}=result
    await h.query("INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,phase,result) VALUES($1,$2,$3,$4,'test',$5,'completed','导出完成',$6)",[id,h.tenant,h.alice,runtimeId,spec,metadata])
    const archive=await run(db=>archiveVideoEdit(db,ctx,id,bytes))
    const download=await h.request('GET',`/files/${archive.fileId}/download`)
    assert.equal(download.statusCode,200)
    assert.deepEqual(download.rawPayload,bytes)
    const preview=await h.request('GET',`/files/${archive.fileId}/video`)
    assert.equal(preview.statusCode,200)
    assert.deepEqual(preview.rawPayload,bytes)
    assert.deepEqual(await run(db=>archiveVideoEdit(db,ctx,id,bytes)),archive)
  } finally {globalThis.fetch=oldFetch;await h?.close();await rm(dir,{recursive:true,force:true})}
})
