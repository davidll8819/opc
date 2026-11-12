// Operator-enabled local provisioner. No request-supplied paths, ports or credentials.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, readFile, writeFile, chmod, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { MongoClient, ObjectId } from 'mongodb'
import { createClient } from 'redis'
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'
import { createOperationsDriver } from '../../apps/api/src/operations/driver.mjs'
import { privateJson, readJson } from './private-runtime-files.mjs'
const exec = promisify(execFile)
const secret = () => randomBytes(32).toString('hex')
const pause = (ms, signal) => new Promise((ok, no) => {
  signal?.throwIfAborted()
  const cancel = () => { clearTimeout(timer); no(signal.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); ok() }, ms)
  signal?.addEventListener('abort', cancel, { once: true })
})
const error = message => Object.assign(new Error('Video runtime provisioning failed'), { provisionMessage: message })
async function free(port) {
  return new Promise(ok => {
    const s = createServer(); s.once('error', () => ok(false))
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)))
  })
}
export async function allocatePorts(registry, { start = 21000, end = 29999 } = {}, isFree = free) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || end - start < 4)
    throw error('自动开通端口范围无效，请联系管理员')
  const used = new Set(Object.values(registry).flatMap(e => [
    ...Object.values(e.servicePorts || {}), e.routerPort,
    e.infrastructure?.redis?.port,
    ...[e.serverUrl, e.aiUrl, e.infrastructure?.assets?.endpoint].filter(Boolean).map(url => Number(new URL(url).port)),
  ]))
  const ports = []
  for (let port = start; port <= end && ports.length < 5; port++) if (!used.has(port) && await isFree(port)) ports.push(port)
  if (ports.length !== 5) throw error('可用视频服务端口不足，请联系管理员扩容后重试')
  return Object.fromEntries(['server', 'ai', 'redis', 'storage', 'router'].map((k, i) => [k, ports[i]]))
}
export function makeRuntimeEntry(id, ports, { mongoAddress, officeOrigin, ffmpegBin }) {
  const suffix = id.replaceAll('-', ''), dbName = `office_${suffix}`, password = secret()
  const uri = new URL(mongoAddress)
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol) || uri.username || uri.password)
    throw error('主机 MongoDB 地址配置无效')
  uri.username = `office_${suffix}`; uri.password = password
  uri.searchParams.set('authSource', dbName)
  const redis = { host: '127.0.0.1', port: ports.redis, password: secret() }
  const endpoint = `http://127.0.0.1:${ports.storage}`
  return {
    managedProvisioning: true, serviceHost: '127.0.0.1', servicePorts: { server: ports.server, ai: ports.ai },
    routerPort: ports.router, serverUrl: `http://127.0.0.1:${ports.server}`, aiUrl: `http://127.0.0.1:${ports.ai}`,
    officeOrigin, ffmpegBin, jwtSecret: secret(), bridgeSecret: secret(), internalToken: secret(), userId: new ObjectId().toHexString(),
    infrastructure: {
      mongodb: { uri: uri.toString(), dbName }, channelDb: { uri: uri.toString(), dbName: `${dbName}_channels` },
      redis, redlock: { redis, ttl: 300, retryDelay: 1000, retryCount: 3 },
      assets: { provider: 's3', region: 'us-east-1', accessKeyId: randomBytes(12).toString('hex'), secretAccessKey: secret(),
        bucketName: 'office-private', endpoint, publicEndpoint: endpoint, cdnEndpoint: `${endpoint}/office-private`, forcePathStyle: true, signExpires: 300 },
    },
  }
}
export async function runtimeYaml(root, id, entry) {
  const output = resolve(root, '.local/operations', id)
  for (const service of ['server', 'ai']) {
    const config = parse(await readFile(resolve(root, `integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-${service}/config/config.yaml.example`), 'utf8'))
    config.host = '127.0.0.1'; config.port = entry.servicePorts[service]
    for (const key of ['mongodb', 'redis', 'redlock', 'assets']) config[key] = entry.infrastructure[key]
    config.auth = { secret: '${OFFICE_JWT_SECRET}', internalToken: '${OFFICE_INTERNAL_TOKEN}' }
    config.officeBridge = { tenantId: id, revision: 1, secret: '${OFFICE_BRIDGE_SECRET}', officeOrigin: entry.officeOrigin }
    config.enableConfigLogging = false; config.enableBadRequestDetails = false
    config.logger = { console: { enable: true, level: 'warn' } }
    if (service === 'server') {
      config.aiClient = { baseUrl: entry.aiUrl, token: '${OFFICE_INTERNAL_TOKEN}' }
      config.channel = { channelDb: entry.infrastructure.channelDb, shortLink: { baseUrl: '' } }
      delete config.relay
    } else {
      config.serverClient.baseUrl = entry.serverUrl
      const gateway = `${entry.officeOrigin.replace(/\/$/, '')}/integrations/model-gateway/${id}`
      config.ai.fouryi = { baseUrl: gateway, apiKey: '${OFFICE_MODEL_GATEWAY_TOKEN}', timeout: 300000 }
      config.agent = { ...config.agent, routerPort: entry.routerPort, baseUrl: `${gateway}/api/anthropic/v1/messages`, apiKey: '${OFFICE_MODEL_GATEWAY_TOKEN}',
        defaultModel: 'office-content-ops', backgroundModel: 'office-content-ops', thinkModel: 'office-content-ops', models: ['office-content-ops'] }
    }
    const path = resolve(output, `${service}.yaml`)
    await writeFile(path, stringify(config), { mode: 0o600 }); await chmod(path, 0o600)
  }
}
export async function processMatches(record, expected) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid < 2 || record.marker !== expected) return false
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(record.pid), '-o', 'command='], { timeout: 3000 })
    return stdout.includes(expected)
  } catch { return false }
}
export function createNativeProvisioner({ root, env, config }) {
  const registryPath = env.OPERATIONS_RUNTIMES_FILE
  const driver = createOperationsDriver(env)
  const mongoClient = uri => new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 })
  async function health(id, signal) {
    const entry = (await readJson(registryPath, {}))[id]
    if (!entry) throw error('视频环境尚未分配')
    for (const service of ['server', 'ai']) {
      const timeout = AbortSignal.timeout(3000)
      const info = await driver.request({ ...entry, tenantId: id }, service, '/office-bridge/status', { signed: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
      if (info.version !== 5 || info.tenantId !== id || info.publishMode !== 'manual' || info.draining) throw error('视频服务身份或版本检查失败，请重试')
    }
  }
  async function start(dir, name, launch, marker, signal) {
    const path = resolve(dir, `${name}.pid.json`)
    if (await processMatches(await readJson(path), marker)) return
    signal?.throwIfAborted()
    const out = await open('/dev/null', 'a')
    try {
      const child = spawn(launch.exe || process.execPath, launch.args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: ['ignore', out.fd, out.fd] })
      await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) })
      child.unref()
      await privateJson(path, { pid: child.pid, marker })
    } finally { await out.close() }
    await pause(500, signal)
    if (!await processMatches(await readJson(path), marker)) throw error('视频服务启动后退出，请检查本机运行日志后重试')
  }
  async function poll(check, signal) {
    for (let n = 0; n < 40; n++) {
      signal?.throwIfAborted()
      try { await check(); return } catch (e) { if (n === 39) throw e }
      await pause(750, signal)
    }
  }
  return {
    health,
    async ensure(id, { progress, signal }) {
      if (!['darwin', 'linux'].includes(process.platform)) throw error('当前主机暂不支持本地视频自动开通')
      const build = resolve(root, 'integrations/aitoearn/source/project/aitoearn-backend')
      for (const path of [config.redisExecutable, config.storageExecutable, resolve(build, 'dist/apps/aitoearn-server/src/main.js'), resolve(build, 'dist/apps/aitoearn-ai/src/main.js')]) {
        if (!path) throw error('主机缺少视频运行程序，请联系管理员完成安装')
        try { await access(path) } catch { throw error('主机缺少视频运行程序，请联系管理员完成安装') }
      }
      let registry = await readJson(registryPath, {}), entry = registry[id]
      if (entry && !entry.managedProvisioning) return // Existing manually configured runtimes are never rewritten.
      if (!entry) {
        const limit = Number(config.maxRuntimes ?? 10)
        if (!Number.isInteger(limit) || limit < 1 || Object.values(registry).filter(e => e.managedProvisioning).length >= limit)
          throw error('本机视频环境数量已达上限，请联系管理员扩容后重试')
        entry = makeRuntimeEntry(id, await allocatePorts(registry, config.ports), config)
        registry[id] = entry
        await privateJson(registryPath, registry) // Durable allocation; retries reuse identities, secrets and ports.
      }
      const dir = resolve(root, '.local/operations', id)
      for (const sub of ['', 'assets', 'redis', 'logs/secure', 'work/server', 'work/ai']) {
        await mkdir(resolve(dir, sub), { recursive: true, mode: 0o700 }); await chmod(resolve(dir, sub), 0o700)
      }
      await progress('infrastructure')
      const admin = mongoClient(config.mongoAdminUri)
      try {
        await admin.connect()
        const name = entry.infrastructure.mongodb.dbName, db = admin.db(name)
        const uri = new URL(entry.infrastructure.mongodb.uri), username = decodeURIComponent(uri.username)
        const existing = (await db.command({ usersInfo: username })).users
        if (!existing.length) await db.command({ createUser: username, pwd: decodeURIComponent(uri.password), roles: [
          { role: 'readWrite', db: name }, { role: 'dbAdmin', db: name },
          { role: 'readWrite', db: `${name}_channels` }, { role: 'dbAdmin', db: `${name}_channels` },
        ], customData: { officeTenantId: id } })
        else if (existing[0].customData?.officeTenantId !== id) throw error('视频数据库身份冲突，已停止开通，请联系管理员')
      } finally { await admin.close() }
      const scoped = mongoClient(entry.infrastructure.mongodb.uri)
      try { await scoped.connect(); await scoped.db(entry.infrastructure.mongodb.dbName).command({ ping: 1 }) } finally { await scoped.close() }
      const redis = entry.infrastructure.redis, assets = entry.infrastructure.assets
      const redisConfig = resolve(dir, 'redis.conf')
      await writeFile(redisConfig, `bind 127.0.0.1\nprotected-mode yes\nport ${redis.port}\nrequirepass ${redis.password}\ndir ${JSON.stringify(resolve(dir, 'redis'))}\nappendonly yes\nlogfile ""\n`, { mode: 0o600 }); await chmod(redisConfig, 0o600)
      await start(dir, 'redis', { exe: config.redisExecutable, args: [redisConfig], cwd: dir, env: { PATH: env.PATH } }, `127.0.0.1:${redis.port}`, signal)
      const cache = createClient({ socket: { host: redis.host, port: redis.port, connectTimeout: 3000, reconnectStrategy: false }, password: redis.password }); cache.on('error', () => {})
      try { await cache.connect(); await cache.ping() } finally { if (cache.isOpen) await cache.quit() }
      await start(dir, 'storage', { exe: config.storageExecutable, args: [resolve(dir, 'assets')], cwd: dir, env: { PATH: env.PATH, HOME: dir,
        RUSTFS_ADDRESS: `127.0.0.1:${new URL(assets.endpoint).port}`, RUSTFS_CONSOLE_ENABLE: 'false', RUSTFS_ACCESS_KEY: assets.accessKeyId, RUSTFS_SECRET_KEY: assets.secretAccessKey, RUSTFS_OBS_LOGGER_LEVEL: 'error' } }, resolve(dir, 'assets'), signal)
      const s3 = new S3Client({ endpoint: assets.endpoint, region: assets.region, forcePathStyle: true, credentials: { accessKeyId: assets.accessKeyId, secretAccessKey: assets.secretAccessKey }, maxAttempts: 1 })
      try {
        await poll(async () => {
          try { await s3.send(new HeadBucketCommand({ Bucket: assets.bucketName }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }) }
          catch (e) { if (e.$metadata?.httpStatusCode !== 404) throw e; await s3.send(new CreateBucketCommand({ Bucket: assets.bucketName }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }) }
        }, signal)
      } finally { s3.destroy() }
      // No anonymous bucket policy. All generated files require the Office private media proxy.
      await progress('configuring'); await runtimeYaml(root, id, entry)
      await progress('starting')
      for (const service of ['server', 'ai']) {
        const launch = { args: [resolve(root, 'scripts/managed-video-service.mjs'), id, service, resolve(dir, `${service}.yaml`)], cwd: root,
          env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR, OPERATIONS_RUNTIMES_FILE: registryPath } }
        await start(dir, service, launch, resolve(dir, `${service}.yaml`), signal)
      }
      await progress('checking')
      await poll(() => health(id, signal), signal)
    },
  }
}
