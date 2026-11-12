import {runtimeUserId} from '../personal-key.mjs'
import { readFile } from 'node:fs/promises'
import { SignJWT } from 'jose'
import { signBridge } from './security.mjs'
import { fail, transaction } from '../db.mjs'
export const legacyMediaOwner = Symbol('verified legacy media owner')
// Only an operator-owned file may assign private runtimes. Tenant inputs cannot select internal URLs.
export function createOperationsDriver(env,{pool}={}) {
  async function binding(tenantId, officeUserId) {
    if (!env.OPERATIONS_RUNTIMES_FILE) return null
    const entries = JSON.parse(await readFile(env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
    const entry = entries[tenantId]
    if (!entry) return null
    if (!entry.serverUrl || !entry.aiUrl || !entry.userId || !entry.jwtSecret || !entry.bridgeSecret) throw fail(503, '运营服务配置不完整')
    // An upstream instance has global provider credentials: sharing it would cross tenant boundaries.
    for (const [id, other] of Object.entries(entries)) {
      if (id !== tenantId && [other.serverUrl, other.aiUrl].some(url => [entry.serverUrl, entry.aiUrl].includes(url)))
        throw fail(503, '企业运行服务必须相互隔离')
    }
    const legacyTaskIds=pool&&officeUserId?await transaction(pool,async db=>(await db.query('SELECT runtime_task_id FROM legacy_runtime_tasks WHERE tenant_id=$1 AND user_id=$2',[tenantId,officeUserId])).rows.map(r=>r.runtime_task_id),{tenantId,userId:officeUserId}):[]
    return { ...entry, tenantId, officeUserId, legacyUserId:entry.userId, legacyTaskIds, userId:officeUserId?runtimeUserId(tenantId,officeUserId):entry.userId }
  }
  async function request(entry, service, path, { method = 'GET', body, signed = false, stream = false, signal } = {}) {
    if(!signed && !entry.officeUserId)throw fail(403,'运营请求缺少用户身份，已阻止共用账号调用')
    const origin = service === 'ai' ? entry.aiUrl : entry.serverUrl
    if(method!=='GET'&&body?.taskId&&entry.legacyTaskIds?.includes(body.taskId))throw fail(409,'旧视频任务可以预览、下载和剪辑；再次生成请创建新任务，使用你自己的 Key')
    const legacyRead=method==='GET'&&/^\/agent\/tasks\/[a-f0-9]{24}$/.test(path)&&entry.legacyTaskIds?.includes(path.split('/').at(-1))
    const jwt = await new SignJWT({ id: legacyRead?entry.legacyUserId:entry.userId, officeTenantId: entry.tenantId, ...(legacyRead?{officeLegacyRead:path}:{}) }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(stream ? '2h' : '5m').sign(new TextEncoder().encode(entry.jwtSecret))
    const res = await fetch(`${origin.replace(/\/$/, '')}${path}`, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(stream ? 3600000 : 30000)]) : AbortSignal.timeout(stream ? 3600000 : 30000),
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...(signed ? signBridge(entry.bridgeSecret, method, path, body ?? null) : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) { await res.body?.cancel(); throw fail(502, '运营服务请求失败，请检查运行服务配置') }
    if (stream) {
      if (!res.headers.get('content-type')?.includes('text/event-stream')) { await res.body?.cancel(); throw fail(502, '运营服务没有返回任务事件流') }
      return res.body
    }
    const data = await res.json()
    if (data.code !== undefined && data.code !== 0 && data.code !== 200) throw fail(502, '运营服务返回错误，请检查任务状态')
    const result=data.data ?? data
    if(legacyRead&&result&&typeof result==='object')Object.defineProperty(result,legacyMediaOwner,{value:entry.legacyUserId})
    return result
  }
  async function ready(tenantId, _revision, officeUserId) {
    const entry = await binding(tenantId, officeUserId)
    if (!entry) throw fail(503, '企业独立运行服务尚未部署')
    for (const service of ['server', 'ai']) {
      const info = await request(entry, service, '/office-bridge/status', { signed: true })
      if (info.version !== 5 || info.tenantId !== tenantId || info.publishMode !== 'manual')
        throw fail(503, '运营服务版本或企业配置尚未同步')
      if (info.draining) throw fail(503, '运营服务正在停止接收新任务，请等待维护完成')
    }
    return entry
  }
  return { binding, ready, request }
}
