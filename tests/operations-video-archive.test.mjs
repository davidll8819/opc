import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { setup } from './helpers/archive-api-fixture.mjs'
import { transaction } from '../apps/api/src/db.mjs'
import { archiveBytes, archiveVideoEdit } from '../apps/api/src/operations/video-edit-archive.mjs'
import {
  linkWorkbenchTask,
  runtimeCompletionWarning,
  applyRuntimeStatus,
} from '../apps/api/src/operations/task-tracking.mjs'

const bytes = Buffer.from('synthetic MP4 bytes, private fixture')
test('video archives above 6 MiB remain downloadable while ordinary files keep their limit', async () => {
  const h = await setup()
  const ctx = { tenantId: h.tenant, userId: h.alice }
  const id = randomUUID()
  const largeVideo = Buffer.alloc(7 * 1024 * 1024, 42)
  try {
    await h.query(
      `INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,phase,result)
       VALUES($1,$2,$3,$4,'large-archive',$5,'completed','导出完成',$6)`,
      [
        id,
        h.tenant,
        h.alice,
        'c'.repeat(24),
        JSON.stringify({ title: '大成片回归测试', segments: [], subtitles: [] }),
        JSON.stringify({ bytes: largeVideo.length, duration: 20, width: 1920, height: 1080 }),
      ],
    )
    const archive = await transaction(
      h.pool,
      (db) => archiveVideoEdit(db, ctx, id, largeVideo),
      ctx,
    )
    const download = await h.request('GET', `/files/${archive.fileId}/download`)
    assert.equal(download.statusCode, 200)
    assert.deepEqual(download.rawPayload, largeVideo)
    assert.equal(archive.sha256, createHash('sha256').update(largeVideo).digest('hex'))
    await assert.rejects(
      h.query(
        'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), h.tenant, h.alice, 'large.txt', 'text/plain', largeVideo],
      ),
      (error) => error.code === '23514' && error.constraint === 'workspace_files_data_check',
    )
  } finally {
    await h.close()
  }
})

test('archive verifies bounded complete media before saving', async () => {
  const row = { state: 'completed', result: { bytes: bytes.length } }
  assert.deepEqual(
    await archiveBytes({}, row, async () => ({ Body: Readable.from([bytes]) })),
    bytes,
  )
  await assert.rejects(archiveBytes({}, { ...row, state: 'running' }), /尚未完成/)
  await assert.rejects(archiveBytes({}, { ...row, result: { bytes: 101 * 1024 * 1024 } }), /超过/)
  await assert.rejects(
    archiveBytes({}, row, async () => ({ Body: Readable.from([Buffer.from('short')]) })),
    /不完整/,
  )
})

