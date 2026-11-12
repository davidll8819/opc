import test from 'node:test'
import assert from 'node:assert/strict'
import { modelErrorMessage, modelTransportError, modelRequestError } from '../apps/api/src/operations/model-errors.mjs'
import { responseError } from '../apps/api/src/slow-response.mjs'
import { recoveryState } from '../apps/api/src/task-recovery.mjs'
import { needsDesignImage } from '../apps/api/src/design-images.mjs'
test('upstream categories give actionable errors without leaking provider secrets', () => {
  for (const status of [400, 401, 402, 403, 404, 422, 429, 500]) {
    assert.doesNotMatch(modelErrorMessage(status, { error: { message: 'secret-key-123 private prompt' } }), /secret-key|private prompt/)
  }
  assert.match(modelErrorMessage(400,{error:{message:'Unsupported max_tokens'}}), /参数不兼容/)
  assert.match(modelErrorMessage(429), /限流/)
  assert.match(modelErrorMessage(403), /权限/)
})

test('parameter rejections remain non-retryable and retain only allowlisted diagnostics', () => {
  const records = []
  const app = { log: { warn: data => records.push(data), error: data => records.push(data) } }
  for (const status of [400, 422]) {
    const error = modelRequestError(status, { error: { param: 'temperature', message: 'Invalid temperature: secret-key-123 private prompt' } })
    const response = responseError(error, { id: 'fixture-request' }, app)
    assert.equal(response.status, status)
    assert.match(response.data.error, /temperature/)
    assert.deepEqual(error.modelDiagnostic, { upstreamStatus: status, category: 'invalid_parameters', parameter: 'temperature' })
  }
  for (const param of ['secret-key-123', 'messages.secret-key-123', { password: 'secret-key-123' }]) {
    const error = modelRequestError(422, { error: { param, message: 'private prompt' } })
    assert.equal(error.modelDiagnostic.parameter, 'unknown')
    responseError(error, { id: 'fixture-request' }, app)
    assert.doesNotMatch(JSON.stringify(error), /secret-key|private prompt|password/)
  }
  assert.doesNotMatch(JSON.stringify(records), /secret-key|private prompt|password/)
  assert.equal(modelRequestError(500).statusCode, 502)
  assert.equal(modelRequestError(429).statusCode, 429)
  assert.match(modelRequestError(400, { error: { message: 'Invalid thinking block signature: secret' } }).message, /历史思考内容/)
  assert.match(modelRequestError(400, { error: { message: 'prompt is too long' } }).message, /上下文超出/)
  assert.equal(modelRequestError(422, null).statusCode, 422)
})
test('recovery blocks external jobs and dependencies and treats unknown/media outcomes honestly', () => {
  const task = { id:'a', engine:'department-v1', dept:'new-agent-7', status:'blocked', title:'海报图片' }
  assert.equal(recoveryState({tasks:[task]},task).needsConfirmation,true)
  assert.equal(recoveryState({tasks:[task]},{...task,runtimeTaskId:'external'}).available,false)
  assert.equal(recoveryState({tasks:[task]},{...task,dependsOn:['missing']}).dependenciesReady,false)
  assert.equal(needsDesignImage({...task,title:'五秒视频创意与分镜设计',request:'交付界面视觉素材、Logo和提示词'}),false)
  assert.equal(needsDesignImage({...task,title:'绘制分镜海报'}),true)
})

test('transport classification explains nested causes without exposing request data', () => {
  for (const [code, expected] of [['UND_ERR_CONNECT_TIMEOUT', /连接尚未建立/], ['ENOTFOUND', /域名解析/], ['UND_ERR_HEADERS_TIMEOUT', /等待模型回复/], ['ECONNRESET', /连接中断/], ['CERT_HAS_EXPIRED', /证书/], ['arbitrary-secret-value', /网络请求失败/]]) {
    const error = Object.assign(new Error('synthetic-key private prompt'), { cause: { code, message: 'Bearer synthetic-sensitive-token' } })
    const text = modelTransportError(error)
    assert.match(text, expected); assert.match(text, /结果未知/)
    assert.doesNotMatch(text, /synthetic|Bearer|private|arbitrary/)
  }
  const cycle = {}; cycle.cause = cycle
  assert.match(modelTransportError(cycle), /网络请求失败/)
  assert.match(modelTransportError(new AggregateError([{ code: 'ENOTFOUND' }])), /域名解析/)
})
