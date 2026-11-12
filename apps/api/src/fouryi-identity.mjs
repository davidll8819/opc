import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { fail } from './db.mjs'

export function fouryiEnvironment(env) {
  if (env.AUTH_MODE !== '4yi') return env
  const host = env.XCLAW_APP_HOSTNAME
  if (typeof host !== 'string' || host.length > 253 || !host.includes('.') ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))
    throw Error('4yi application hostname is required')
  const origin = `https://${host.toLowerCase()}`
  if (env.APP_ORIGIN && env.APP_ORIGIN !== origin) throw Error('4yi application origin mismatch')
  return { ...env, APP_ORIGIN: origin }
}

export function createFouryiIdentity({ env, pool, cache, now = Date.now }) {
  const host = new URL(env.APP_ORIGIN).hostname.toLowerCase(), key = env.FOURYI_ROUTER_IDENTITY_KEY
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw Error('4yi router verification key is required')
  const sha = text => createHash('sha256').update(text).digest('hex')
  function headers(req) {
    const h = req.headers, time = h['x-xclaw-identity-time'], nonce = h['x-xclaw-identity-nonce'],
      signature = h['x-xclaw-identity-signature'], user = h['x-xclaw-user-id'], org = h['x-xclaw-owner-org-id']
    if (![time, nonce, signature, user, org, h['x-xclaw-hostname']].every(v => typeof v === 'string') ||
        !/^\d{13}$/.test(time) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature) ||
        !/^[A-Za-z0-9_.:@-]{1,200}$/.test(user) || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(org) ||
        h['x-xclaw-hostname'].toLowerCase() !== host || Math.abs(now() - Number(time)) > 30000)
      throw fail(401, '请从 4yi 平台重新打开应用')
    return { time, nonce, signature, user, org }
  }
  async function verify(req, bytes) {
    const p = headers(req)
    const message = JSON.stringify(['v1', host, req.method, req.raw?.url || req.url, p.user, p.org, p.time, p.nonce, sha(bytes)])
    const expected = createHmac('sha256', key).update(message).digest()
    if (!timingSafeEqual(expected, Buffer.from(p.signature, 'hex'))) throw fail(401, '平台身份验证失败')
    // Shared cache makes replay prevention cover all application replicas and app restarts.
    if (!await cache.set(`4yi-nonce:${host}:${p.nonce}`, '1', { NX: true, EX: 65 }))
      throw fail(401, '平台请求已失效，请重试')
    return { user: p.user, org: p.org }
  }
  function exempt(req) {
    return (req.method === 'GET' && ['/health/live', '/health/ready'].includes(req.url)) || req.url.startsWith('/integrations/')
  }
  function register(app) {
    app.decorateRequest('platformIdentity', null)
    app.addHook('onRequest', async req => { if (!exempt(req)) headers(req) })
    app.addHook('preParsing', async (req, _reply, payload) => {
      if (exempt(req)) return payload // Integration endpoints retain their own existing bridge/JWT authentication.
      const chunks = []; let size = 0
      for await (const chunk of payload) {
        size += chunk.length
        if (size > (req.routeOptions.bodyLimit ?? 65536)) throw fail(413, '请求内容过大')
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      req.platformIdentity = await verify(req, bytes)
      const stream = Readable.from([bytes]); stream.receivedEncodedLength = bytes.length
      return stream
    })
  }
  async function session(req) {
    const identity = req.platformIdentity
    if (!identity) throw fail(401, '平台身份验证失败')
    // Org is part of the subject. Same user ID in another installation org cannot inherit access.
    const scope = sha(JSON.stringify([identity.org, identity.user])), subject = `4yi:${scope}`
    const { rows: [existing] } = await pool.query('SELECT id,email FROM users WHERE subject=$1', [subject])
    const user = existing || (await pool.query(
      'INSERT INTO users(id,subject,email) VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id,email',
      [randomUUID(), subject, `4yi-${scope}@users.invalid`],
    )).rows[0]
    return { userId: user.id, email: user.email, origin: env.APP_ORIGIN,
      csrf: createHmac('sha256', key).update(`office-csrf:${scope}`).digest('hex') }
  }
  return { register, session, verify }
}
