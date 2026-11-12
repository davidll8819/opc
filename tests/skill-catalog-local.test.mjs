import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readSkillCatalog } from '../apps/api/src/skill-catalog.mjs'

test('catalog reflects missing, restored, modified and removed local packages without changing metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-local-catalog-'))
  try {
    await mkdir(join(root, 'skills/packages'), { recursive: true })
    const bytes = Buffer.from('catalog fixture')
    const download = {
      status: 'downloaded',
      packagePath: 'skills/packages/a.zip',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const catalog = {
      items: [
        { id: 'a', download },
        { id: 'b', download },
      ],
    }
    const read = async () => (await readSkillCatalog({ root, catalog })).items
    assert.match((await read())[0].download.error, /缺少/)
    await writeFile(join(root, download.packagePath), bytes)
    assert.ok((await read()).every((item) => item.download.status === 'downloaded'))
    await writeFile(join(root, download.packagePath), 'changed fixture')
    assert.match((await read())[0].download.error, /校验失败/)
    await rm(join(root, download.packagePath))
    assert.equal((await read())[0].download.status, 'failed')
    assert.equal(download.status, 'downloaded')
    await writeFile(join(root, 'outside.zip'), bytes)
    await symlink(join(root, 'outside.zip'), join(root, download.packagePath))
    assert.match((await read())[0].download.error, /路径无效/)
    download.packagePath = 'skills/packages/../../outside.zip'
    assert.match((await read())[0].download.error, /路径无效/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
