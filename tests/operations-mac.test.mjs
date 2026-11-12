import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { matchingProcess } from '../scripts/operations-mac.mjs'
test('native runtime process checks require both executable and service identity', async () => {
  assert.equal(await matchingProcess(0, process.execPath, []), false)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'office-runtime-identity-fixture'], { stdio: 'ignore' })
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no) })
  try {
    assert.equal(await matchingProcess(child.pid, process.execPath, ['office-runtime-identity-fixture']), true)
    assert.equal(await matchingProcess(child.pid, process.execPath, ['another-service-config.yaml']), false)
    assert.equal(await matchingProcess(child.pid, '/not-the-runtime/node', ['office-runtime-identity-fixture']), false)
  } finally { child.kill('SIGTERM') }
})
