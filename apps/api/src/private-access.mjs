import { fail } from './db.mjs'

export function validatePrivateAccess({ origin, login }) {
  let url
  try {
    url = new URL(origin)
  } catch {
    throw new Error('Private access requires a valid HTTPS origin')
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.port ||
    url.username ||
    url.password ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.ts\.net$/.test(
      url.hostname,
    )
  )
    throw new Error('Private access must use this Mac’s exact HTTPS Tailscale DNS name')
  if (typeof login !== 'string' || login.length > 254 || !/^[\x21-\x7e]+$/.test(login))
    throw new Error('Private access requires one exact Tailscale login')
  return { origin: url.origin, host: url.host, login }
}

export function privateAccessPolicy(env) {
  const configured = !!(env.PRIVATE_APP_ORIGIN || env.PRIVATE_TAILSCALE_LOGIN)
  if (!configured) return { config: null, context: () => null }
  if (
    env.NODE_ENV === 'production' ||
    env.AUTH_MODE !== 'local' ||
    !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(env.APP_ORIGIN) ||
    !env.LOCAL_EMAIL
  )
    throw new Error('Private access is only supported by the loopback personal Mac installation')
  const config = validatePrivateAccess({
    origin: env.PRIVATE_APP_ORIGIN,
    login: env.PRIVATE_TAILSCALE_LOGIN,
  })
  const localHosts = new Set(['localhost:3000', '127.0.0.1:3000'])
  function context(req) {
    const host = String(req.headers.host || '').toLowerCase()
    if (localHosts.has(host)) {
      // Do not accept a reverse proxy that rewrites Host to bypass the private gate.
      if (req.headers['tailscale-user-login'] || req.headers.origin === config.origin)
        throw fail(403, '私有连接的请求地址不匹配')
      return null
    }
    const peer = req.raw?.socket?.remoteAddress
    if (
      host !== config.host ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) ||
      req.headers['tailscale-user-login'] !== config.login
    )
      throw fail(403, '此设备没有访问私人办公室的权限')
    if (req.headers.origin && req.headers.origin !== config.origin)
      throw fail(403, '私有连接的请求来源无效')
    return { origin: config.origin, login: config.login }
  }
  return { config, context }
}
