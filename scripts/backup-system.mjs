// Logical, read-only backup. Source database records and service settings are untouched.
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile, chmod } from 'node:fs/promises'
import { MongoClient, BSON } from 'mongodb'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { root, run, settings, outsideProject, inside, privateDir, privateFile, pgClient, pgEnvironment, tableCounts, copyTree, fileHashes, hash } from './backup/common.mjs'

let stage = 'initialization', mongoClient
async function main() {
  process.umask(0o077)
  const base = await outsideProject(process.argv[2] || join(homedir(), 'Wishtaday-Backups'))
  const keysBase = await outsideProject(process.argv[3] || join(homedir(), 'Wishtaday-Backup-Keys'))
  if (inside(base, keysBase) || inside(keysBase, base)) throw new Error('Key and data roots must be separate')
  const { tenant, entry, credentials } = await settings()
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
  const output = join(base, id), keys = join(keysBase, id)
  await privateDir(output); await privateDir(keys)
  stage = 'MongoDB connection'
  const mongo = mongoClient = new MongoClient(entry.infrastructure.mongodb.uri)
  await mongo.connect()
  const db = mongo.db(entry.infrastructure.mongodb.dbName)
  const active = await db.collection('contentGenerationTask').countDocuments({ status: 'running', deletedAt: null }) + await db.collection('aiLogs').countDocuments({ status: 'generating' })
  if (active) { await mongo.close(); throw new Error('Wait for active media tasks before backing up') }
  const manifest = { version: 1, id, createdAt: new Date().toISOString(), tenant, postgres: {}, mongo: [], media: [], notes: 'Per-store snapshots; keep application idle for cross-store consistency.' }
  stage = 'PostgreSQL snapshot/dump'
  const pg = await pgClient()
  try {
    await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const snapshot = (await pg.query('SELECT pg_export_snapshot() AS id')).rows[0].id
    manifest.postgres = await tableCounts(pg)
    await run(join(root, '.local/services/bin/pg_dump'), ['--format=custom', '--no-owner', '--no-acl', '--snapshot=' + snapshot, '--file=' + join(output, 'postgres.dump')], { env: pgEnvironment(), maxBuffer: 1024 * 1024 })
    await chmod(join(output, 'postgres.dump'), 0o600)
    await pg.query('COMMIT')
  } finally { await pg.end() }
  stage = 'MongoDB snapshot'
  const session = mongo.startSession()
  try {
    const collections = await db.listCollections({}, { nameOnly: false }).toArray()
    if (collections.some(c => c.type !== 'collection')) throw new Error('Unsupported Mongo views; backup refused instead of silently omitting them')
    session.startTransaction({ readConcern: { level: 'snapshot' } })
    for (const [index, item] of collections.entries()) {
      const collection = db.collection(item.name), docs = []
      for await (const doc of collection.find({}, { session })) docs.push(BSON.serialize(doc))
      const name = `mongo/${index}.bson`
      await privateFile(join(output, name), Buffer.concat(docs))
      manifest.mongo.push({ name: item.name, file: name, count: docs.length, options: item.options, indexes: await collection.indexes() })
    }
    await session.abortTransaction() // Read-only snapshot; nothing to commit.
  } finally { await session.endSession(); await mongo.close() }
  stage = 'RustFS media read'
  const s3 = new S3Client({ endpoint: entry.infrastructure.assets.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: credentials.storageAccessKey, secretAccessKey: credentials.storageSecretKey } })
  try {
    let token
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: entry.infrastructure.assets.bucketName, ContinuationToken: token }))
      for (const item of list.Contents || []) {
        const object = await s3.send(new GetObjectCommand({ Bucket: entry.infrastructure.assets.bucketName, Key: item.Key, IfMatch: item.ETag }))
        const bytes = Buffer.from(await object.Body.transformToByteArray()), file = `media/${manifest.media.length}.bin`
        await privateFile(join(output, file), bytes)
        manifest.media.push({ key: item.Key, file, size: bytes.length, sha256: hash(bytes), contentType: object.ContentType, metadata: object.Metadata })
      }
      token = list.NextContinuationToken
    } while (token)
  } finally { s3.destroy() }
  stage = 'private files'
  const sessionPath = join(root, 'integrations/aitoearn/source/project/aitoearn-backend/.claude-session')
  // Session files may themselves contain account material: store the whole tree with keys.
  await copyTree(sessionPath, join(keys, 'proxy-session'), name => name.endsWith('.log') || name.includes('/logs') || name.endsWith('.pid'))
  for (const name of ['.env', '.local/operations-config.key', '.local/operations-runtimes.json', '.local/production-runtime/credentials.json'])
    await privateFile(join(keys, 'private-config', name), await readFile(join(root, name)))
  await copyTree(join(root, '.local/operations'), join(keys, 'private-config/.local/operations'))
  const keyManifest = { id, hashes: await fileHashes(keys) }
  await privateFile(join(keys, 'manifest.json'), JSON.stringify(keyManifest, null, 2))
  manifest.hashes = await fileHashes(output)
  manifest.keyManifestHash = hash(await readFile(join(keys, 'manifest.json')))
  await privateFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await privateFile(join(output, 'COMPLETE'), 'Backup finished; verify before restoring.\n')
  console.log(JSON.stringify({ status: 'complete', backup: output, keys, postgresTables: Object.keys(manifest.postgres).length, mongoCollections: manifest.mongo.length, mediaObjects: manifest.media.length, privateFiles: Object.keys(keyManifest.hashes).length }))
}
main().catch(error => { console.error('Backup failed at '+stage+'; category='+error.name+'; code='+String(error.code || 'none')+'; credentials withheld.'); process.exitCode = 1 }).finally(() => mongoClient?.close())
