// Native local integration check: creates and drops only its own temporary PostgreSQL database.
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { settings, pgClient, pgEnvironment, quote } from './backup/common.mjs'
import { migrate } from '../database/migrate.mjs'
import { transaction } from '../apps/api/src/db.mjs'
import {
  createVideoEditor,
  saveEdit,
  readEdit,
} from '../apps/api/src/operations/video-edit-service.mjs'
const require = createRequire(import.meta.url),
  { Pool } = require('pg')
await settings()
const name = 'wishtaday_edit_test_' + randomUUID().replaceAll('-', ''),
  admin = await pgClient()
let pool, first, second
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await admin.query('CREATE DATABASE ' + quote(name))
  const e = pgEnvironment(name)
  pool = new Pool({
    host: e.PGHOST,
    port: Number(e.PGPORT),
    user: e.PGUSER,
    password: e.PGPASSWORD,
    database: name,
  })
  await migrate(pool)
  const ctx = { tenantId: randomUUID(), userId: randomUUID() },
    taskId = 'a'.repeat(24)
  await pool.query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
    ctx.userId,
    ctx.userId,
    'synthetic@test.invalid',
  ])
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    ctx.tenantId,
    'isolated edit test',
  ])
  await pool.query(
    "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'test','submitted',$4)",
    [randomUUID(), ctx.tenantId, ctx.userId, taskId],
  )
  const input = {
    requestId: randomUUID(),
    title: 'restart test',
    segments: [{ url: 'http://127.0.0.1:19000/bucket/test.mp4', start: 0, end: 1 }],
    ratio: '9:16',
    resolution: '720p',
  }
  await transaction(pool, (db) => saveEdit(db, ctx, taskId, input), ctx)
  let count = 0,
    started
  const begin = new Promise((r) => (started = r))
  const driver = { binding: async () => ({}), request: async () => ({}) }
  first = createVideoEditor({
    pool,
    driver,
    env: {},
    render: async ({ signal }) => {
      count++
      started()
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }),
      )
    },
    store: async () => {
      throw Error('must not store interrupted work')
    },
  })
  first.kick(ctx, input.requestId)
  await begin
  second = createVideoEditor({
    pool,
    driver,
    env: {},
    render: async () => {
      count++
      throw Error('must not render concurrently')
    },
    store: async () => ({}),
  })
  second.kick(ctx, input.requestId)
  await sleep(100)
  await second.close()
  assert.equal(count, 1)
  await first.close()
  let row = await transaction(pool, (db) => readEdit(db, ctx, input.requestId), ctx)
  assert.equal(row.state, 'queued')
  let resumes = 0
  second = createVideoEditor({
    pool,
    driver,
    env: {},
    render: async () => {
      resumes++
      return { width: 720, height: 1280, duration: 1, bytes: 10 }
    },
    store: async (_e, _r, result) => ({ ...result, key: 'synthetic-result' }),
  })
  second.kick(ctx, input.requestId)
  second.kick(ctx, input.requestId)
  for (let i = 0; i < 100; i++) {
    row = await transaction(pool, (db) => readEdit(db, ctx, input.requestId), ctx)
    if (row.state === 'completed') break
    await sleep(30)
  }
  assert.equal(row.state, 'completed')
  assert.equal(resumes, 1)
  await second.close()
  const persisted = await transaction(pool, (db) => readEdit(db, ctx, input.requestId), ctx)
  assert.equal(persisted.result.width, 720)
  console.log(
    'PASS isolated PostgreSQL: concurrent worker exclusion; interruption returns to queue; restart resumes same ID once; completed result persists',
  )
} catch (error) {
  console.error('Isolated test error:', error.name, error.code || '')
  process.exitCode = 1
} finally {
  await first?.close()
  await second?.close()
  await pool?.end()
  await admin.query('DROP DATABASE IF EXISTS ' + quote(name))
  await admin.end()
}
