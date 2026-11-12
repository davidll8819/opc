import { mkdir, chmod, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises'
import { resolve, join, relative, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
export const run = promisify(execFile)
export const root = resolve(import.meta.dirname, '../..')
export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const quote = name => '"' + name.replaceAll('"', '""') + '"'
export async function privateDir(path) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700) }
export async function privateFile(path, data) { await privateDir(dirname(path)); await writeFile(path, data, { mode: 0o600 }); await chmod(path, 0o600) }
export function inside(parent, child) { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)) }
export async function outsideProject(path) {
  const target = resolve(path)
  if (inside(root, target)) throw new Error('Backup must be outside the project')
  await privateDir(target)
  const actual = await realpath(target)
  if (inside(await realpath(root), actual)) throw new Error('Backup must be outside the project')
  return actual
}
export async function settings() {
  process.loadEnvFile(join(root, '.env'))
  const registry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
  const entries = Object.entries(registry).filter(([, e]) => e.nativeMac)
  if (entries.length !== 1) throw new Error('Exactly one native tenant is required for this backup tool')
  const [tenant, entry] = entries[0]
  const credentials = JSON.parse(await readFile(join(root, '.local/production-runtime/credentials.json'), 'utf8'))
  return { tenant, entry, credentials }
}
export function pgEnvironment(database) {
  const env = { ...process.env }
  if (env.DATABASE_URL) {
    const url = new URL(env.DATABASE_URL)
    env.PGHOST = url.hostname; env.PGPORT = url.port || '5432'; env.PGUSER = decodeURIComponent(url.username); env.PGPASSWORD = decodeURIComponent(url.password); env.PGDATABASE = decodeURIComponent(url.pathname.slice(1))
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST)) throw new Error('Native backup is restricted to local PostgreSQL')
  if (!env.LOCAL_DB_PASSWORD) throw new Error('Native database administrator credential is required')
  env.PGUSER = 'office_admin'; env.PGPASSWORD = env.LOCAL_DB_PASSWORD
  if (database) env.PGDATABASE = database
  return env
}
export async function pgClient(database) {
  const env = pgEnvironment(database)
  const client = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT || 5432), user: env.PGUSER, password: env.PGPASSWORD, database: env.PGDATABASE })
  await client.connect(); return client
}
export async function tableCounts(client) {
  const { rows } = await client.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname,tablename")
  const counts = {}
  for (const row of rows) counts[row.schemaname + '.' + row.tablename] = (await client.query(`SELECT count(*)::text AS n FROM ${quote(row.schemaname)}.${quote(row.tablename)}`)).rows[0].n
  return counts
}
export async function copyTree(source, target, omit = () => false, prefix = '') {
  const info = await lstat(source)
  if (info.isSymbolicLink()) throw new Error('Symlinks are not copied into backups')
  if (info.isDirectory()) {
    await privateDir(target)
    for (const name of await readdir(source)) {
      const namePath = prefix ? prefix + '/' + name : name
      if (!omit(namePath)) await copyTree(join(source, name), join(target, name), omit, namePath)
    }
  } else if (info.isFile()) {
    const bytes = await readFile(source); await privateFile(target, bytes)
    if (hash(bytes) !== hash(await readFile(source))) throw new Error('Source file changed during backup; retry while idle')
  }
}
export async function fileHashes(directory, prefix = '') {
  const hashes = {}
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? prefix + '/' + name : name
    const info = await lstat(join(directory, path))
    if (info.isSymbolicLink()) throw new Error('Symlink in backup refused')
    if (info.isDirectory()) Object.assign(hashes, await fileHashes(directory, path))
    else hashes[path] = hash(await readFile(join(directory, path)))
  }
  return hashes
}
export async function verifyHashes(directory, expected) {
  for (const [name, digest] of Object.entries(expected)) {
    if (!inside(resolve(directory), resolve(directory, name))) throw new Error('Unsafe manifest path')
    if (hash(await readFile(join(directory, name))) !== digest) throw new Error('Backup checksum mismatch')
  }
}
