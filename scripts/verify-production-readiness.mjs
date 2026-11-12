// Local-only drill: a fresh PostgreSQL database, private Redis socket and ephemeral HTTP port.
// Never generates media, contacts models, publishes, or writes to the business database.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createClient } from 'redis'
import { pgClient, pgEnvironment } from './backup/common.mjs'
import { migrate } from '../database/migrate.mjs'
import { buildApp } from '../apps/api/src/app.mjs'
import { hash } from '../apps/api/src/auth.mjs'
import { assertRestrictedDatabaseRole } from '../apps/api/src/startup-checks.mjs'

process.loadEnvFile('.env')
const admin = await pgClient(),
  name = `readiness_test_${randomUUID().replaceAll('-', '')}`
const dir = await mkdtemp(join(tmpdir(), 'w-ready-'))
let created = false,
  seed,
  pool,
  cache,
  app,
  redis,
  media,
  redisStopped = false
const held = [],
  evidence = { isolatedPostgres: true, isolatedRedis: true, paidModelCalls: 0 }
try {
  await admin.query(`CREATE DATABASE "${name}"`)
  created = true
  const pgEnv = pgEnvironment(name),
    connection = {
      host: pgEnv.PGHOST,
      port: Number(pgEnv.PGPORT || 5432),
      user: pgEnv.PGUSER,
      password: pgEnv.PGPASSWORD,
      database: name,
      max: 10,
      connectionTimeoutMillis: 5000,
    }
  seed = new pg.Pool(connection)
  await migrate(seed)
  await seed.query('GRANT USAGE ON SCHEMA public TO office_app')
  await seed.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO office_app')
  await seed.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO office_app')
  pool = new pg.Pool({ ...connection, options: '-c role=office_app' })
  await assertRestrictedDatabaseRole(pool)

  const socket = join(dir, 'redis.sock')
  redis = spawn(
    resolve('.local/services/bin/redis-server'),
    [
      '--port',
      '0',
      '--unixsocket',
      socket,
      '--unixsocketperm',
      '700',
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      dir,
      '--loglevel',
      'warning',
    ],
    { stdio: 'ignore' },
  )
  let spawnError = false
  redis.on('error', () => {
    spawnError = true
  })
  for (let i = 0; i < 50 && !(await stat(socket).catch(() => false)); i++) await delay(50)
  assert.equal(spawnError, false, 'Temporary Redis could not start')
  assert.ok(await stat(socket), 'Temporary Redis socket missing')
  cache = createClient({ socket: { path: socket, connectTimeout: 1000, reconnectStrategy: false } })
  cache.on('error', () => {})
  await cache.connect()
  const tenant = randomUUID(),
    other = randomUUID(),
    alice = randomUUID(),
    bob = randomUUID(),
    carol = randomUUID()
  for (const id of [alice, bob, carol]) {
    await seed.query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      id,
      id,
      `${id}@test.invalid`,
    ])
    await cache.set(
      `session:${hash(id)}`,
      JSON.stringify({ userId: id, email: `${id}@test.invalid`, csrf: id }),
      { EX: 600 },
    )
  }
  await seed.query(
    "INSERT INTO tenants(id,name) VALUES($1,'Temporary test'),($2,'Other temporary test')",
    [tenant, other],
  )
  await seed.query(
    "INSERT INTO memberships VALUES($1,$2,'owner'),($1,$3,'member'),($4,$5,'owner')",
    [tenant, alice, bob, other, carol],
  )
  await seed.query(
    "INSERT INTO operations_settings(tenant_id,encrypted_config,updated_by) VALUES($1,'synthetic-unused-config',$2)",
    [tenant, alice],
  )
  const file = randomUUID(),
    video = randomUUID(),
    bobFile = randomUUID(),
    runtimeId = 'a'.repeat(24)
  const bytes = Buffer.from('synthetic-video-byte-stream-for-authorization-only')
  for (const [id, user, mime] of [
    [file, alice, 'text/plain'],
    [video, alice, 'video/mp4'],
    [bobFile, bob, 'text/plain'],
  ])
    await seed.query(
      'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
      [id, tenant, user, 'test-file', mime, bytes],
    )
  await seed.query(
    "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'fixture','submitted',$4)",
    [randomUUID(), tenant, alice, runtimeId],
  )

  // A local media origin tests the real download stream without reading real videos.
  const { createServer } = await import('node:http')
  let mediaReads = 0,
    runtimeReads = 0
  media = createServer((_req, res) => {
    mediaReads++
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(bytes)
  })
  await new Promise((ok, no) => {
    media.once('error', no)
    media.listen(0, '127.0.0.1', ok)
  })
  const cdn = `http://127.0.0.1:${media.address().port}/bucket`,
    videoUrl = `${cdn}/fixture/ai/result.mp4`
  app = await buildApp({
    pool,
    cache,
    agents: { models: [], rates: {} },
    staticRoot: null,
    env: { NODE_ENV: 'test', APP_ORIGIN: 'https://readiness.test', LOG_LEVEL: 'silent' },
    modelFetch: async () => {
      throw Error('Paid access forbidden')
    },
    operationsDriver: {
      ready: async () => ({ userId: 'fixture', infrastructure: { assets: { cdnEndpoint: cdn } } }),
      request: async (_entry, service, path, options) => {
        assert.equal(service, 'ai')
        assert.equal(path, `/agent/tasks/${runtimeId}`)
        assert.ok(!options?.method || options.method === 'GET')
        runtimeReads++
        return { savedVideos: [{ status: 'SUCCESS', videoUrl }] }
      },
    },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const request = async (
    path,
    {
      user = alice,
      method = 'GET',
      origin = 'https://readiness.test',
      csrf = user,
      headers = {},
    } = {},
  ) => {
    const response = await fetch(address + path, {
      method,
      headers: {
        ...(user ? { cookie: `office_session=${user}` } : {}),
        origin,
        'x-csrf-token': csrf || '',
        ...headers,
      },
      signal: AbortSignal.timeout(10000),
    })
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    }
  }
  const base = `/api/tenants/${tenant}`,
    download = `${base}/operations/tasks/${runtimeId}/video/download?url=${encodeURIComponent(videoUrl)}`
  for (const path of [`${base}/files/${file}/download`, `${base}/files/${video}/video`, download]) {
    assert.equal((await request(path, { user: null })).status, 401)
    assert.equal((await request(path, { user: bob })).status, 404)
    assert.equal((await request(path, { user: carol })).status, 403)
    assert.equal((await request(path.replace(tenant, other))).status, 403)
    const response = await request(path)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, bytes)
    assert.match(response.headers.get('cache-control'), /no-store/)
  }
  assert.equal(mediaReads, 1)
  assert.equal(runtimeReads, 1)
  const partial = await request(`${base}/files/${video}/video`, { headers: { range: 'bytes=2-7' } })
  assert.equal(partial.status, 206)
  assert.deepEqual(partial.body, bytes.subarray(2, 8))
  assert.equal(
    (await request(`${base}/files/${video}/video`, { headers: { range: 'bytes=99999-' } })).status,
    416,
  )
  evidence.mediaIsolation = {
    unauthenticated: 401,
    otherUser: 404,
    otherTenant: 403,
    owner: 200,
    range: 206,
    invalidRange: 416,
    byteHashMatches:
      createHash('sha256').update(partial.body).digest('hex') ===
      createHash('sha256').update(bytes.subarray(2, 8)).digest('hex'),
  }

  assert.equal((await request(`${base}/files/${bobFile}/download`, { user: bob })).status, 200)
  const remove = `${base}/members/${bob}`
  assert.equal(
    (await request(remove, { method: 'DELETE', origin: 'https://untrusted.test' })).status,
    403,
  )
  assert.equal((await request(remove, { method: 'DELETE', csrf: 'wrong' })).status, 403)
  assert.equal((await request(remove, { method: 'DELETE', user: bob })).status, 403)
  assert.equal((await request(`${base}/files/${bobFile}/download`, { user: bob })).status, 200)
  assert.equal((await request(remove, { method: 'DELETE' })).status, 200)
  assert.equal((await request(`${base}/files/${bobFile}/download`, { user: bob })).status, 403)
  assert.equal((await request(`${base}/reuse`, { user: bob })).status, 403)
  evidence.revocationAndCsrf = true

  const expiring = randomUUID()
  await cache.set(
    `session:${hash(expiring)}`,
    JSON.stringify({ userId: alice, email: `${alice}@test.invalid`, csrf: expiring }),
    { PX: 150 },
  )
  assert.equal((await request('/api/me', { user: expiring })).status, 200)
  await delay(200)
  assert.equal((await request('/api/me', { user: expiring })).status, 401)
  assert.equal((await request('/auth/logout', { user: carol, method: 'POST' })).status, 200)
  assert.equal((await request('/api/me', { user: carol })).status, 401)
  evidence.expiryAndLogout = true

  // 30 read-only API requests per level, measured over actual HTTP/Redis/PostgreSQL.
  evidence.readOnlyLoad = []
  for (const concurrency of [5, 10, 20]) {
    const timings = [],
      statuses = [],
      start = performance.now()
    let next = 0
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < 30) {
          const n = next++,
            begin = performance.now()
          const result = await request(n % 2 ? `${base}/reuse` : `${base}/files`)
          timings.push(performance.now() - begin)
          statuses.push(result.status)
        }
      }),
    )
    timings.sort((a, b) => a - b)
    assert.equal(
      statuses.every((status) => status === 200),
      true,
    )
    evidence.readOnlyLoad.push({
      concurrency,
      requests: statuses.length,
      success: statuses.filter((s) => s === 200).length,
      elapsedMs: Math.round(performance.now() - start),
      p95Ms: Math.round(timings[Math.ceil(timings.length * 0.95) - 1]),
      maxMs: Math.round(timings.at(-1)),
    })
  }

  // Real isolated Redis process pause; the business Redis is never signalled.
  await delay(1100)
  redis.kill('SIGSTOP')
  redisStopped = true
  const began = performance.now(),
    unavailable = await request('/health/ready', { user: null })
  assert.equal(unavailable.status, 503)
  assert.ok(performance.now() - began < 4000)
  assert.equal((await request('/health/live', { user: null })).status, 200)
  redis.kill('SIGCONT')
  redisStopped = false
  await delay(1100)
  assert.equal((await request('/health/ready', { user: null })).status, 200)
  evidence.redisPause = { readiness: 503, live: 200, recovery: 200, paidRetries: 0 }
  await delay(1100)
  for (let i = 0; i < 10; i++) held.push(await pool.connect())
  const dbBegan = performance.now()
  assert.equal((await request('/health/ready', { user: null })).status, 503)
  assert.ok(performance.now() - dbBegan < 4000)
  for (const client of held.splice(0)) client.release()
  await delay(1100)
  assert.equal((await request('/health/ready', { user: null })).status, 200)
  evidence.postgresPoolExhaustion = { readiness: 503, recovery: 200, paidRetries: 0 }
  const rate = []
  for (let i = 0; i < 125; i++) rate.push((await request('/api/me', { user: bob })).status)
  assert.ok(rate.includes(429))
  assert.ok(rate.includes(200))
  evidence.rateLimit = {
    allowed: rate.filter((s) => s === 200).length,
    blocked: rate.filter((s) => s === 429).length,
  }
  assert.equal((await seed.query('SELECT count(*)::int n FROM model_requests')).rows[0].n, 0)
  assert.equal((await seed.query('SELECT count(*)::int n FROM task_jobs')).rows[0].n, 0)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  if (redisStopped) redis.kill('SIGCONT')
  for (const client of held.splice(0)) client.release()
  await app?.close()
  if (media) await new Promise((ok) => media.close(ok))
  if (cache?.isOpen) await cache.quit()
  if (redis?.pid && redis.exitCode === null) {
    const exited = new Promise((ok) => redis.once('exit', ok))
    redis.kill('SIGTERM')
    await exited
  }
  await pool?.end()
  await seed?.end()
  if (created) await admin.query(`DROP DATABASE "${name}"`)
  await admin.end()
  await rm(dir, { recursive: true, force: true })
  console.log('Temporary database, Redis and files removed; business data preserved')
}