test('video workflow links demand, archives exactly once, previews privately and preserves old tasks', async () => {
  const h = await setup(),
    ctx = { tenantId: h.tenant, userId: h.alice },
    id = randomUUID(),
    runtimeId = 'b'.repeat(24)
  const run = (fn) => transaction(h.pool, fn, ctx)
  try {
    const input = { requestId: randomUUID(), prompt: '制作一段5秒蓝色小球视频，不对外发布' }
    await run((db) => linkWorkbenchTask(db, ctx, input, runtimeId))
    await run((db) => linkWorkbenchTask(db, ctx, input, runtimeId))
    const before = (
      await h.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        h.tenant,
        h.alice,
      ])
    ).rows[0].board
    assert.equal(before.tasks.length, 1)
    assert.equal(before.tasks[0].request, input.prompt)
    const spec = {
      title: '验收成片',
      segments: [{ url: 'https://example.test/a.mp4', start: 0, end: 4 }],
      subtitles: [],
    }
    await h.query(
      `INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,phase,result) VALUES($1,$2,$3,$4,'test',$5,'completed','导出完成',$6)`,
      [
        id,
        h.tenant,
        h.alice,
        runtimeId,
        JSON.stringify(spec),
        JSON.stringify({ bytes: bytes.length, width: 1280, height: 720, duration: 4 }),
      ],
    )
    await assert.rejects(
      transaction(h.pool, (db) => archiveVideoEdit(db, { ...ctx, userId: h.bob }, id, bytes), {
        ...ctx,
        userId: h.bob,
      }),
      /不存在/,
    )
    await assert.rejects(
      run((db) => archiveVideoEdit(db, ctx, id, Buffer.from('short'))),
      /不完整/,
    )
    const a = await run((db) => archiveVideoEdit(db, ctx, id, bytes))
    assert.deepEqual(await run((db) => archiveVideoEdit(db, ctx, id, bytes)), a)
    const after = (
      await h.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        h.tenant,
        h.alice,
      ])
    ).rows[0].board
    assert.deepEqual(after.tasks[0], before.tasks[0])
    assert.equal(after.tasks.length, 2)
    assert.equal(after.tasks[1].videoEditId, id)
    assert.equal(after.tasks[1].publishRequired, false)
    const files = (
      await h.query('SELECT * FROM workspace_files WHERE tenant_id=$1 AND user_id=$2', [
        h.tenant,
        h.alice,
      ])
    ).rows
    assert.equal(files.length, 2)
    assert.deepEqual(Buffer.from(files.find((f) => f.id === a.fileId).data), bytes)
    assert.match(
      Buffer.from(files.find((f) => f.id === a.manifestId).data).toString(),
      new RegExp(input.prompt),
    )
    assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'))
    const url = `${h.base}/files/${a.fileId}/video`
    const headers = { cookie: `office_session=${h.alice}` }
    // Use the fixture helper's real auth cookie format.
    const good = await h.request('GET', `/files/${a.fileId}/video`)
    assert.equal(good.statusCode, 200)
    assert.deepEqual(good.rawPayload, bytes)
    assert.equal(
      (await h.request('GET', `/files/${a.fileId}/video`, undefined, h.bob)).statusCode,
      404,
    )
    assert.equal((await h.app.inject({ url })).statusCode, 401)
    const repeat = await h.request('POST', `/operations/video-edits/${id}/archive`, {})
    assert.equal(repeat.statusCode, 200)
    assert.equal(repeat.json().archive.fileId, a.fileId)
    assert.equal((await h.request('GET', `/files/${a.fileId}/download`)).statusCode, 200)
    const range = await h.app.inject({ url, headers: { ...headers, range: 'bytes=0-7' } })
    assert.equal(range.statusCode, 206)
    assert.deepEqual(range.rawPayload, bytes.subarray(0, 8))
    assert.equal(
      (await h.app.inject({ url, headers: { ...headers, range: 'bytes=9999-' } })).statusCode,
      416,
    )
    assert.equal(
      (await h.app.inject({ url, headers: { ...headers, range: 'bytes=-0' } })).statusCode,
      416,
    )
    assert.equal(
      (await h.request('POST', `/operations/video-edits/${id}/archive`, {}, h.bob)).statusCode,
      403,
    )
    // A full archive must roll back both files and the result task, leaving retry possible.
    const fullId = randomUUID()
    await h.query(
      `INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,phase,result)
      SELECT $1,tenant_id,user_id,task_id,fingerprint,spec,state,phase,result - 'archive' FROM operations_video_edits WHERE id=$2`,
      [fullId, id],
    )
    await assert.rejects(
      run((db) =>
        archiveVideoEdit(
          {
            query: (sql, args) =>
              sql.includes('coalesce(sum')
                ? Promise.resolve({ rows: [{ total: 100 * 1024 * 1024 }] })
                : db.query(sql, args),
          },
          ctx,
          fullId,
          bytes,
        ),
      ),
      /资料空间已满/,
    )
    assert.equal((await h.query('SELECT count(*)::int n FROM workspace_files')).rows[0].n, 2)
    assert.equal(
      (await h.request('GET', `/operations/video-edits/${fullId}`)).json().edit.result.archive,
      undefined,
    )
    const recovered = await run((db) => archiveVideoEdit(db, ctx, fullId, bytes))
    assert.notEqual(recovered.fileId, a.fileId)
  } finally {
    await h.close()
  }
})

