// Detached supervisor captures bootstrap errors too (before Nest/runtime logging starts).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { operationsLaunch } from './run-operations-service.mjs'
import { privateLogWriter } from './runtime-log-security.mjs'
process.umask(0o077)
try {
  const id = z.string().uuid().parse(process.argv[2]), service = z.enum(['server', 'ai']).parse(process.argv[3])
  const entry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE, 'utf8'))[id]
  if (!entry?.managedProvisioning) throw Error('Managed runtime required')
  const root = process.cwd(), launch = operationsLaunch(root, id, service, entry)
  const secrets = []
  function collect(value) {
    for (const [key, item] of Object.entries(value)) {
      if (item && typeof item === 'object') collect(item)
      else if (typeof item === 'string' && /secret|token|password|uri|key/i.test(key)) secrets.push(item)
    }
  }
  collect(entry); collect(launch.env)
  const writer = privateLogWriter(resolve(root, '.local/operations', id, 'logs/secure'), { service: `${service}-bootstrap`, secrets })
  const child = spawn(process.execPath, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', data => writer.write(data)) }
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
  child.on('error', () => { writer.write('Service process could not start\n'); writer.close(); process.exitCode = 1 })
  child.on('close', code => { writer.close(); process.exitCode = code ?? 1 })
} catch { process.exitCode = 1 }
