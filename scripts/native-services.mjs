import { spawnSync } from 'node:child_process'
import { mkdir, access, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

// Optional project-local PostgreSQL/Redis installation for Macs without Docker.
process.loadEnvFile('.env')
const bin = resolve('.local/services/bin')
const pgData = resolve('.local/postgres')
const redisData = resolve('.local/redis')
const run = (name, args, allowFailure = false) => {
  const result = spawnSync(resolve(bin, name), args, { encoding: 'utf8' })
  if (result.status !== 0 && !allowFailure)
    throw new Error(`${name}: ${result.error?.message || result.stderr || result.stdout}`)
  return result
}
const exists = async (path) => access(path).then(() => true, () => false)

if (process.argv[2] === 'stop') {
  if (await exists(resolve(redisData, 'redis.pid')))
    run('redis-cli', ['-h', '127.0.0.1', '-p', '56379', 'shutdown'])
  if (run('pg_ctl', ['-D', pgData, 'status'], true).status === 0)
    run('pg_ctl', ['-D', pgData, '-m', 'fast', '-w', 'stop'])
  console.log('Local PostgreSQL and Redis stopped; data preserved')
} else {
  await mkdir('.local', { recursive: true })
  await mkdir(redisData, { recursive: true, mode: 0o700 })
  if (!(await exists(resolve(pgData, 'PG_VERSION')))) {
    const passwordFile = resolve('.local/postgres-init-password')
    await writeFile(passwordFile, process.env.LOCAL_DB_PASSWORD, { mode: 0o600, flag: 'wx' })
    try {
      run('initdb', ['-D', pgData, '-U', 'office_admin', '--pwfile', passwordFile,
        '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C'])
    } finally {
      await unlink(passwordFile)
    }
  }
  if (run('pg_ctl', ['-D', pgData, 'status'], true).status !== 0)
    run('pg_ctl', ['-D', pgData, '-l', resolve('.local/postgres.log'),
      '-o', '-h 127.0.0.1 -p 55432 -k /tmp', '-w', 'start'])
  const adminEnv = { ...process.env, PGUSER: 'office_admin',
    PGPASSWORD: process.env.LOCAL_DB_PASSWORD, PGDATABASE: 'postgres' }
  const database = spawnSync(resolve(bin, 'psql'), ['-Atc', "SELECT 1 FROM pg_database WHERE datname='office'"],
    { env: adminEnv, encoding: 'utf8' })
  if (database.status !== 0) throw new Error(database.stderr)
  if (database.stdout.trim() !== '1') {
    const created = spawnSync(resolve(bin, 'createdb'), ['office'], { env: adminEnv, encoding: 'utf8' })
    if (created.status !== 0) throw new Error(created.stderr)
  }
  if (run('redis-cli', ['-h', '127.0.0.1', '-p', '56379', 'ping'], true).stdout?.trim() !== 'PONG')
    run('redis-server', ['--bind', '127.0.0.1', '--port', '56379', '--protected-mode', 'yes',
      '--appendonly', 'yes', '--dir', redisData, '--daemonize', 'yes',
      '--pidfile', resolve(redisData, 'redis.pid'), '--logfile', resolve('.local/redis.log')])
  console.log('Local PostgreSQL and Redis ready on 127.0.0.1')
}
