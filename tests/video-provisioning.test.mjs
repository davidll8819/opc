import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, mkdir, copyFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createVideoProvisioning, publicProvisioning } from '../apps/api/src/operations/provisioning.mjs'
import { privateJson, readJson } from '../scripts/lib/private-runtime-files.mjs'
import { allocatePorts, makeRuntimeEntry, runtimeYaml } from '../scripts/lib/native-video-provisioner.mjs'
import { parse } from 'yaml'
import { operationsLaunch } from '../scripts/run-operations-service.mjs'
import { setup } from './helpers/archive-api-fixture.mjs'

async function fixture(adapter) {
  const root = await mkdtemp(join(tmpdir(), 'office-video-provision-'))
  const env = { OPERATIONS_RUNTIMES_FILE: join(root, 'registry.json') }
  await privateJson(env.OPERATIONS_RUNTIMES_FILE, {})
  const args = { root, pool: { query: async () => ({ rows: [{ id: 'exists' }] }) }, config: { enabled: true }, adapter }
  const service = await createVideoProvisioning(env, args)
  return { root, env, args, service, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }) } }
}
test('durable queue: duplicate requests allocate once; restart resumes without reallocation', async () => {
  let count = 0
  const h = await fixture({ ensure: async (_id, { progress }) => { count++; await progress('checking') } })
  try {
    const id = randomUUID()
    await Promise.all([h.service.enqueue(id), h.service.enqueue(id), h.service.enqueue(id)])
    assert.equal((await h.service.status(id)).state, 'queued')
    const restarted = await createVideoProvisioning(h.env, h.args)
    await restarted.runOnce()
    assert.equal(count, 1); assert.equal((await restarted.status(id)).state, 'ready')
    await restarted.enqueue(id, { retry: true }); await restarted.runOnce()
    assert.equal(count, 1)
    const info = await stat(join(h.root, '.local/video-provisioning', id + '.json'))
    assert.equal(info.mode & 0o777, 0o600)
    await restarted.close()
  } finally { await h.close() }
})
test('failed provision is safe, retryable and never exposes infrastructure credentials', async () => {
  let attempts = 0
  const h = await fixture({ ensure: async () => { if (++attempts === 1) throw Error('password=synthetic-do-not-output') } })
  try {
    const id = randomUUID(); await h.service.enqueue(id); await h.service.runOnce()
    const failed = await h.service.status(id)
    assert.equal(failed.state, 'failed'); assert.equal(failed.canRetry, true)
    assert.ok(!JSON.stringify(failed).includes('synthetic-do-not-output'))
    await h.service.enqueue(id, { retry: true }); await h.service.runOnce()
    assert.equal(attempts, 2); assert.equal((await h.service.status(id)).state, 'ready')
  } finally { await h.close() }
})
test('concurrent workers cannot allocate the same workspace twice', async () => {
  let count = 0, release
  const gate = new Promise(r => { release = r })
  const h = await fixture({ ensure: async () => { count++; await gate } })
  try {
    const id = randomUUID(); await h.service.enqueue(id)
    const first = h.service.runOnce()
    while (!count) await new Promise(r => setTimeout(r, 5))
    const another = await createVideoProvisioning(h.env, h.args)
    await another.runOnce(); assert.equal(count, 1)
    release(); await first; await another.close()
  } finally { release(); await h.close() }
})
test('manual runtime bindings and disabled hosts are not mutated', async () => {
  const h = await fixture({ ensure: async () => assert.fail('manual binding must not be provisioned') })
  try {
    const id = randomUUID(), original = { [id]: { serverUrl: 'http://127.0.0.1:3002', marker: 'unchanged' } }
    await privateJson(h.env.OPERATIONS_RUNTIMES_FILE, original)
    assert.equal((await h.service.enqueue(id)).state, 'ready'); await h.service.runOnce()
    assert.deepEqual(await readJson(h.env.OPERATIONS_RUNTIMES_FILE), original)
    const disabled = await createVideoProvisioning({}, { root: h.root })
    assert.equal((await disabled.enqueue(randomUUID())).state, 'disabled'); await disabled.close()
    assert.deepEqual(Object.keys(publicProvisioning({ state: 'ready', jwtSecret: 'never-return' }, true)).sort(), ['canRetry', 'message', 'stage', 'state', 'updatedAt'])
  } finally { await h.close() }
})
test('separate ports, keys, Mongo scopes, storage and agent working directories per workspace', async () => {
  const options = { mongoAddress: 'mongodb://127.0.0.1:27018/?directConnection=true', officeOrigin: 'http://localhost:3000' }
  const a = randomUUID(), b = randomUUID()
  const ports = await allocatePorts({}, { start: 21000, end: 21020 }, async p => p !== 21001)
  const first = makeRuntimeEntry(a, ports, options)
  const second = makeRuntimeEntry(b, await allocatePorts({ [a]: first }, { start: 21000, end: 21020 }, async () => true), options)
  for (const field of ['serverUrl', 'aiUrl', 'routerPort', 'jwtSecret', 'bridgeSecret', 'internalToken', 'userId']) assert.notEqual(first[field], second[field])
  for (const field of ['uri', 'dbName']) assert.notEqual(first.infrastructure.mongodb[field], second.infrastructure.mongodb[field])
  assert.notEqual(first.infrastructure.assets.endpoint, second.infrastructure.assets.endpoint)
  assert.notEqual(first.infrastructure.assets.secretAccessKey, second.infrastructure.assets.secretAccessKey)
  const launch = operationsLaunch('/tmp/office-root', a, 'ai', first, {})
  assert.ok(launch.cwd.endsWith(`${a}/work/ai`))
  assert.ok(launch.args[0].endsWith('aitoearn-backend/dist/apps/aitoearn-ai/src/main.js'))
  assert.ok(launch.env.OFFICE_SECURE_LOG_DIR.includes(a))
  await assert.rejects(allocatePorts({}, { start: 21000, end: 21005 }, async () => false), /provisioning failed/)
})
test('workspace creation queues automatically; retry requires owner/admin and no user-selected URLs', async () => {
  const calls = []
  const h = await setup(undefined, { videoProvisioning: {
    start() {}, async close() {}, status: async () => ({ state: 'failed', canRetry: true }),
    enqueue: async (id, options) => { calls.push({ id, options }); return { state: 'queued' } },
  } })
  try {
    const created = await h.request('POST', '/api/tenants', { name: 'Automatic video test' })
    assert.equal(created.statusCode, 201); assert.equal(created.json().videoRuntime.state, 'queued')
    assert.equal(calls[0].id, created.json().id)
    assert.equal((await h.request('GET', '/operations/provisioning')).statusCode, 200)
    assert.equal((await h.request('POST', '/operations/provisioning/retry', {}, h.bob)).statusCode, 403)
    assert.equal((await h.request('POST', '/operations/provisioning/retry', { serverUrl: 'http://untrusted' })).statusCode, 400)
    assert.equal((await h.request('POST', `/api/tenants/${randomUUID()}/operations/provisioning/retry`, {})).statusCode, 403)
    assert.equal((await h.request('POST', '/operations/provisioning/retry', {})).statusCode, 200)
    assert.equal(calls.length, 2)
  } finally { await h.close() }
})

