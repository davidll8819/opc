import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { configKey } from './operations/security.mjs'
import { loadMediaOrigins } from './operations/media-origins.mjs'

function httpsOrigin(value) {
  try {
    const u = new URL(value)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      u.pathname === '/' &&
      u.origin === value &&
      !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) &&
      !u.hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

// Return only fixed labels and booleans. Never include environment values or caught errors.
export async function productionChecks(env) {
  const checks = []
  const add = (id, ok, instruction) => checks.push({ id, ok: Boolean(ok), instruction })
  add('production_mode', env.NODE_ENV === 'production', '正式服务必须使用 production 模式')
  add(
    'https_origin',
    httpsOrigin(env.APP_ORIGIN),
    'APP_ORIGIN 必须是无账号、路径和参数的 HTTPS 站点地址',
  )
  add(
    'formal_auth',
    ['cognito', '4yi'].includes(env.AUTH_MODE),
    '正式服务必须使用 Cognito 或经过签名校验的 4yi 登录，不能使用本地测试账号',
  )
  if (env.AUTH_MODE === '4yi') {
    add('fouryi_identity_key', /^[a-f0-9]{64}$/.test(env.FOURYI_ROUTER_IDENTITY_KEY || ''), '需要平台安全注入路由签名校验密钥')
    add('fouryi_hostname', typeof env.XCLAW_APP_HOSTNAME === 'string' && env.APP_ORIGIN === `https://${env.XCLAW_APP_HOSTNAME.toLowerCase()}`, '平台主机名必须与应用 HTTPS 入口一致')
    add('fouryi_portal', httpsOrigin(env.FOURYI_PORTAL_ORIGIN), '配置返回 4yi 平台的 HTTPS 入口')
  } else {
  add(
    'identity_issuer',
    /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[A-Za-z0-9_-]+$/.test(
      env.COGNITO_ISSUER || '',
    ),
    '填写有效的 Cognito 用户池签发地址',
  )
  add('identity_domain', httpsOrigin(env.COGNITO_DOMAIN), '填写 Cognito 的 HTTPS 登录域名')
  add(
    'identity_client',
    /^[a-zA-Z0-9]{1,128}$/.test(env.COGNITO_CLIENT_ID || ''),
    '填写 Cognito 应用客户端编号',
  )
  add(
    'origin_protection',
    typeof env.ORIGIN_VERIFY_SECRET === 'string' && env.ORIGIN_VERIFY_SECRET.trim().length >= 32,
    '配置至少 32 字符的源站验证密钥，并在可信代理注入',
  )
  }
  let redisSecure = false
  try {
    redisSecure = new URL(env.REDIS_URL).protocol === 'rediss:'
  } catch {}
  add('redis_tls', redisSecure, '正式缓存连接必须使用 rediss 加密连接')
  let cert = false
  try {
    cert = new X509Certificate(await readFile(env.PGSSLROOTCERT)).ca
  } catch {}
  add('postgres_tls', cert, '配置可读的 PostgreSQL 可信根证书 PGSSLROOTCERT')
  let postgresUrl = true
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL)
      postgresUrl =
        ['postgres:', 'postgresql:'].includes(url.protocol) &&
        ![...url.searchParams.keys()].some((key) => /^ssl|^uselibpqcompat$/i.test(key))
    } catch {
      postgresUrl = false
    }
  }
  add(
    'postgres_tls_override',
    postgresUrl,
    'DATABASE_URL 不得携带覆盖证书验证的 SSL 参数；统一使用 PGSSLROOTCERT',
  )
  let key = false
  try {
    await configKey(env)
    key = true
  } catch {}
  add('config_encryption', key, '安全注入现有企业加密主密钥；不可随意生成新值替换旧值')
  let media = false
  try {
    media = (await loadMediaOrigins(env)).every((origin) => origin.startsWith('https://'))
  } catch {}
  add(
    'media_https',
    media,
    '媒体运行配置必须可读，正式媒体地址必须使用 HTTPS；私有访问仍需另外验收',
  )
  return checks
}

export async function assertProductionEnvironment(env) {
  if (env.NODE_ENV !== 'production') return
  const failed = (await productionChecks(env)).filter((c) => !c.ok)
  if (failed.length)
    throw new Error(`Production configuration rejected: ${failed.map((c) => c.id).join(', ')}`)
}

export async function assertRestrictedDatabaseRole(pool) {
  const {
    rows: [role],
  } = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  if (!role || role.rolsuper || role.rolbypassrls)
    throw new Error('Production database role must not bypass row permissions')
}
