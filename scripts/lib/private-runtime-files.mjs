import { readFile, mkdir, writeFile, rename, unlink, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export async function privateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
    await chmod(path, 0o600)
  } finally { await unlink(tmp).catch(() => {}) }
}
export async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e }
}
// One host allocator at a time, including across application restarts. Never steal a live lock.
export async function hostLock(path, fn) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  for (let n = 0; n < 2; n++) {
    try { await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      const owner = await readJson(path)
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 2) return false
      try { process.kill(owner.pid, 0); return false }
      catch (err) { if (err.code !== 'ESRCH') return false }
      await unlink(path).catch(() => {})
      if (n === 1) return false
    }
  }
  try { await fn(); return true }
  finally { if ((await readJson(path))?.token === token) await unlink(path) }
}
