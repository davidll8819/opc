import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
let vite, merge, routing
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' })
  ;({ mergeSecretarySnapshot: merge } = await vite.ssrLoadModule('/src/saas/secretary/secretary-sync.ts'))
  routing = await vite.ssrLoadModule('/src/saas/workspace-route.ts')
})
after(async () => { await vite?.close() })
const board = text => ({ messages: [{ id: text, text }], tasks: [], batches: [] })
test('an old phone poll cannot roll back a newer desktop reply', () => {
  const desktop = { revision: 12, board: board('new reply') }
  const latePhone = { revision: 11, board: board('old reply') }
  assert.equal(merge(desktop, latePhone), desktop)
  assert.deepEqual(merge(latePhone, desktop), desktop)
})
test('out-of-order requests converge on the latest record without changing source data', () => {
  const initial = { revision: 0, board: board('empty') }
  const responses = [4, 2, 5, 3, 1].map(revision => ({ revision, board: board(`reply ${revision}`) }))
  const actual = responses.reduce(merge, initial)
  assert.equal(actual.revision, 5)
  assert.equal(actual.board.messages[0].text, 'reply 5')
  assert.equal(initial.revision, 0)
})
test('task-only mutations retain preferences; a preference-only refresh is accepted', () => {
  const initial = { revision: 4, board: board('before'), preferences: { name: '婉儿' } }
  const task = merge(initial, { revision: 5, board: board('task update') })
  assert.deepEqual(task.preferences, initial.preferences)
  assert.equal(merge(task, { ...task, preferences: { name: '新称呼' } }).preferences.name, '新称呼')
})
test('old office and private-secretary links resolve to one office entry', () => {
  for (const view of ['secretary', 'waner-office']) {
    const route = routing.readWorkspaceRoute(`#workspace=tenant-a&view=${view}`, 'tenant-a')
    assert.equal(route.tab, 'secretary')
    assert.equal(routing.workspaceHash('tenant-a', { ...route, tab: view }), '#workspace=tenant-a&view=secretary')
  }
})
