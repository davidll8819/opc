// One-time host setup for the existing native Mac infrastructure. Never reads a user's model Key.
import { readFile, access, writeFile, copyFile, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { privateJson, readJson } from './lib/private-runtime-files.mjs'
const root = process.cwd(), path = resolve(root, '.local/operations-provisioner.json')
try {
  if (process.platform !== 'darwin') throw Error('This installer is for the prepared native Mac host')
  if (await readJson(path)) throw Error('Provisioner host configuration already exists; it was retained')
  const credentials = JSON.parse(await readFile(resolve(root, '.local/production-runtime/credentials.json'), 'utf8'))
  const config = {
    enabled: true, officeOrigin: process.env.APP_ORIGIN,
    mongoAddress: 'mongodb://127.0.0.1:27018/?directConnection=true',
    mongoAdminUri: `mongodb://${encodeURIComponent(credentials.mongoUser)}:${encodeURIComponent(credentials.mongoPassword)}@127.0.0.1:27018/?authSource=admin&directConnection=true`,
    redisExecutable: resolve(root, '.local/services/bin/redis-server'),
    storageExecutable: resolve(root, '.local/production-runtime/bin/rustfs'),
    ffmpegBin: resolve(root, '.local/media-tools/bin'), maxRuntimes: 10, ports: { start: 21000, end: 29999 },
  }
  if (!config.officeOrigin || !credentials.mongoUser || !credentials.mongoPassword) throw Error('Host prerequisites missing')
  for (const program of [config.redisExecutable, config.storageExecutable, resolve(config.ffmpegBin, 'ffmpeg')]) await access(program)
  const envPath = resolve(root, '.env'), original = await readFile(envPath, 'utf8')
  if (/^OPERATIONS_PROVISIONER_FILE=/m.test(original)) throw Error('Existing provisioner setting retained')
  await copyFile(envPath, resolve(root, '.local/backups/auto-video-20261111/env-before'))
  await chmod(resolve(root, '.local/backups/auto-video-20261111/env-before'), 0o600)
  await privateJson(path, config)
  await writeFile(envPath, original.replace(/\s*$/, '\n') + `OPERATIONS_PROVISIONER_FILE=${path}\n`, { mode: 0o600 })
  await chmod(envPath, 0o600)
  console.log('Local video provisioning enabled; personal Keys and existing workspace settings unchanged')
} catch {
  console.error('Host setup not completed. Check existing configuration and local runtime prerequisites; credentials were not printed.')
  process.exitCode = 1
}
