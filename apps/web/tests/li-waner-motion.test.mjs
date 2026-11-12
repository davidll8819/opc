import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sample, nextFrameTime, STEPS, DURATION, HOME } from '../public/previews/li-waner-motion/motion.mjs'

test('motion cycle stays on the ground path without teleporting at phase transitions', () => {
  let boundary = 0
  for (const step of STEPS) {
    boundary += step.duration
    const before = sample(boundary - 0.00001)
    const after = sample(boundary + 0.00001)
    assert.ok(Math.abs(before.x - after.x) < 0.01, step.id)
  }
  assert.equal(sample(0).x, HOME)
  assert.equal(sample(DURATION).phase, 'work')
  assert.equal(sample(DURATION).frame, 7)
})

test('walk inspection advances all eight poses without translating a static picture', () => {
  let time = 0
  const frames = []
  for (let i = 0; i < 8; i++) {
    const pose = sample(time, 'walk')
    frames.push(pose.frame)
    assert.equal(pose.x, 450)
    time = nextFrameTime(time, 'walk')
  }
  assert.deepEqual(frames, [0,1,2,3,4,5,6,7])
  assert.equal(sample(time, 'walk').frame, 0)
})

test('stand and sit transitions use reversed pose order with valid atlas frames', () => {
  const rise = [], sit = []
  let start = 0
  for (const step of STEPS) {
    if (['rise','sit'].includes(step.id)) {
      const frames = step.id === 'rise' ? rise : sit
      for (let i = 0; i < 8; i++) frames.push(sample(start + (i + .5) * step.duration / 8).frame)
    }
    start += step.duration
  }
  assert.deepEqual(rise, [...sit].reverse())
  assert.equal(sit[0], 0)
  assert.equal(sit[7], 7)
  for (let t = 0; t < DURATION; t += .025) {
    const pose = sample(t)
    assert.ok(Number.isInteger(pose.frame) && pose.frame >= 0 && pose.frame < 8)
  }
})
