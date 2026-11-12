import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, outsideProject, verifyHashes, fileHashes, copyTree } from '../scripts/backup/common.mjs'

test('backup validation rejects changed files, escaped paths and project-local destinations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'backup-validation-'))
  try {
    await writeFile(join(directory, 'sample'), 'synthetic backup data')
    const manifest = await fileHashes(directory)
    await verifyHashes(directory, manifest)
    await writeFile(join(directory, 'sample'), 'modified')
    await assert.rejects(verifyHashes(directory, manifest), /checksum/)
    await assert.rejects(verifyHashes(directory, { '../escape': 'invalid' }), /Unsafe/)
    await assert.rejects(outsideProject(join(root, 'must-not-create-backup')), /outside/)
    await symlink(join(directory, 'sample'), join(directory, 'link'))
    await assert.rejects(copyTree(join(directory, 'link'), join(directory, 'copied')), /Symlinks/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