test('historical wrapped parameter errors explain blocked tasks without exposing raw provider content', () => {
  const result = {
    status: 'completed', savedVideos: [],
    messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: 502 模型服务拒绝请求参数 private-prompt secret-key' }] } }],
  }
  const task = {}
  applyRuntimeStatus(task, result)
  assert.equal(task.status, 'blocked')
  assert.match(task.executionNote, /拒绝请求参数/)
  assert.doesNotMatch(task.executionNote, /private-prompt|secret-key/)
  assert.match(runtimeCompletionWarning({ ...result, savedVideos: [{ status: 'SUCCESS', videoUrl: 'https://media.test/video.mp4' }] }), /已保存的视频仍可使用/)
  const laterSuccess = { type: 'assistant', message: { content: [{ type: 'text', text: 'Completed successfully' }] } }
  assert.equal(runtimeCompletionWarning({ ...result, messages: [...result.messages, laterSuccess] }), '')
})

test('SDK structured failures cannot mark a video task successful without a video', () => {
  for (const messages of [
    [{type:'assistant',error:'invalid_request',message:{content:[{type:'text',text:"There's an issue with the selected model (office-content-ops)."}]}},{type:'result',subtype:'success',is_error:true}],
    [{type:'result',subtype:'success',is_error:true}],
    [{type:'error',message:'private transport details'}],
  ]) {
    const result={status:'completed',savedVideos:[],messages},task={}
    applyRuntimeStatus(task,result)
    assert.equal(task.status,'blocked')
    assert.doesNotMatch(task.executionNote,/private transport|office-content-ops/)
    assert.equal(runtimeCompletionWarning({...result,messages:[...messages,{type:'assistant',message:{content:[{type:'text',text:'Finished'}]}}]}),'')
  }
})

test('successful media does not conceal a final model quota error', () => {
  const result = {
    status: 'completed',
    savedVideos: [{ status: 'SUCCESS', videoUrl: 'https://media.test/video.mp4' }],
    messages: [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'API Error: 429 今日模型额度不足' }] },
      },
    ],
  }
  assert.match(runtimeCompletionWarning(result), /额度不足/)
  const task = {}
  applyRuntimeStatus(task, result)
  assert.match(task.executionNote, /已保存的视频/)
  assert.equal(
    runtimeCompletionWarning({
      messages: [
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'API Error: 429 今日模型额度不足' }] },
        },
      ],
    }),
    '',
  )
  assert.equal(
    runtimeCompletionWarning({
      messages: [
        ...result.messages,
        { type: 'assistant', message: { content: [{ type: 'text', text: '已完成' }] } },
      ],
    }),
    '',
  )
})

test('quota failure before video generation is blocked and never claims saved media', () => {
  const result = {
    status: 'completed',
    savedVideos: [],
    messages: [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'API Error: 429 今日模型额度不足' }] },
      },
    ],
  }
  for (const videos of [
    [],
    [{ status: 'FAILURE' }],
    [{ status: 'SUCCESS' }],
    [{ status: 'InProgress' }],
  ]) {
    const task = {}
    applyRuntimeStatus(task, { ...result, savedVideos: videos })
    assert.equal(task.status, 'blocked')
    assert.match(task.executionNote, /本次制作未完成/)
    assert.doesNotMatch(task.executionNote, /已保存的视频|后续文字整理/)
    assert.equal(task.summary, task.executionNote)
    assert.doesNotMatch(task.summary, /API Error/)
  }
  const task = {}
  applyRuntimeStatus(task, {
    ...result,
    savedVideos: [{ status: 'SUCCESS', videoUrl: 'https://media.test/video.mp4' }],
  })
  assert.equal(task.status, 'completed')
  assert.match(task.executionNote, /已保存的视频/)
})

test('completed task summary keeps authored replies and media, excluding internal prompts and tool records', () => {
  const task = {}
  applyRuntimeStatus(task, {
    status: 'completed',
    messages: [
      { type: 'user', content: [{ type: 'text', text: 'INTERNAL_SKILL_INSTRUCTIONS' }] },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '方案已准备' },
            { type: 'tool_use', name: 'generateVideo', input: { prompt: 'TOOL_INPUT' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              content: JSON.stringify({
                status: 'SUCCESS',
                videoUrl: 'https://media.test/final.mp4',
                text: 'TOOL_INTERNAL_RECORD',
              }),
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'API Error: obsolete stack' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: '四段全部完成，请验收。' }] },
      },
    ],
  })
  assert.equal(task.summary, '方案已准备\n\n四段全部完成，请验收。')
  assert.deepEqual(task.media, [{ type: 'VIDEO', url: 'https://media.test/final.mp4' }])
  assert.equal(task.status, 'completed')
})