test('new runtime bootstrap config is valid before model setup and contains no user/provider Key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-video-yaml-')), id = randomUUID()
  try {
    const entry = makeRuntimeEntry(id, { server: 21000, ai: 21001, redis: 21002, storage: 21003, router: 21004 }, { mongoAddress: 'mongodb://127.0.0.1:27018', officeOrigin: 'http://localhost:3000' })
    await mkdir(join(root, '.local/operations', id), { recursive: true })
    for (const service of ['server', 'ai']) {
      const relative = `integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-${service}/config`
      await mkdir(join(root, relative), { recursive: true })
      await copyFile(join(relative, 'config.yaml.example'), join(root, relative, 'config.yaml.example'))
    }
    await runtimeYaml(root, id, entry)
    for (const service of ['server', 'ai']) {
      const path = join(root, '.local/operations', id, `${service}.yaml`), config = parse(await readFile(path, 'utf8'))
      assert.ok(config.officeBridge.revision > 0)
      assert.equal(config.officeBridge.tenantId, id)
      assert.equal(config.officeBridge.secret, '${OFFICE_BRIDGE_SECRET}')
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      if (service === 'ai') {
        assert.equal(config.agent.routerPort, 21004)
        assert.equal(config.agent.apiKey, '${OFFICE_MODEL_GATEWAY_TOKEN}')
        assert.equal(config.ai.fouryi.apiKey, '${OFFICE_MODEL_GATEWAY_TOKEN}')
        assert.ok(config.ai.fouryi.baseUrl.endsWith(id))
      }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('interrupted provisioning is resumed; deleted workspace is never allocated', async () => {
  let count = 0
  const h = await fixture({ ensure: async () => { count++ } })
  try {
    const id = randomUUID()
    await h.service.enqueue(id)
    await privateJson(join(h.root, '.local/video-provisioning', id + '.json'), { tenantId: id, state: 'provisioning', stage: 'starting' })
    await h.service.runOnce(); assert.equal(count, 1); assert.equal((await h.service.status(id)).state, 'ready')
    const deleted = randomUUID(); await h.service.enqueue(deleted)
    h.args.pool.query = async () => ({ rows: [] })
    await h.service.runOnce(); assert.equal(count, 1); assert.equal((await h.service.status(deleted)).state, 'failed')
  } finally { await h.close() }
})

test('a disconnected ready environment is shown as failed and can be recovered without reallocating', async () => {
  let connected = true, starts = 0
  const h = await fixture({ health: async () => { if (!connected) throw Error('offline') }, ensure: async () => { starts++; connected = true } })
  try {
    const id = randomUUID(); await h.service.enqueue(id); await h.service.runOnce()
    connected = false
    assert.equal((await h.service.status(id)).state, 'failed')
    assert.equal((await h.service.status(id)).canRetry, true)
    assert.equal((await h.service.enqueue(id, { retry: true })).state, 'queued')
    await h.service.runOnce(); assert.equal(starts, 2); assert.equal((await h.service.status(id)).state, 'ready')
  } finally { await h.close() }
})
