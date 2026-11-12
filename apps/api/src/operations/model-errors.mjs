import { fail } from '../db.mjs'

// Only these schema field names may be retained; provider messages can contain
// credentials, prompts and signed URLs. Never log or return the raw response.
const parameters = new Set(['max_tokens', 'max_completion_tokens', 'thinking', 'budget_tokens', 'temperature', 'top_p', 'messages', 'tools', 'tool_choice', 'input_schema', 'response_format', 'model', 'stream', 'system', 'image', 'image_url'])
export function modelErrorDiagnostic(status, data = {}) {
  const supplied = data?.error?.param ?? data?.param
  const message = String(data?.error?.message || data?.message || '').slice(0, 8000)
  const parameter = parameters.has(supplied) ? supplied
    : [...parameters].find(name => new RegExp(`\\b${name}\\b`, 'i').test(message)) || 'unknown'
  const category = [400, 422].includes(status) ? 'invalid_parameters'
    : status === 429 ? 'rate_limit'
      : [401, 403].includes(status) ? 'authentication'
        : status === 404 ? 'not_found' : 'provider_error'
  return { upstreamStatus: status, category, parameter }
}

export function modelRequestError(status, data = {}) {
  // SDKs retry 5xx automatically. An explicit parameter rejection must stay 4xx.
  const code = [400, 401, 402, 403, 404, 413, 422, 429].includes(status) ? status : 502
  return Object.assign(fail(code, modelErrorMessage(status, data)), {
    modelDiagnostic: modelErrorDiagnostic(status, data),
  })
}

// Return actionable categories, never raw provider text (which may contain secrets/prompts).
export function modelErrorMessage(status, data = {}) {
  const message = String(data?.error?.message || data?.message || '').toLowerCase()
  if (status === 401) return '模型密钥无效或已过期，请在设置中更新并保存 API Key'
  if (status === 402 || /insufficient.*(balance|credit)|余额不足|quota.*exceeded/.test(message)) return '模型服务余额或配额不足，请检查服务商账户'
  if (status === 403) return '模型访问被拒绝，请检查密钥的模型权限或服务商限制'
  if (status === 404 || /model.*(not found|does not exist)/.test(message)) return '所选模型或接口不存在，请刷新模型列表后重新选择'
  if (status === 429) return '模型服务暂时限流，请稍后手动重试；不要连续重复提交'
  if (status === 413) return '模型请求内容过大，请缩减任务上下文或附件后再继续'
  if ([400, 422].includes(status)) {
    if (/context.{0,30}(length|limit|window)|too many tokens|prompt is too long/.test(message)) return '模型上下文超出限制，请缩减任务历史或附件后再继续'
    if (/max_tokens|max_completion_tokens/.test(message)) return '模型输出额度参数不兼容，请运行员工自检并检查服务版本'
    if (/thinking|budget_tokens|signature/.test(message)) return '模型思考参数或历史思考内容不兼容，请检查所选模型与会话格式'
    if (/reasoning|function tools|tool_choice|tools/.test(message)) return '当前模型通道不兼容此工具调用，请选择兼容的备用文字模型'
    const { parameter } = modelErrorDiagnostic(status, data)
    return '模型服务拒绝请求参数，请运行员工自检并检查所选模型的能力' + (parameter === 'unknown' ? '' : `（字段：${parameter}）`)
  }
  return '模型服务暂时异常，结果可能未知；请先核对任务状态，再决定是否重试'
}

// Only allowlisted transport codes reach users; never copy raw exception messages/headers.
export function modelTransportError(error) {
  const codes = new Set(), seen = new Set(), pending = [error]
  for (let i = 0; i < pending.length && i < 20; i++) {
    const item = pending[i]
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item); codes.add(item.code); codes.add(item.name)
    if (item.cause) pending.push(item.cause)
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 10))
  }
  const has = (...values) => values.some(code => codes.has(code))
  const prefix = has('UND_ERR_CONNECT_TIMEOUT') ? '连接模型服务超时（连接尚未建立）'
    : has('ENOTFOUND', 'EAI_AGAIN') ? '模型服务域名解析失败'
    : has('CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT') ? '模型服务安全证书校验失败'
    : has('UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'TimeoutError', 'AbortError') ? '等待模型回复超时或请求被中止'
    : has('ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE') ? '模型连接中断'
    : '模型网络请求失败'
  return `${prefix}；结果未知，已保留预占额度，请勿自动重试`
}
