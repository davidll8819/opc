import { digest } from './operations/security.mjs'
import { modelDepartment } from '../../../packages/employees/registry.mjs'
import { z } from 'zod'
import { fail } from './db.mjs'
import { createModelGateway, loadPolicy, toolModelSelection } from './operations/gateway.mjs'
import { loadSecrets } from './operations/credentials.mjs'
import { resolveCapability } from './operations/policy.mjs'
import { modelErrorMessage } from './operations/model-errors.mjs'
import { throttle } from './cache.mjs'
import { DEPARTMENT_NAMES } from '../../../packages/employees/registry.mjs'
import { findEmployee } from './employee-directory.mjs'

export const diagnosticRevision = ({revision,policy}) => parseInt(digest({revision,departments:policy.departments,profiles:policy.employeeProfiles}).slice(0,7),16)

export function registerEmployeeDiagnostics(app, { scoped, pool, env, fetcher, cache }) {
  const call = createModelGateway({ pool, env, fetcher })
  const active = new Set()
  app.get('/api/tenants/:tenantId/employees/self-check/history', req => scoped(req, async (db, tenant, ctx) => {
    const revision = diagnosticRevision(await loadPolicy(db, ctx.tenantId, env))
    const { rows } = await db.query('SELECT department,config_revision,result,created_at FROM employee_diagnostic_history WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100', [ctx.tenantId, ctx.userId])
    return { items: rows.map(row => ({ ...row.result, stale: row.config_revision !== revision })) }
  }, ['owner', 'admin']))
  app.post('/api/tenants/:tenantId/employees/self-check', async req => {
    const { department } = z.object({ department: z.string().min(1).max(80) }).strict().parse(req.body)
    const snapshot = await scoped(req, async (db, tenant, ctx) => {await findEmployee(db,ctx.tenantId,department);return { ctx, ...(await loadPolicy(db, ctx.tenantId, env)), key: (await loadSecrets(db, env, ctx.tenantId, ctx.userId)).ai }}, ['owner', 'admin'])
    snapshot.revision = diagnosticRevision(snapshot)
    const { ctx, policy, key } = snapshot
    const save = async result => {
      await scoped(req, db => db.query('INSERT INTO employee_diagnostic_history(tenant_id,user_id,department,config_revision,result) VALUES($1,$2,$3,$4,$5)', [ctx.tenantId, ctx.userId, department, snapshot.revision, result]))
      return result
    }
    const scope = `${ctx.tenantId}:${ctx.userId}`
    if (active.has(scope)) throw fail(409, '员工自检正在进行，请等待完成')
    if (!(await throttle(cache, `employee-check:${scope}`, 12, 60))) throw fail(429, '自检过于频繁，请稍后再试')
    const result = { department, checkedAt: new Date().toISOString(), enabled: (policy.departments[department] || policy.departments[modelDepartment(department)]).enabled, checks: [] }
    if (!result.enabled) return save({ ...result, checks: [{ name: '配置', state: 'skipped', detail: '该员工未启用，没有发送测试请求' }] })
    if (!key) return save({ ...result, checks: [{ name: '密钥', state: 'failed', detail: '尚未保存 API Key' }] })
    active.add(scope)
    try {
      let ids
      try {
        const response = await (fetcher || fetch)('https://app.4yi.ai/api/v1/models', { headers: { authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw fail(502, modelErrorMessage(response.status, await response.json().catch(() => ({}))))
        const data = await response.json()
        if (!Array.isArray(data.data)) throw fail(502, '模型列表格式无效')
        ids = new Set(data.data.map(m => m.id))
        result.checks.push({ name: '密钥与模型列表', state: 'passed', detail: '授权查询成功' })
      } catch (e) {
        result.checks.push({ name: '密钥与模型列表', state: 'failed', detail: e.expose ? e.message : '无法连接模型服务，请检查网络或稍后重试' })
        return await save(result)
      }
      for (const kind of ['image', 'video', 'search']) {
        try {
          const selected = resolveCapability(policy, department, kind)
          result.checks.push({ name: { image: '图片', video: '视频', search: '搜索' }[kind], state: ids.has(selected.model) ? 'unverified' : 'failed', model: selected.model, detail: ids.has(selected.model) ? '模型在列表中；未执行生成或联网测试' : '模型不在服务列表中，请重新选择' })
        } catch { result.checks.push({ name: { image: '图片', video: '视频', search: '搜索' }[kind], state: 'skipped', detail: '未启用或未配置' }) }
      }
      for (const tool of [false, true]) {
        const name = tool ? '员工工具协议' : '文字回复'
        const body = { messages: [{ role: 'user', content: tool ? 'Call diagnostic_ping with value OK.' : 'Reply only OK.' }], max_tokens: 256,
          ...(tool ? { tools: [{ type: 'function', function: { name: 'diagnostic_ping', description: 'Protocol test only; no action is executed.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }], tool_choice: { type: 'function', function: { name: 'diagnostic_ping' } } } : {}) }
        try {
          const selected = resolveCapability(policy, department, 'text')
          const effective = toolModelSelection(selected, policy, body)
          const response = await call({ ctx, policy, department, path: '/api/v1/chat/completions', body, allowFallback: false })
          const message = response.choices?.[0]?.message
          const ok = tool ? message?.tool_calls?.some(t => t.function?.name === 'diagnostic_ping') : typeof message?.content === 'string' && !!message.content.trim()
          result.checks.push({ name, model: effective.model, state: ok ? 'passed' : 'failed', detail: ok ? tool ? '工具协议通过；没有执行真实工具' : '收到有效文字回复' : '未返回预期结果，请检查模型输出或额度' })
        } catch (e) { result.checks.push({ name, state: 'failed', detail: e.expose ? e.message : '自检未完成，请检查服务状态' }) }
      }
      return await save(result)
    } finally { active.delete(scope) }
  })
}
