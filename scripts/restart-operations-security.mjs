// Restart only idle application services after authentication/logging changes.
// Does not regenerate model YAML, change bindings, or restart data stores.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MongoClient } from 'mongodb'
import { operationsLaunch } from './run-operations-service.mjs'
import { createOperationsDriver } from '../apps/api/src/operations/driver.mjs'
import { matchingProcess } from './operations-mac.mjs'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  process.loadEnvFile('.env')
  const registry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
  const tenant = Object.keys(registry).find(id => registry[id].nativeMac), entry = registry[tenant]
  if (!entry) throw new Error('Native runtime not configured')
  const client = new MongoClient(entry.infrastructure.mongodb.uri)
  await client.connect()
  try {
    const db = client.db(entry.infrastructure.mongodb.dbName)
    const active = await db.collection('contentGenerationTask').countDocuments({ status: 'running', deletedAt: null })
      + await db.collection('aiLogs').countDocuments({ status: 'generating' })
    if (active) throw new Error('Active tasks exist; retry after they finish')
  } finally { await client.close() }
  const root = resolve('.')
  // Nx cleans dist/node_modules during a rebuild. Restore local workspace links
  // before stopping any process so compiled @yikart imports remain resolvable.
  await promisify(execFile)(process.execPath,['scripts/link-operations-build.mjs'],{cwd:root})
  for (const service of ['ai', 'server']) {
    const launch = operationsLaunch(root, tenant, service, entry)
    const pidFile = resolve('.local/production-runtime', service + '.pid')
    const pid = Number(await readFile(pidFile, 'utf8'))
    if (!(await matchingProcess(pid, process.execPath, launch.args))) throw new Error('Unexpected runtime process; refusing to stop')
    process.kill(pid, 'SIGTERM')
    for (let n = 0; n < 100 && await matchingProcess(pid, process.execPath, launch.args); n++) await wait(100)
    if (await matchingProcess(pid, process.execPath, launch.args)) throw new Error('Runtime did not stop')
    const child = spawn(process.execPath, launch.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: 'ignore' })
    await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) })
    await writeFile(pidFile, String(child.pid), { mode: 0o600 }); child.unref()
    console.log(service + ': restarted with protected logging; model configuration unchanged')
  }
  const driver = createOperationsDriver(process.env)
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await driver.ready(tenant); console.log('Runtime ready'); return }
    catch { await wait(1000) }
  }
  throw new Error('Restarted services did not become ready')
}
main().catch(() => { console.error('Restart failed; inspect protected logs. No credentials printed.'); process.exitCode = 1 })
