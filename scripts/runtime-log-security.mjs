import { appendFileSync, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Drop the entire sensitive record, including quoted/escaped request configs.
export function safeLogLine(line, secrets = []) {
  if (/authorization|bearer\s|\bJWT\b|api[_ -]?key|password|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|["']?(?:config|headers|request|req|body)["']?\s*[:=]|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]{12,}/i.test(line)
    || secrets.some(value => value.length >= 8 && line.includes(value))) return '[已脱敏：敏感日志记录]'
  return line
}
export function secureTree(path) {
  if (!existsSync(path)) return
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error('Private log/config path must not be a symlink')
  chmodSync(path, info.isDirectory() ? 0o700 : 0o600)
  if (info.isDirectory()) for (const name of readdirSync(path)) secureTree(join(path, name))
}
export function privateLogWriter(directory, { service, secrets = [], maxBytes = 5 * 1024 * 1024, retentionDays = 14, clock = () => new Date() }) {
  if (!/^[a-z-]+$/.test(service)) throw new Error('Invalid log service')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  secureTree(directory)
  let fd, size = 0, day, lastSweep, pending = '', dropping = false
  const filePattern = /^[a-z-]+-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]+\.log$/
  function record(line) {
    const now = clock(), today = now.toISOString().slice(0, 10)
    const text = safeLogLine(line, secrets) + '\n'
    if (fd === undefined || day !== today || size + Buffer.byteLength(text) > maxBytes) {
      if (fd !== undefined) closeSync(fd)
      day = today; size = 0
      const name = `${service}-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`
      fd = openSync(join(directory, name), 'wx', 0o600)
    }
    if (lastSweep !== today) {
      lastSweep = today
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), info = lstatSync(path)
        if (filePattern.test(name) && info.isFile() && now.getTime() - info.mtimeMs > retentionDays * 86400000) unlinkSync(path)
      }
    }
    appendFileSync(fd, text); size += Buffer.byteLength(text)
  }
  return {
    write(chunk) {
      for (const char of String(chunk)) {
        if (char === '\n') { record(dropping ? '[已省略：超长日志记录]' : pending); pending = ''; dropping = false }
        else if (!dropping) { pending += char; if (pending.length > 65536) { pending = ''; dropping = true } }
      }
    },
    close() {
      if (pending || dropping) record(dropping ? '[已省略：超长日志记录]' : pending)
      pending = ''; dropping = false
      if (fd !== undefined) closeSync(fd)
      fd = undefined
    },
  }
}
