// Changes only the local native bucket policy. Object bytes and runtime/model configuration stay untouched.
import {
  S3Client,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { settings, hash } from './backup/common.mjs'
import { privateVideoPolicy } from './private-video-policy.mjs'

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--apply'))
    throw Error('Use --apply or no arguments')
  const { entry } = await settings(),
    a = entry.infrastructure.assets
  if (!entry.nativeMac || !['127.0.0.1', 'localhost'].includes(new URL(a.endpoint).hostname))
    throw Error('Local native storage required')
  const client = new S3Client({
    endpoint: a.endpoint,
    region: a.region || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: a.accessKeyId, secretAccessKey: a.secretAccessKey },
  })
  const Bucket = a.bucketName,
    policy = privateVideoPolicy(Bucket)
  try {
    const current = JSON.parse((await client.send(new GetBucketPolicyCommand({ Bucket }))).Policy)
    const rule = current.Statement?.[0],
      principal =
        typeof rule?.Principal === 'string' ? [rule.Principal] : [rule?.Principal?.AWS].flat()
    const publicReader =
      current.Statement?.length === 1 &&
      rule.Effect === 'Allow' &&
      JSON.stringify(principal) === JSON.stringify(['*']) &&
      JSON.stringify([rule.Action].flat()) === JSON.stringify(['s3:GetObject']) &&
      !rule.Condition
    const alreadyProtected =
      publicReader &&
      !rule.Resource &&
      JSON.stringify([rule.NotResource].flat().sort()) ===
        JSON.stringify(policy.Statement[0].NotResource.slice().sort())
    const knownPublic =
      current.Statement?.length === 1 &&
      current.Statement[0].Effect === 'Allow' &&
      publicReader &&
      JSON.stringify([current.Statement[0].Action].flat()) === JSON.stringify(['s3:GetObject']) &&
      JSON.stringify([current.Statement[0].Resource].flat()) ===
        JSON.stringify([`arn:aws:s3:::${Bucket}/*`]) &&
      !current.Statement[0].Condition
    async function inventory() {
      const objects = []
      let ContinuationToken
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }))
        objects.push(...(r.Contents || []).map((o) => ({ key: o.Key, etag: o.ETag, size: o.Size })))
        ContinuationToken = r.NextContinuationToken
      } while (ContinuationToken)
      return objects.sort((x, y) => x.key.localeCompare(y.key))
    }
    const before = await inventory()
    if (process.argv.includes('--apply') && !alreadyProtected) {
      const narrowerPolicy =
        publicReader &&
        !rule.Resource &&
        Array.isArray(rule.NotResource) &&
        rule.NotResource.every((item) => policy.Statement[0].NotResource.includes(item))
      if (!knownPublic && !narrowerPolicy)
        throw Error('Unrecognized policy; review before changing')
      const directory = '.local/security-backups'
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      await writeFile(
        `${directory}/video-policy-${Date.now()}.json`,
        JSON.stringify(current, null, 2),
        { mode: 0o600 },
      )
      await client.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify(policy) }))
    }
    const videos = before.filter(
      (o) =>
        /\/(?:ai\/video|office-edits|agent\/video-edit)\//.test(o.key) ||
        /\.(mp4|mov|webm|mkv|avi|m4v|mpeg|mpg|ts|m3u8)$/i.test(o.key),
    )
    const statuses = []
    for (const o of videos) {
      const u = `${a.cdnEndpoint.replace(/\/$/, '')}/${o.key.split('/').map(encodeURIComponent).join('/')}`
      const r = await fetch(u, {
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      statuses.push(r.status)
    }
    const unchanged = hash(JSON.stringify(before)) === hash(JSON.stringify(await inventory()))
    const secure = videos.length > 0 && statuses.every((s) => s === 403)
    console.log(
      JSON.stringify({
        applied: process.argv.includes('--apply'),
        videoObjectsChecked: videos.length,
        anonymousReadsBlocked: secure,
        objectCount: before.length,
        objectMetadataUnchanged: unchanged,
        modelConfigurationChanged: false,
        policyBackupSaved: process.argv.includes('--apply') && !alreadyProtected,
      }),
    )
    if (!unchanged || (process.argv.includes('--apply') && !secure)) process.exitCode = 1
  } finally {
    client.destroy()
  }
}
main().catch(() => {
  console.error('Video storage check failed; inspect the policy safely. No credentials printed.')
  process.exitCode = 1
})
