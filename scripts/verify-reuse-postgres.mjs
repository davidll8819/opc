// Uses a fresh, uniquely named database; never writes application business databases.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { settings, pgClient, pgEnvironment } from './backup/common.mjs'
import { migrate } from '../database/migrate.mjs'
import { buildApp } from '../apps/api/src/app.mjs'
import { hash } from '../apps/api/src/auth.mjs'
import { emptyBrief } from '../packages/secretary/task-brief.mjs'
await settings()
const admin = await pgClient(),
  name = `reuse_test_${randomUUID().replaceAll('-', '')}`
let pool,
  app,
  created = false
try {
  await admin.query(`CREATE DATABASE "${name}"`)
  created = true
  const env = pgEnvironment(name)
  pool = new pg.Pool({
    host: env.PGHOST,
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: name,
    max: 10,
  })
  await migrate(pool)
  const tenant = randomUUID(),
    alice = randomUUID(),
    bob = randomUUID(),
    other = randomUUID(),
    sessions = new Map()
  for (const id of [alice, bob]) {
    await pool.query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      id,
      id,
      id + '@test.invalid',
    ])
    sessions.set(
      `session:${hash(id)}`,
      JSON.stringify({ userId: id, email: 'reuse-test@example.invalid', csrf: id }),
    )
  }
  await pool.query(
    "INSERT INTO tenants(id,name) VALUES($1,'Temporary knowledge verification'),($2,'Other temporary tenant')",
    [tenant, other],
  )
  for (const id of [alice, bob])
    await pool.query("INSERT INTO memberships VALUES($1,$2,'owner')", [tenant, id])
  const cache = {
    get: async (k) => sessions.get(k) || null,
    set: async (k, v) => {
      sessions.set(k, v)
      return 'OK'
    },
    del: async (k) => Number(sessions.delete(k)),
    eval: async () => 1,
  }
  app = await buildApp({
    pool,
    cache,
    agents: { models: [], rates: {} },
    staticRoot: null,
    env: { NODE_ENV: 'test', APP_ORIGIN: 'https://reuse.test', LOG_LEVEL: 'silent' },
    modelFetch: async () => {
      throw Error('Paid model access is forbidden in this test')
    },
  })
  const request = (method, path, payload, user = alice) =>
    app.inject({
      method,
      url: `/api/tenants/${tenant}/reuse${path}`,
      payload,
      headers: {
        cookie: `office_session=${user}`,
        origin: 'https://reuse.test',
        'x-csrf-token': user,
      },
    })
  const data = {
    kind: 'template',
    title: 'Concurrency verification',
    project: '',
    enabled: true,
    body: {
      brief: { ...emptyBrief, goal: '{{目标}}' },
      steps: [{ title: '整理资料', dept: 'file-agent', brief: '{{目标}}', dependsOn: [] }],
    },
  }
  const saved = await request('POST', '', data)
  assert.equal(saved.statusCode, 200, saved.body)
  const id = saved.json().id,
    payload = {
      version: 1,
      values: { 目标: '隔离验证' },
      requestId: randomUUID(),
      due: '2026-10-25',
    }
  const results = await Promise.all(
    Array.from({ length: 8 }, () => request('POST', `/${id}/draft`, payload)),
  )
  for (const result of results) assert.equal(result.statusCode, 200, result.body)
  assert.equal(new Set(results.map((r) => r.json().batchId)).size, 1)
  assert.equal(
    (
      await pool.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        tenant,
        alice,
      ])
    ).rows[0].board.tasks.length,
    1,
  )
  const updates = await Promise.all([
    request('PUT', `/${id}`, { ...data, title: 'revision A', expectedVersion: 1 }),
    request('PUT', `/${id}`, { ...data, title: 'revision B', expectedVersion: 1 }),
  ])
  assert.deepEqual(updates.map((r) => r.statusCode).sort(), [200, 409])
  assert.equal((await request('GET', '', undefined, bob)).json().items.length, 0)
  await pool.query('GRANT USAGE ON SCHEMA public TO office_app')
  await pool.query('GRANT SELECT ON reuse_entries,reuse_versions,reuse_runs TO office_app')
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    await db.query('SET LOCAL ROLE office_app')
    for (const [t, u, expected] of [
      [tenant, bob, 0],
      [other, alice, 0],
      [tenant, alice, 1],
    ]) {
      await db.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [t, u],
      )
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM reuse_entries')).rows[0].n,
        expected,
      )
      assert.equal((await db.query('SELECT count(*)::int n FROM reuse_runs')).rows[0].n, expected)
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM reuse_versions')).rows[0].n,
        expected * 2,
      )
    }
    await db.query('ROLLBACK')
  } finally {
    db.release()
  }
  console.log(
    JSON.stringify({
      temporaryPostgres: true,
      parallelSubmissions: 8,
      draftsCreated: 1,
      concurrentVersionUpdates: [200, 409],
      privateApi: true,
      userAndTenantRLS: true,
      paidModelCalls: 0,
    }),
  )
} finally {
  await app?.close()
  await pool?.end()
  if (created) await admin.query(`DROP DATABASE "${name}"`)
  await admin.end()
  console.log('Temporary database removed; existing databases preserved')
}
