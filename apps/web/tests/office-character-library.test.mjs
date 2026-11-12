import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { EMPLOYEES } from '../../../packages/employees/registry.mjs'

let server, library
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null } })
  library = await server.ssrLoadModule('/src/scene/characters/officeCharacterLibrary.ts')
})
after(async () => { await server?.close() })

test('office visuals match existing employee names and stable IDs, independent of roster order', () => {
  const entries = library.OFFICE_CHARACTER_LIBRARY
  assert.equal(entries.length, 12)
  assert.equal(new Set(entries.map(e => e.employeeId)).size, 12)
  assert.equal(new Set(entries.map(e => e.characterId)).size, 12)
  for (const employee of [...EMPLOYEES].reverse()) {
    const visual = library.officeCharacterFor(employee.id)
    if (employee.role === 'intern') assert.equal(visual, undefined)
    else assert.equal(visual?.name, employee.name)
  }
  assert.equal(library.officeCharacterFor('unknown-employee'), undefined)
})

test('all mapped characters have distinct published motion sheets and paired identity records', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../design/characters/anime-v3-2026-11-03/manifest.json', import.meta.url)))
  const hashes = new Set()
  for (const entry of library.OFFICE_CHARACTER_LIBRARY) {
    const record = manifest.characters.find(c => c.characterId === entry.characterId)
    assert.equal(record.name, entry.name)
    assert.equal(record.scenePreview.employeeId, entry.employeeId)
    assert.equal(record.scenePreview.portraitInstalled, false)
    const combined = library.officeMotionSource(entry.variant, 'walk').rows === 6
    for (const sheet of combined ? ['motion'] : ['sit-back', 'walk', 'turn']) {
      const data = await readFile(new URL(`../public/assets/characters/${entry.characterId}-library-v3/${sheet}.png`, import.meta.url))
      assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(data[25], 6, 'RGBA required')
      assert.ok(Math.abs(data.readUInt32BE(16) / data.readUInt32BE(20) - (combined ? 2/3 : 2)) < .01)
      const hash = createHash('sha256').update(data).digest('hex')
      assert.ok(!hashes.has(hash), `${entry.name} ${sheet} accidentally reuses another sheet`)
      hashes.add(hash)
    }
  }
  assert.equal(hashes.size, 28)
  const reserved = manifest.characters.filter(c => !c.runtimeInstalled)
  assert.deepEqual(reserved.map(c => c.name).sort(), [])
})

 test('combined reserve atlases select separate sitting, walking and turning rows', () => {
 for (const id of ['cheng-zhiyao','xu-zhining','su-ying','shen-qinglan']) {
  const poses=['sit-back','walk','turn'].map(s=>library.officeMotionSource(id,s))
  assert.deepEqual(poses.map(p=>p.firstRow),[0,2,4])
  assert.ok(poses.every(p=>p.rows===6 && p.url===`/assets/characters/${id}-library-v3/motion.png`))
 }
 assert.deepEqual(library.officeMotionSource('library','walk'),{url:'/assets/characters/li-waner-library-v3/walk.png',rows:2,firstRow:0})
})
