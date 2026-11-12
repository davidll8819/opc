import { randomUUID,createHash } from 'node:crypto'
import { z } from 'zod'
import { configKey,encryptConfig,decryptConfig } from './operations/security.mjs'
import { fail } from './db.mjs'
import { modelCatalog } from './operations/model-catalog.mjs'

export const runtimeUserId=(tenantId,userId)=>createHash('sha256').update(`wishtaday-user-v1:${tenantId}:${userId}`).digest('hex').slice(0,24)
export async function personalCredential(db,env,ctx) {
 if(!ctx.userId)throw fail(409,'无法确认任务发起人，已停止模型调用')
 const row=(await db.query('SELECT encrypted_key,revision FROM personal_model_keys WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,ctx.userId])).rows[0]
 if(!row?.encrypted_key)return {ai:'',revision:row?.revision||0}
 return {ai:decryptConfig(row.encrypted_key,await configKey(env),`${ctx.tenantId}:${ctx.userId}`).apiKey,revision:row.revision}
}
export function registerPersonalKey(app,{scoped,env,fetcher=fetch}) {
 const root='/api/tenants/:tenantId/personal-api-key'
 async function legacy(db,tenant,ctx){
  if(tenant.role!=='owner')return ''
  const row=(await db.query('SELECT encrypted_config,updated_by FROM operations_settings WHERE tenant_id=$1',[ctx.tenantId])).rows[0]
  if(!row||row.updated_by!==ctx.userId)return ''
  const stored=decryptConfig(row.encrypted_config,await configKey(env),ctx.tenantId)
  return stored.credentials?.ai||stored.aiKey||''
 }

 async function save(db,ctx,input){
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[ctx.userId])
  const old=(await db.query('SELECT revision FROM personal_model_keys WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,ctx.userId])).rows[0]
  if((old?.revision||0)!==input.revision)throw fail(409,'个人 Key 已在其他页面更新，请重新载入')
  const encrypted=encryptConfig({apiKey:input.apiKey},await configKey(env),`${ctx.tenantId}:${ctx.userId}`)
  const row=(await db.query('INSERT INTO personal_model_keys(tenant_id,user_id,encrypted_key) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET encrypted_key=$3,revision=personal_model_keys.revision+1,updated_at=now() RETURNING revision,updated_at',[ctx.tenantId,ctx.userId,encrypted])).rows[0]
  await db.query('INSERT INTO runtime_identities(tenant_id,user_id,runtime_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ctx.tenantId,ctx.userId,runtimeUserId(ctx.tenantId,ctx.userId)])
  await db.query('INSERT INTO audit_events(id,tenant_id,user_id,action) VALUES($1,$2,$3,$4)',[randomUUID(),ctx.tenantId,ctx.userId,'personal-key.saved'])
  return {configured:true,revision:row.revision,updatedAt:row.updated_at,scope:'personal'}
 }
 app.get(root,req=>scoped(req,async(db,tenant,ctx)=>{
  const row=(await db.query("SELECT revision,updated_at,encrypted_key<>'' as configured FROM personal_model_keys WHERE tenant_id=$1 AND user_id=$2",[ctx.tenantId,ctx.userId])).rows[0]
  return {configured:!!row?.configured,revision:row?.revision||0,updatedAt:row?.updated_at||null,scope:'personal',legacyAvailable:!row?.configured&&!!await legacy(db,tenant,ctx)}
 }))
 app.put(root,req=>scoped(req,async(db,tenant,ctx)=>{
  const input=z.object({apiKey:z.string().trim().min(8).max(4096).regex(/^[^\s]+$/),revision:z.number().int().nonnegative()}).strict().parse(req.body)
  return save(db,ctx,input)
 }))
 app.post(`${root}/import-legacy`,req=>scoped(req,async(db,tenant,ctx)=>{
  const input=z.object({revision:z.number().int().nonnegative(),confirmed:z.literal(true)}).strict().parse(req.body)
  const apiKey=await legacy(db,tenant,ctx)
  if(!apiKey)throw fail(409,'无法确认原凭据由你保存，请到 4yi 后台获取自己的 Key 后填写')
  const current=await personalCredential(db,env,ctx)
  if(current.ai)throw fail(409,'已有个人 Key，不会覆盖；需要更换时请手动填写')
  return save(db,ctx,{...input,apiKey})
 },['owner']))
 app.delete(root,req=>scoped(req,async(db,tenant,ctx)=>{
  const input=z.object({revision:z.number().int().positive()}).strict().parse(req.body)
  const deleted=await db.query("UPDATE personal_model_keys SET encrypted_key='',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND revision=$3 RETURNING revision",[ctx.tenantId,ctx.userId,input.revision])
  if(!deleted.rows.length)throw fail(409,'个人 Key 已改变，请重新载入')
  return {configured:false,revision:deleted.rows[0].revision,updatedAt:null,scope:'personal'}
 }))
 app.post(`${root}/verify`,async req=>{
  const key=await scoped(req,async(db,tenant,ctx)=>(await personalCredential(db,env,ctx)).ai)
  if(!key)throw fail(409,'请先填写并保存你自己的 4yi API Key')
  let response
  try{response=await fetcher('https://app.4yi.ai/api/v1/models',{headers:{authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)})}catch{throw fail(502,'连接 4yi 超时，请稍后再试；没有发起付费生成')}
  if(!response.ok){await response.body?.cancel();throw fail(response.status===401||response.status===403?409:502,'个人 Key 验证失败，请检查有效期、权限及服务状态')}
  const catalog=modelCatalog(await response.json())
  return {verified:true,models:catalog.length,catalog,message:'已通过模型目录验证，没有发起付费生成'}
 })
}
