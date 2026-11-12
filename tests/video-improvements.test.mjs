import { checkedShotResult } from '../apps/api/src/operations/video-shots.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
import { musicGain, musicFilter } from '../packages/video-edit/audio.mjs'
import { recoveryDecision } from '../scripts/service-watchdog.mjs'
import { generateNarration } from '../apps/api/src/operations/video-narration.mjs'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mediaCommand } from '../apps/api/src/operations/video-edit-render.mjs'

test('single shot submits once, retains original task identity and configured model, isolates owners', async () => {
  const calls = [], task = 'e'.repeat(24)
  const driver = { ready: async () => ({}), binding: async () => ({}), request: async (...args) => {
    calls.push(args)
    if (args[3]?.method === 'POST') return { id: 'a'.repeat(24) }
    return { status: 'SUCCESS', videoUrl: 'https://example.test/new.mp4' }
  } }
  const h = await setup(undefined, { operationsDriver: driver })
  try {
    const policy = defaultPolicy(); policy.tiers.video = 'synthetic-video-model'; policy.departments.content_ops.enabled = true
    await h.query('UPDATE operations_settings SET encrypted_config=$2 WHERE tenant_id=$1', [h.tenant, encryptConfig({...policy,credentials:{ai:'synthetic-key'}}, Buffer.alloc(32,9), h.tenant)])
    await h.query("INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'shot-test','submitted',$4)", [randomUUID(),h.tenant,h.alice,task])
    const body = { requestId: randomUUID(), prompt: '一个新的固定镜头', duration: 5, ratio: '9:16', resolution: '720p', costAcknowledged: true }
    const path = `/operations/tasks/${task}/shots`
    assert.equal((await h.request('POST', path, { ...body,costAcknowledged:false })).statusCode,400)
    assert.equal((await h.request('POST', path, body,h.bob)).statusCode,403)
    const first = await h.request('POST',path,body)
    assert.equal(first.statusCode,200,first.body); assert.equal(first.json().shot.state,'submitted')
    assert.equal((await h.request('POST',path,body)).statusCode,200)
    assert.equal(calls.length,1)
    assert.equal(calls[0][3].body.model,'synthetic-video-model')
    assert.equal(calls[0][3].body.metadata.officeTaskId,task)
    assert.equal((await h.request('POST',path,{...body,requestId:randomUUID()})).statusCode,409)
    assert.equal((await h.request('GET',path)).json().items[0].state,'completed')
    assert.equal((await h.request('GET',path,undefined,h.bob)).statusCode,404)
  } finally { await h.close() }
})

test('final version is unique, private and never rewrites original media or recipes', async () => {
  const h = await setup(), task = 'f'.repeat(24), ids = [randomUUID(),randomUUID()]
  try {
    await h.query("INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'version-test','submitted',$4)", [randomUUID(),h.tenant,h.alice,task])
    for (const id of ids) await h.query("INSERT INTO operations_video_edits(id,tenant_id,user_id,task_id,fingerprint,spec,state,result) VALUES($1,$2,$3,$4,'fixture','{}','completed',$5)",[id,h.tenant,h.alice,task,{key:'original-'+id}])
    for (const id of ids) assert.equal((await h.request('POST',`/operations/video-edits/${id}/final`,{})).statusCode,200)
    const rows=(await h.query('SELECT id,is_final,result FROM operations_video_edits ORDER BY id')).rows
    assert.equal(rows.filter(r=>r.is_final).length,1)
    assert.equal(rows.find(r=>r.is_final).id,ids[1])
    assert(rows.every(r=>r.result.key==='original-'+r.id))
    assert.equal((await h.request('POST',`/operations/video-edits/${ids[0]}/final`,{},h.bob)).statusCode,403)
  } finally { await h.close() }
})

