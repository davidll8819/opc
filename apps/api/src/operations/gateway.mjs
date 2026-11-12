import {employeeDirectory} from '../employee-directory.mjs'
import { runtimeUserContext } from './runtime-user-auth.mjs'
import { EMPLOYEE_BY_DEPARTMENT } from '../../../../packages/employees/registry.mjs'
import { readOrganization, organizationPolicy } from '../organization.mjs'
import { beginEmployeeWork, endEmployeeWork, readDuty, withEmployeeRole } from '../employee-duty.mjs'
import { beginBilling, finishBilling } from '../billing.mjs'
import { modelCatalog } from './model-catalog.mjs'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { transaction, fail } from '../db.mjs'
import { configKey, decryptConfig } from './security.mjs'
import { toPolicy, resolveDepartment, resolveCapability, validGatewayToken } from './policy.mjs'
import { reserveTokens, settleTokens } from './budget.mjs'
import { loadSecrets } from './credentials.mjs'
import { createOperationsDriver } from './driver.mjs'
import { modelRequestError, modelTransportError } from './model-errors.mjs'
export function runtimeModelCatalog(catalog,policy){
  const items=[{id:'office-content-ops',object:'model',owned_by:'Office',type:'chat'}]
  for(const kind of ['image','video']){
    let selection
    try{selection=resolveCapability(policy,'content_ops',kind)}catch(e){if(e.statusCode===409)continue;throw e}
    const model=catalog.find(m=>m.id===selection.model)
    if(model)items.push({...model,type:kind})
  }
  return items
}
export async function loadPolicy(db, tenantId, env) {
  const row = (await db.query('SELECT encrypted_config,revision FROM operations_settings WHERE tenant_id=$1',[tenantId])).rows[0]
  if (!row) throw fail(409,'请先保存企业模型配置')
  const base=toPolicy(decryptConfig(row.encrypted_config,await configKey(env),tenantId))
  return { policy: organizationPolicy(base,await readOrganization(db,tenantId),await readDuty(db,tenantId),await employeeDirectory(db,tenantId)), revision: row.revision }
}
export function readUsage(data, anthropic = false) {
  const u = data?.usage
  if (!u) return undefined
  const input = anthropic ? Number(u.input_tokens) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) : Number(u.prompt_tokens)
  const output = Number(anthropic ? u.output_tokens : u.completion_tokens)
  return Number.isSafeInteger(input) && Number.isSafeInteger(output) && input >= 0 && output >= 0 ? { input,output } : undefined
}
// Collect only usage metadata; never persist prompts, tool arguments, or model response text.
export function streamUsage(anthropic) {
  let pending = '', usage, complete = false, invalid = false
  return {
    feed(text) {
      pending = (pending + text).replaceAll('\r\n','\n')
      if (pending.length > 4 * 1024 * 1024) { invalid = true; pending = ''; return }
      let pos
      while ((pos = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0,pos); pending = pending.slice(pos+2)
        const payload = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
        if (payload === '[DONE]') { complete = true; continue }
        try {
          const data = JSON.parse(payload)
          if (data.error || data.type === 'error') invalid = true
          if (!anthropic && data.usage) usage = readUsage(data)
          if (anthropic && data.type === 'message_start') usage = readUsage(data.message,true)
          if (anthropic && data.type === 'message_delta' && usage && Number.isSafeInteger(data.usage?.output_tokens)) usage.output = data.usage.output_tokens
          if (data.type === 'message_stop') complete = true
        } catch { /* Keep forwarding protocol comments and unknown event types. */ }
      }
    }, result() { return complete && !invalid ? usage : undefined },
  }
}
export function toolCompatibleRequest(body) {
  if (body.model === 'gpt-6.1-sol' && body.reasoning_effort === undefined)
    body = { ...body, reasoning_effort: 'low' }
  // GPT text models use the completion budget parameter, including fallback calls.
  // Copy rather than mutate: a later fallback may use a different protocol.
  if (/^gpt-(?:5|6)(?:[.-]|$)/.test(body.model) && body.max_tokens !== undefined) {
    body = { ...body, max_completion_tokens: body.max_completion_tokens ?? body.max_tokens }
    delete body.max_tokens
  }
  // This relay's Chat Completions route explicitly rejects these function tools
  // with its default reasoning mode. Apply per request, without mutating fallback input.
  return body.model === 'gpt-5.6-luna' && body.tools?.some(tool => tool.type === 'function')
    ? { ...body, reasoning_effort: 'none' }
    : body
}
export function toolModelSelection(selection, policy, body) {
  if (selection.model !== 'gpt-6.1-sol' || !body?.tools?.some(tool => tool.type === 'function')) return selection
  // This relay rejects GPT 6.1 tools both with default reasoning and with none.
  // Use a configured text fallback; keep ordinary chat and stored choices intact.
  const model = [selection.fallback, policy.tiers?.cheap].find(id => id && id !== selection.model)
  if (!model) throw fail(409, '当前模型通道不支持员工工具，请配置兼容工具调用的备用文字模型')
  return { ...selection, model, fallback: '' }
}
export function protocolModelSelection(selection, policy, path) {
  if (path !== '/api/anthropic/v1/messages') return selection
  if (/^claude-/i.test(selection.model)) return { ...selection, fallback: /^claude-/i.test(selection.fallback || '') ? selection.fallback : '' }
  const model = [selection.fallback, policy.tiers?.strong, policy.tiers?.fast, policy.tiers?.cheap].find(id => /^claude-/i.test(id || ''))
  if (!model) throw fail(409, '制作代理使用 Anthropic 协议，请先配置兼容的 Claude 文字模型')
  return { ...selection, model, fallback: /^claude-/i.test(selection.fallback || '') && selection.fallback !== model ? selection.fallback : '' }
}
export function createModelGateway({ pool, env, fetcher = fetch }) {
  return async function guardedCall(request) {
    const lease = await beginEmployeeWork(pool, request.ctx, request.department)
    try {
      const employeeId=EMPLOYEE_BY_DEPARTMENT[request.department]?.id || request.department
      const profile=request.policy.employeeProfiles?.[employeeId] || await transaction(pool,async db=>(await readDuty(db,request.ctx.tenantId)).find(e=>e.employeeId===employeeId),request.ctx)
      return await call({...request,body:withEmployeeRole(request.body,request.path,profile)})
    } finally { await endEmployeeWork(pool, request.ctx, lease) }
  }
  async function call({ ctx, policy, department, path, body, reply, allowFallback = true, capability = 'text' }) {
    const credential = await transaction(pool,db => loadSecrets(db,env,ctx.tenantId,ctx.userId),ctx)
    const key = credential.ai
    if (!key) throw fail(409,'请先在设置中填写并保存你自己的 4yi API Key')
    const selection = capability === 'text'
      ? toolModelSelection(protocolModelSelection(resolveCapability(policy,department,capability), policy, path), policy, body)
      : resolveCapability(policy,department,capability)
    const anthropic = path === '/api/anthropic/v1/messages'
    const textCall = anthropic || path === '/api/v1/chat/completions'
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(anthropic ? { 'x-api-key':key,'anthropic-version':'2023-06-01' } : {}) }
    let requestBody = body, reservation, outputLimit, billingId, receipt
    const kind = textCall ? (capability === 'search' ? 'search' : 'text') : path.includes('/images/') ? 'image' : 'video'
    const settle = async (state, usage) => {
      if (reservation) await settleTokens(pool,ctx,reservation,state,usage)
      await finishBilling(pool,ctx,billingId,state,usage,receipt)
    }
    const reserveCall = async (model, tokens = 0) => {
      billingId = await beginBilling(pool,ctx,{model,department,kind,input:tokens ? tokens-outputLimit : 0,output:outputLimit||0,
        uncertain:!!(body?.tools?.length || body?.web_search_options || body?.messages?.some(m=>Array.isArray(m.content)))})
      reservation = undefined
      try { if(textCall) reservation = await reserveTokens(pool,ctx,{department,model,limit:policy.budget.daily_token_limit,tokens,id:billingId}) }
      catch(error){await finishBilling(pool,ctx,billingId,'rejected');throw error}
    }
    if (!textCall) {
      const kind = path.includes('/images/') ? 'image' : 'video'
      const model = resolveCapability(policy,department,kind).model
      if (!model) throw fail(409, kind === 'image' ? '请先选择图片模型' : '请先选择视频模型')
      requestBody = { ...body, model }
    }
    if (textCall) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400,'模型请求格式不正确')
      requestBody = { ...body,model:selection.model }
      // One completion per request; tools remain available to the original workflow.
      if (!anthropic) requestBody.n = 1
      outputLimit = body.max_completion_tokens ?? body.max_tokens ?? 4096
      if (!Number.isSafeInteger(outputLimit) || outputLimit < 1) throw fail(400,'模型输出额度必须为正整数')
      if (!anthropic && body.max_completion_tokens !== undefined) {
        delete requestBody.max_tokens
        requestBody.max_completion_tokens = outputLimit
      } else {
        delete requestBody.max_completion_tokens
        requestBody.max_tokens = outputLimit
      }
      if (body.stream && !anthropic) requestBody.stream_options = { include_usage:true }
      // A conservative text estimate; remote media may cost more. Actual usage always wins.
      const reserve = Buffer.byteLength(JSON.stringify(requestBody))*2 + 4096 + outputLimit
      await reserveCall(selection.model, reserve)
    }
    if (!textCall) await reserveCall(requestBody.model)
    let response
    try {
      response = await fetcher(`https://app.4yi.ai${path}`, { method:'POST',headers,body:JSON.stringify(anthropic ? requestBody : toolCompatibleRequest(requestBody)),redirect:'error',signal:AbortSignal.timeout(300000) })
      receipt = response.headers.get('x-request-id') || response.headers.get('request-id')
      // A fallback is a new request only after an explicit pre-output rejection. Never retry a timeout or an accepted media job.
      if (allowFallback && textCall && [429,502,503,504].includes(response.status) && selection.fallback && selection.fallback !== selection.model) {
        await response.body?.cancel()
        // Keep the first reservation: the upstream may have done work before returning an error.
        await settle('unknown')
        receipt = undefined
        requestBody.model = selection.fallback
        const tokens = Buffer.byteLength(JSON.stringify(requestBody))*2+4096+outputLimit
        await reserveCall(selection.fallback,tokens)
        response = await fetcher(`https://app.4yi.ai${path}`,{method:'POST',headers,body:JSON.stringify(anthropic ? requestBody : toolCompatibleRequest(requestBody)),redirect:'error',signal:AbortSignal.timeout(300000)})
      }
    } catch (error) {
      await settle('unknown')
      if (error.expose) throw error
      throw fail(502,modelTransportError(error))
    }
    receipt = response.headers.get('x-request-id') || response.headers.get('request-id')
    if (!response.ok) {
      await settle([400,401,403,404,422].includes(response.status) ? 'rejected' : 'unknown')
      const searchRequest = body?.web_search_options || body?.tools?.some(tool => /^web_search_/.test(tool.type || ''))
      if (searchRequest && [400,422].includes(response.status)) {
        const error = await response.clone().json().catch(() => ({}))
        const message = String(error.error?.message || error.message || '').slice(0,2000)
        if (/unsupported server tool|web_search|web search|search.*not supported/i.test(message)) {
          await response.body?.cancel()
          throw fail(409,'当前调研模型的中转通道未开放内置联网搜索；请在现有模型服务中开通此能力')
        }
      }
      const failure = await response.json().catch(() => ({}))
      throw modelRequestError(response.status, failure)
    }
    if (textCall && body.stream) {
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await settle('unknown'); await response.body?.cancel()
        throw fail(502,'模型服务未返回有效的流式响应')
      }
      const meter = streamUsage(anthropic), decoder = new TextDecoder()
      async function* forward() {
        try {
          for await (const chunk of response.body) { meter.feed(decoder.decode(chunk,{stream:true})); yield chunk }
          meter.feed(decoder.decode())
        } finally { await settle('completed',meter.result()) }
      }
      return reply.header('content-type','text/event-stream').header('x-accel-buffering','no').send(Readable.from(forward()))
    }
    let result
    try { result = await response.json() }
    catch { await settle('unknown'); throw fail(502,'模型返回内容无法解析') }
    if(path==='/api/v1/videos/generations'){
      const id=result?.id||result?.generation_id||result?.task_id||result?.data?.id||result?.data?.generation_id||result?.data?.task_id
      if(typeof id!=='string'||!/^[a-zA-Z0-9._-]+$/.test(id)){await settle('unknown');throw fail(502,'视频服务返回的任务编号无效，请勿重复提交')}
      await transaction(pool,db=>db.query('INSERT INTO personal_provider_assets(tenant_id,user_id,provider_id,key_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ctx.tenantId,ctx.userId,id,credential.revision]),ctx)
    }
    receipt ||= result?.id
    await settle('completed',readUsage(result,anthropic))
    return result
  }
}
export function registerModelGateway(app,{ scoped,pool,env,driver = createOperationsDriver(env,{pool}),fetcher = fetch }) {
  const call = createModelGateway({pool,env,fetcher})
  app.get('/api/tenants/:tenantId/operations/models',async req => {
    const {ctx} = await scoped(req,async (db,tenant,ctx) => ({ctx}))
    const key = (await transaction(pool,db => loadSecrets(db,env,ctx.tenantId,ctx.userId),ctx)).ai
    if (!key) throw fail(409,'请先在设置中填写并保存你自己的 4yi API Key')
    let response
    try { response = await fetcher('https://app.4yi.ai/api/v1/models',{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)}) }
    catch { throw fail(502,'暂时无法读取模型列表') }
    if (!response.ok) throw modelRequestError(response.status, await response.json().catch(() => ({})))
    const data = await response.json()
    const catalog = modelCatalog(data).map(m=>({...m, searchVerified: ['gemini-3.5-flash','gemini-2.5-pro','grok-4.3'].includes(m.id)}))
    return { models: catalog.map(m => m.id), catalog }
  })
  app.post('/api/tenants/:tenantId/departments/:department/messages',async (req,reply) => {
    const input = z.object({prompt:z.string().trim().min(1).max(20000)}).strict().parse(req.body)
    const {ctx,policy} = await scoped(req,async (db,tenant,ctx) => ({ctx,...await loadPolicy(db,ctx.tenantId,env)}))
    return call({ctx,policy,department:req.params.department,path:'/api/v1/chat/completions',body:{messages:[{role:'user',content:input.prompt}],max_tokens:4096},reply})
  })
  // Private AiToEarn uses a tenant-bound internal token, never the provider key.
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/, {parseAs:'buffer'}, (_req,body,done) => done(null,body))
  app.all('/integrations/model-gateway/:tenantId/*',{bodyLimit:32*1024*1024},async (req,reply) => {
    const tenantId = z.uuid().parse(req.params.tenantId), entry = await driver.binding(tenantId)
    if(!entry)throw fail(403,'运行服务认证失败')
    const path = `/${req.params['*']}`
    if(validGatewayToken(entry.bridgeSecret,tenantId,req.headers.authorization)){
      if(req.method!=='GET'||path!=='/api/v1/models'||req.url.includes('?'))throw fail(403,'运行服务必须提供个人身份，禁止共用 Key 调用')
      // Startup metadata only. This branch never reads or calls a provider credential.
      const {policy}=await transaction(pool,db=>loadPolicy(db,tenantId,env),{tenantId,userId:''})
      const catalog=[]
      for(const kind of ['image','video']){try{catalog.push({id:resolveCapability(policy,'content_ops',kind).model,type:kind})}catch{}}
      return {object:'list',data:runtimeModelCatalog(catalog,policy)}
    }
    const ctx = await runtimeUserContext(pool,{...entry,tenantId},req.headers.authorization)
    const {policy} = await transaction(pool,db => loadPolicy(db,tenantId,env),ctx)
    resolveDepartment(policy,'content_ops')
    const textPath = ['/api/v1/chat/completions','/api/anthropic/v1/messages'].includes(path)
    const mediaCreate = ['/api/v1/images/generations','/api/v1/videos/generations','/api/v1/images/edits'].includes(path)
    const mediaRead = /^\/api\/v1\/videos\/generations\/[a-zA-Z0-9._-]+(?:\/artifact)?$/.test(path)
    // Claude Agent SDK's beta Messages client always adds this fixed flag.
    // It does not select a provider or loosen user authentication; all other queries stay blocked.
    const sdkBeta = req.method === 'POST' && path === '/api/anthropic/v1/messages' && req.url.split('?')[1] === 'beta=true'
    if ((req.url.includes('?') && !sdkBeta) || !((req.method === 'POST' && (textPath || mediaCreate)) || (req.method === 'GET' && (mediaRead || path === '/api/v1/models')))) throw fail(404,'模型接口尚未接入')
    if (path === '/api/v1/images/edits') {
      const key = (await transaction(pool,db => loadSecrets(db,env,tenantId,ctx.userId),ctx)).ai
      if (!key) throw fail(409,'请先在设置中填写并保存你自己的 4yi API Key')
      if (!Buffer.isBuffer(req.body)) throw fail(400,'图片编辑需要 multipart 文件请求')
      const imageModel = resolveCapability(policy,'content_ops','image').model
      let form
      try { form = await new Request('http://localhost',{method:'POST',headers:{'content-type':req.headers['content-type']},body:req.body}).formData() }
      catch { throw fail(400,'图片编辑文件格式不正确') }
      form.set('model',imageModel)
      const billingId = await beginBilling(pool,ctx,{model:imageModel,department:'content_ops',kind:'image',step:'图片编辑'})
      let response
      try {
        response = await fetcher(`https://app.4yi.ai${path}`,{method:'POST',headers:{authorization:`Bearer ${key}`},body:form,redirect:'error',signal:AbortSignal.timeout(300000)})
        if (!response.ok) {
          await finishBilling(pool,ctx,billingId,[400,401,403,404,422].includes(response.status)?'rejected':'unknown',undefined,response.headers.get('x-request-id'))
          throw modelRequestError(response.status, await response.json().catch(() => ({})))
        }
        const result=await response.json()
        await finishBilling(pool,ctx,billingId,'completed',undefined,response.headers.get('x-request-id')||result.id)
        return result
      } catch(error) { await finishBilling(pool,ctx,billingId,'unknown'); throw error }
    }
    if (req.method === 'POST') return call({ctx,policy,department:'content_ops',path,body:req.body,reply})
    const key = (await transaction(pool,db => loadSecrets(db,env,tenantId,ctx.userId),ctx)).ai
    if (!key) throw fail(409,'请先在设置中填写并保存你自己的 4yi API Key')
    if(mediaRead){
      const id=path.split('/')[5]
      await transaction(pool,async db=>{
        const asset=(await db.query('SELECT key_revision FROM personal_provider_assets WHERE tenant_id=$1 AND user_id=$2 AND provider_id=$3',[tenantId,ctx.userId,id])).rows[0]
        if(!asset)throw fail(404,'视频任务不属于当前用户')
        const credential=await loadSecrets(db,env,tenantId,ctx.userId)
        if(credential.revision!==asset.key_revision)throw fail(409,'个人 Key 已更换或移除，请核对原视频任务使用的账号；不会换用其他 Key')
      },ctx)
    }
    const response = await fetcher(`https://app.4yi.ai${path}`,{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(300000)})
    if (!response.ok) throw modelRequestError(response.status, await response.json().catch(() => ({})))
    if(path==='/api/v1/models'){
      const catalog=await response.json()
      if(!Array.isArray(catalog.data))throw fail(502,'模型目录格式不正确')
      return {object:'list',data:runtimeModelCatalog(catalog.data,policy)}
    }
    return reply.header('content-type',response.headers.get('content-type') || 'application/octet-stream').send(Readable.fromWeb(response.body))
  })
}
