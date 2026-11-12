import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readSkillCatalog } from '../apps/api/src/skill-catalog.mjs'
import { prepareCatalogSkill } from '../apps/api/src/skill-install.mjs'

test('curated catalog preserves originals, merges identical entries and blocks removed installs', async () => {
  const read = async (name) => JSON.parse(await readFile(new URL('../skills/catalog/' + name, import.meta.url)))
  const original = await read('catalog-before-curation-2026-10-19.json')
  const audit = await read('curation-2026-10-19.json')
  const current = await readSkillCatalog()
  assert.equal(original.items.length, 600)
  assert.equal(current.items.filter(i => !i.defaultHidden).length, 192)
  assert.equal(current.items.filter(i => i.defaultHidden).length, 252)
  for (const item of current.items) {
    assert.deepEqual(item.download.sha256, original.items.find(i => i.id === item.id).download.sha256)
    for (const alias of item.mergedSources) assert.ok(original.items.some(i => i.id === alias.id))
  }
  for (const entry of audit.entries.filter(i => ['removed', 'merged'].includes(i.action))) {
    assert.ok(!current.items.some(i => i.id === entry.id))
    await assert.rejects(prepareCatalogSkill(entry.id), /技能目录中没有这一项/)
  }
  assert.ok(!current.items.some(i => i.number === 509))
  assert.ok(current.items.find(i => i.number === 285).defaultHidden) // PDF is local tooling, not an account service.
})
