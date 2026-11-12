import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
let server, Motion
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, hmr: false, ws: false, watch: null } })
  ;({ LiWanerMotionState: Motion } = await server.ssrLoadModule('/src/scene/characters/liWanerMotionState.ts'))
})
after(async () => { await server?.close() })
const tick = (m, seconds) => { for (let t = 0; t < seconds; t += .025) m.update(.025, 0) }
test('leaving a chair waits for standing up before allowing locomotion', () => {
  const m = new Motion(true)
  m.sync(false, true, false)
  assert.equal(m.holdsMovement, true)
  tick(m, .4)
  assert.equal(m.holdsMovement, true)
  assert.ok(m.pose.frame > 0 && m.pose.frame < 7)
  tick(m, .5)
  assert.equal(m.pose.sheet, 'turn')
  assert.equal(m.holdsMovement, true)
  tick(m, .3)
  assert.equal(m.holdsMovement, false)
  assert.equal(m.pose.sheet, 'walk')
  const old = m.pose.frame
  m.update(.025, 18)
  assert.notEqual(m.pose.frame, old)
})
test('turning on return completes before sitting, and seated pose has bent knees', () => {
  const m = new Motion(false)
  m.sync(false, true, true)
  assert.equal(m.holdsMovement, true)
  tick(m, .5)
  assert.equal(m.holdsMovement, false)
  assert.equal(m.pose.flip, true)
  m.sync(true, false, false)
  tick(m, .1)
  assert.equal(m.pose.sheet, 'turn')
  assert.equal(m.seated, 0)
  tick(m, 1.2)
  assert.deepEqual(m.pose, { sheet: 'sit-back', frame: 7, flip: false })
})

test('both return directions rotate to the back before bending to sit', () => {
  for (const left of [false, true]) {
    const m = new Motion(false)
    m.sync(false, true, left)
    tick(m, .5)
    m.sync(true, false, left)
    const headings = []
    for (let i = 0; i < 60; i++) {
      m.update(.025, 0)
      if (m.pose.sheet === 'turn') headings.push(m.pose.frame)
      if (m.seated > 0) {
        assert.equal(headings.at(-1), 6)
        assert.equal(m.pose.sheet, 'sit-back')
        assert.equal(m.pose.flip, false)
        break
      }
    }
    assert.ok(m.seated > 0)
  }
})

test('initial office pose and the whole rise transition face the monitor', () => {
  const m = new Motion(true)
  assert.deepEqual(m.pose, { sheet: 'sit-back', frame: 7, flip: false })
  m.sync(false, true, true)
  for (let i = 0; i < 30; i++) {
    m.update(.025, 0)
    assert.equal(m.pose.sheet, 'sit-back')
    assert.equal(m.pose.flip, false)
    assert.equal(m.holdsMovement, true)
  }
})
test('idle away from the home chair remains standing, not seated in mid-air', () => {
  const m = new Motion(false)
  m.sync(false, false, false)
  tick(m, 2)
  assert.deepEqual(m.pose, { sheet: 'turn', frame: 0, flip: false })
  assert.equal(m.holdsMovement, false)
})
