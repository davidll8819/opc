import { setTimeout as delay } from 'node:timers/promises'
import { readFile, writeFile, mkdir, unlink, open, chmod, rename, stat } from 'node:fs/promises'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { matchingProcess } from './operations-mac.mjs'
const execute = promisify(execFile)
const pidPath = resolve('.local/watchdog.pid'), enabledPath = resolve('.local/watchdog.enabled')
export function recoveryDecision({ failures, lastAttempt, now, attempts }) {
  return failures >= 2 && now - lastAttempt >= 60000 && attempts.filter(t => now-t < 3600000).length < 5
}
async function main() {
  const action = process.argv[2] || 'status', script = resolve('scripts/service-watchdog.mjs')
  const pid = Number(await readFile(pidPath, 'utf8').catch(() => 0))
  const running = await matchingProcess(pid, process.execPath, [script, 'run'])
  if (action === 'stop') {
    await unlink(enabledPath).catch(() => {})
    if (running) {
      process.kill(pid, 'SIGTERM')
      for (let i=0;i<50;i++) { if (!(await matchingProcess(pid, process.execPath, [script, 'run']))) break; await delay(100) }
      if (await matchingProcess(pid, process.execPath, [script, 'run'])) throw Error('Recovery service is still stopping')
    }
    await unlink(pidPath).catch(() => {})
    console.log('Service recovery disabled'); return
  }
  if (action === 'status') { console.log(running ? 'Service recovery running' : 'Service recovery stopped'); return }
  await mkdir('.local', { recursive: true })
  if (action === 'start') {
    await writeFile(enabledPath, 'enabled\n', { mode: 0o600 })
    if (running) { console.log('Service recovery already running'); return }
    const log = await open('.local/watchdog.log', 'a', 0o600)
    try {
      const child = spawn(process.execPath, [script, 'run'], { detached: true, cwd: process.cwd(), stdio: ['ignore', log.fd, log.fd] })
      await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) })
      await writeFile(pidPath, String(child.pid), { mode: 0o600 }); child.unref()
    } finally { await log.close() }
    console.log('Service recovery enabled; paid generations are never retried'); return
  }
  if (action !== 'run') throw Error('Unknown watchdog action')
  const controller = new AbortController()
  process.once('SIGTERM', () => controller.abort())
  let failures = 0, lastAttempt = 0, attempts = []
  while (!controller.signal.aborted && await readFile(enabledPath, 'utf8').then(() => true, () => false)) {
    let healthy = false
    try {
      const response = await fetch('http://127.0.0.1:3000/health/ready', { signal: AbortSignal.timeout(5000) })
      await response.body?.cancel()
      await execute(process.execPath, ['scripts/operations-mac.mjs', 'status'], { timeout: 15000, signal: controller.signal })
      healthy = response.ok
    } catch { /* No raw service errors or credentials in watchdog logs. */ }
    failures = healthy ? 0 : failures + 1
    const now = Date.now()
    if (recoveryDecision({ failures, lastAttempt, now, attempts })) {
      lastAttempt = now; attempts = attempts.filter(t => now-t < 3600000); attempts.push(now)
      // Each lifecycle command only starts absent processes. Never kill a live service or retry a paid task.
      for (const args of [['scripts/native-services.mjs', 'start'], ['scripts/local-process.mjs', 'start'], ['scripts/operations-mac.mjs', 'recover']]) {
        if (!(await readFile(enabledPath, 'utf8').then(() => true, () => false))) return
        try { await execute(process.execPath, args, { timeout: 60000, signal: controller.signal, maxBuffer: 1024 * 1024 }); }
        catch { /* Leave data intact and retry with the bounded backoff. */ }
      }
      const path = '.local/watchdog-events.log'
      if ((await stat(path).catch(() => ({ size: 0 }))).size > 256 * 1024) await rename(path, path + '.1')
      const log = await open(path, 'a', 0o600)
      await log.write(`${new Date().toISOString()} checked absent services; recovery attempt ${attempts.length}/5 this hour\n`)
      await log.close(); await chmod(path, 0o600)
    }
    await delay(30000, undefined, {signal:controller.signal}).catch(()=>{})
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => { console.error('Service recovery stopped; inspect service status'); process.exitCode = 1 })
