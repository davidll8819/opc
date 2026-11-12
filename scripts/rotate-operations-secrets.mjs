// Operator-only rotation. Never prints credential values or child error bodies.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MongoClient } from 'mongodb'
import { SignJWT } from 'jose'
import { gatewayToken } from '../apps/api/src/operations/policy.mjs'
import { signBridge } from '../apps/api/src/operations/security.mjs'
import { createOperationsDriver } from '../apps/api/src/operations/driver.mjs'
import { matchingProcess } from './operations-mac.mjs'
const run = promisify(execFile)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function checkOld(entry, tenant) {
  const gateway = await fetch(`${entry.officeOrigin}/integrations/model-gateway/${tenant}/api/v1/models`, { headers: { authorization: `Bearer ${gatewayToken(entry.bridgeSecret, tenant)}` }, signal: AbortSignal.timeout(10000) })
  await gateway.body?.cancel()
  if (gateway.status !== 403) throw new Error('Old gateway credential was not rejected')
  console.log('Old model gateway credential: HTTP 403, revoked')
  const token = await new SignJWT({ id: entry.userId, officeTenantId: tenant }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(entry.jwtSecret))
  for (const [url, path] of [[entry.aiUrl, '/agent/tasks?pageNo=1&pageSize=1'], [entry.serverUrl, '/user/mine']]) {
    const response = await fetch(url + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
    const body = await response.json().catch(() => null)
    if (![401, 403].includes(response.status) && ![401,403,10001].includes(body?.code)) throw new Error('Old signed credential rejection not confirmed')
    console.log(`Old signed credential: HTTP ${response.status}, rejected`)
    const signed = await fetch(url + '/office-bridge/status', { headers: signBridge(entry.bridgeSecret, 'GET', '/office-bridge/status', null) })
    await signed.body?.cancel()
    if (signed.status !== 403) throw new Error('Old bridge signature was not rejected')
    console.log('Old bridge signature: HTTP 403, revoked')
  }
}
async function main() {
  process.umask(0o077); process.loadEnvFile('.env')
  const registryPath = resolve(process.env.OPERATIONS_RUNTIMES_FILE)
  const source = await readFile(registryPath, 'utf8'), registry = JSON.parse(source)
  const tenant = Object.keys(registry).find(id => registry[id].nativeMac), old = registry[tenant]
  if (!old) throw new Error('Native runtime required')
  const client = new MongoClient(old.infrastructure.mongodb.uri)
  await client.connect()
  try {
    const db = client.db(old.infrastructure.mongodb.dbName)
    const active = await db.collection('contentGenerationTask').countDocuments({ status: 'running', deletedAt: null }) + await db.collection('aiLogs').countDocuments({ status: 'generating' })
    if (active) throw new Error('Wait for active tasks to finish')
  } finally { await client.close() }
  const mainPid = Number(await readFile('.local/server.pid', 'utf8'))
  if (!(await matchingProcess(mainPid, process.execPath, ['apps/api/src/server.mjs']))) throw new Error('Unexpected main process')
  const updated = structuredClone(registry)
  updated[tenant].bridgeSecret = randomBytes(48).toString('base64url')
  updated[tenant].jwtSecret = randomBytes(48).toString('base64url')
  const backupDir = join(homedir(), 'Wishtaday-Backup-Keys', 'rotation-' + new Date().toISOString().replace(/[:.]/g, '-'))
  await mkdir(backupDir, { recursive: true, mode: 0o700 }); await chmod(backupDir, 0o700)
  await writeFile(join(backupDir, 'prior-runtime-registry.json'), source, { mode: 0o600 })
  // Pause acceptance in memory; restart clears this maintenance flag.
  const driver = createOperationsDriver(process.env)
  const bound = await driver.binding(tenant)
  await driver.request(bound, 'ai', '/office-bridge/drain', { method: 'POST', signed: true, body: { draining: true } })
  const temporary = registryPath + '.rotation-' + randomUUID()
  await writeFile(temporary, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, registryPath); await chmod(registryPath, 0o600)
  console.log('bridgeSecret and jwtSecret: rotated; other registry fields unchanged')
  // Child output is withheld so a failed restart cannot spill its environment.
  await run(process.execPath, ['scripts/local-process.mjs', 'stop'])
  await run(process.execPath, ['scripts/local-process.mjs', 'start'])
  await run(process.execPath, ['scripts/restart-operations-security.mjs'], { timeout: 90000 })
  await createOperationsDriver(process.env).ready(tenant)
  await checkOld(old, tenant)
  const current = await createOperationsDriver(process.env).binding(tenant)
  for (const [service, path] of [['ai','/agent/tasks?pageNo=1&pageSize=1'],['server','/user/mine']]) {
    await createOperationsDriver(process.env).request(current, service, path)
    console.log(service + ': current signed credential accepted')
  }
  console.log('Main, video server and AI bridge: READY; no model settings or tasks changed')
}
main().catch(() => { console.error('Rotation/verification stopped; credential values withheld. New credentials are not automatically reverted; inspect protected configuration and service readiness.'); process.exitCode = 1 })
