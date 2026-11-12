// Safe restore rehearsal only: target names and service ports are generated here.
// No option exists to overwrite the production database or running RustFS bucket.
import { readFile, mkdtemp, mkdir, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { MongoClient, BSON } from 'mongodb'
import { S3Client, CreateBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { root, run, privateDir, privateFile, pgClient, pgEnvironment, tableCounts, copyTree, verifyHashes, hash, quote, inside } from './backup/common.mjs'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = []
let targetDb, created = false, mongo, admin
async function port() {
  const server = createServer(); await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}
async function start(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'ignore', env })
  children.push(child)
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) })
  return child
}
async function ready(fn) { for (let i = 0; i < 100; i++) { try { return await fn() } catch { await wait(200) } } throw new Error('Temporary service readiness timed out') }
async function main() {
  process.umask(0o077)
  if (!process.argv[2] || !process.argv[3]) throw new Error('Provide backup directory and separate key directory')
  const backup = resolve(process.argv[2]), keys = resolve(process.argv[3])
  await access(join(backup, 'COMPLETE'))
  const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'))
  const keyBytes = await readFile(join(keys, 'manifest.json')), keyManifest = JSON.parse(keyBytes)
  if (manifest.version !== 1 || keyManifest.id !== manifest.id || hash(keyBytes) !== manifest.keyManifestHash) throw new Error('Backup and key bundle do not match')
  await verifyHashes(backup, manifest.hashes); await verifyHashes(keys, keyManifest.hashes)
  const target = process.argv[4] ? resolve(process.argv[4]) : await mkdtemp(join(tmpdir(), 'wishtaday-restore-'))
  if (inside(root, target) || inside(backup, target) || inside(keys, target)) throw new Error('Restore target must be isolated')
  if (process.argv[4]) await mkdir(target, { mode: 0o700 }) // Existing directories are refused.
  await privateDir(target)
  process.loadEnvFile(join(root, '.env')) // Only connects to local PostgreSQL to create a NEW rehearsal database.
  const env = pgEnvironment()
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST)) throw new Error('Rehearsal only supports local PostgreSQL')
  targetDb = 'wishtaday_restore_' + randomBytes(8).toString('hex')
  admin = await pgClient()
  await admin.query(`CREATE DATABASE ${quote(targetDb)}`); created = true
  await run(join(root, '.local/services/bin/pg_restore'), ['--exit-on-error', '--no-owner', '--no-acl', '--dbname=' + targetDb, join(backup, 'postgres.dump')], { env: pgEnvironment(targetDb), maxBuffer: 1024 * 1024 })
  const restored = await pgClient(targetDb)
  let actual
  try { actual = await tableCounts(restored) } finally { await restored.end() }
  if (JSON.stringify(actual) !== JSON.stringify(manifest.postgres)) throw new Error('PostgreSQL table counts differ')
  console.log('PostgreSQL: all table record counts match')
  const mongoDir = join(target, 'mongo'); await privateDir(mongoDir)
  const mongoPort = await port()
  await start(join(root, '.local/production-runtime/bin/mongod'), ['--dbpath', mongoDir, '--bind_ip', '127.0.0.1', '--port', String(mongoPort), '--nounixsocket'])
  mongo = new MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`, { serverSelectionTimeoutMS: 500 })
  await ready(() => mongo.connect())
  const mongoDb = mongo.db('restore_test')
  let mongoDocuments = 0
  for (const collection of manifest.mongo) {
    if (!inside(backup, resolve(backup, collection.file))) throw new Error('Unsafe BSON path')
    const destination = await mongoDb.createCollection(collection.name, collection.options)
    const bytes = await readFile(join(backup, collection.file)), docs = []
    for (let offset = 0; offset < bytes.length;) {
      const size = bytes.readInt32LE(offset)
      if (size < 5 || offset + size > bytes.length) throw new Error('Invalid BSON backup')
      docs.push(BSON.deserialize(bytes.subarray(offset, offset + size), { promoteLongs: false, promoteBuffers: true })); offset += size
    }
    if (docs.length) await destination.insertMany(docs)
    for (const { key, name, ...options } of collection.indexes) {
      if (name !== '_id_') { delete options.v; delete options.ns; await destination.createIndex(key, { ...options, name }) }
    }
    const count = await destination.countDocuments({})
    if (count !== collection.count) throw new Error('MongoDB record counts differ')
    mongoDocuments += count
  }
  console.log('MongoDB: all collection record counts match')
  const mediaDir = join(target, 'rustfs'); await privateDir(mediaDir)
  const mediaPort = await port(), accessKeyId = randomBytes(12).toString('hex'), secretAccessKey = randomBytes(32).toString('hex')
  await start(join(root, '.local/production-runtime/bin/rustfs'), [mediaDir], { ...process.env, RUSTFS_ADDRESS: `127.0.0.1:${mediaPort}`, RUSTFS_CONSOLE_ENABLE: 'false', RUSTFS_ACCESS_KEY: accessKeyId, RUSTFS_SECRET_KEY: secretAccessKey, RUSTFS_OBS_LOGGER_LEVEL: 'error' })
  const s3 = new S3Client({ endpoint: `http://127.0.0.1:${mediaPort}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 })
  try {
    const Bucket = 'restore-test'
    await ready(() => s3.send(new CreateBucketCommand({ Bucket })))
    for (const object of manifest.media) {
      if (!inside(backup, resolve(backup, object.file))) throw new Error('Unsafe media path')
      await s3.send(new PutObjectCommand({ Bucket, Key: object.key, Body: await readFile(join(backup, object.file)), ContentType: object.contentType, Metadata: object.metadata }))
      const result = await s3.send(new GetObjectCommand({ Bucket, Key: object.key }))
      if (hash(Buffer.from(await result.Body.transformToByteArray())) !== object.sha256) throw new Error('Restored media checksum differs')
    }
  } finally { s3.destroy() }
  console.log('RustFS: all restored objects read back with matching SHA256 checksums')
  await copyTree(keys, join(target, 'private-restored'))
  await verifyHashes(join(target, 'private-restored'), keyManifest.hashes)
  const result = { status: 'verified', backupId: manifest.id, target, postgresTables: Object.keys(actual).length, mongoCollections: manifest.mongo.length, mongoDocuments, mediaObjects: manifest.media.length, privateFiles: Object.keys(keyManifest.hashes).length, allCountsMatch: true, allFileHashesMatch: true, temporaryPostgresRemovedAfterCheck: true }
  await privateFile(join(target, 'RESTORE_VERIFICATION.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
main().catch(() => { console.error('Restore verification failed; production data untouched; credentials withheld.'); process.exitCode = 1 }).finally(async () => {
  await mongo?.close()
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(10000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }
  if (created && /^wishtaday_restore_[a-f0-9]{16}$/.test(targetDb)) await admin.query(`DROP DATABASE ${quote(targetDb)}`)
  await admin?.end()
})