test('audio envelope fades and ducks only during speech; recovery is bounded', () => {
  const base={duration:10,volume:0.8,fade:1,duck:true,cues:[{start:2,end:4}]}
  assert.equal(musicGain({...base,time:0}),0)
  assert.equal(musicGain({...base,time:0.5}),0.4)
  assert.equal(musicGain({...base,time:3}),0.2)
  assert.equal(musicGain({...base,time:5}),0.8)
  assert.equal(musicGain({...base,time:10}),0)
  assert.match(musicFilter({duration:10,musicFade:1,musicVolume:.8,duckMusic:true,narrationCues:base.cues}), /afade=t=out/)
  assert.equal(recoveryDecision({failures:1,lastAttempt:0,now:100000,attempts:[]}),false)
  assert.equal(recoveryDecision({failures:2,lastAttempt:0,now:100000,attempts:[]}),true)
  assert.equal(recoveryDecision({failures:2,lastAttempt:0,now:100000,attempts:[1,2,3,4,5]}),false)
})

const bin=resolve('.local/media-tools/bin')
const voiceReady=process.platform==='darwin' && await access(resolve(bin,'ffmpeg')).then(()=>true,()=>false)
test('real local Chinese narration produces timed captions and playable audio, rejects overflow', {skip:!voiceReady}, async()=>{
  const result=await generateNarration({text:'你好。开始工作。',duration:10,entry:{ffmpegBin:bin},signal:AbortSignal.timeout(45000)})
  assert(result.narration.base64.length>1000)
  assert.equal(result.subtitles.length,2)
  assert.equal(result.subtitles[0].end,result.subtitles[1].start)
  assert(result.duration>1 && result.duration<10)
  await assert.rejects(generateNarration({text:'这段文字不可能在一秒内读完。',duration:1,entry:{ffmpegBin:bin},signal:AbortSignal.timeout(30000)}),/超过/)
})

test('employee diagnostics persist only results, survive reload and flag changed configuration', async () => {
  const h = await setup()
  try {
    const response = await h.request('POST', '/employees/self-check', { department: 'archive' })
    assert.equal(response.statusCode, 200)
    const history = (await h.request('GET', '/employees/self-check/history')).json().items
    assert.equal(history.length, 1)
    assert.equal(history[0].checkedAt, response.json().checkedAt)
    assert.equal(history[0].stale, false)
    assert(!JSON.stringify(history).includes('synthetic-key'))
    await h.query('UPDATE operations_settings SET revision=revision+1 WHERE tenant_id=$1', [h.tenant])
    assert.equal((await h.request('GET', '/employees/self-check/history')).json().items[0].stale, true)
    assert.equal((await h.request('GET', '/employees/self-check/history', undefined, h.bob)).statusCode, 403)
  } finally { await h.close() }
})

test('portrait mismatch never becomes a completed shot or triggers a paid retry', () => {
  const result=checkedShotResult({status:'SUCCESS',videoUrl:'https://example.test/video.mp4',specification:{matches:false,requested:{ratio:'9:16',resolution:'1080p'},actual:{width:1920,height:1080}}})
  assert.equal(result.state,'failed');assert.match(result.result.error,/不一致/);assert.equal(result.result.videoUrl,'https://example.test/video.mp4')
})

test('real FFmpeg music fade and speech ducking match preview gain', { skip: !voiceReady }, async () => {
  const dir=await mkdtemp(join(tmpdir(),'office-audio-envelope-'))
  try {
    const spec={duration:10,musicVolume:0.8,musicFade:1,duckMusic:true,narrationCues:[{start:2,end:4}]}
    await mediaCommand(join(bin,'ffmpeg'),['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=10','-af',musicFilter(spec),'-f','f32le',join(dir,'audio.pcm')])
    const bytes=await readFile(join(dir,'audio.pcm'))
    const rms=time=>{let sum=0;const start=Math.round(time*48000);for(let i=start;i<start+4800;i++)sum+=bytes.readFloatLE(i*4)**2;return Math.sqrt(sum/4800)}
    const normal=rms(4.5)
    assert(Math.abs(rms(2.5)/normal-.25)<.02,'speech interval ducks to 25%')
    assert(Math.abs(rms(.45)/normal-.5)<.03,'fade in')
    assert(Math.abs(rms(9.45)/normal-.5)<.03,'fade out')
  } finally {await rm(dir,{recursive:true,force:true})}
})
