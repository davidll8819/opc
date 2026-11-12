import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateLogWriter, safeLogLine } from '../scripts/runtime-log-security.mjs'

test('sensitive request records are omitted before writing, including split chunks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'secure-log-test-'))
  const secret = 'synthetic-private-credential-123456'
  try {
    const writer = privateLogWriter(directory, { service: 'test', secrets: [secret] })
    writer.write('Authorization: Bear'); writer.write('er ' + secret + '\n')
    writer.write('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c3ludGhldGlj\n')
    writer.write('{"config":{"headers":{"api_key":"synthetic"}},"body":"private"}\n')
    writer.write('healthy request completed\n'); writer.close()
    const text = readdirSync(directory).map(name => readFileSync(join(directory, name), 'utf8')).join('')
    assert.ok(text.includes('healthy request completed'))
    assert.ok(!text.includes(secret)); assert.doesNotMatch(text, /Authorization|Bearer|eyJ|api_key|private/)
    // Node's Windows stat mode does not express ACL isolation. Redaction is tested on every OS.
    if (process.platform !== 'win32') {
      assert.equal(statSync(directory).mode & 0o777, 0o700)
      for (const name of readdirSync(directory)) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('rotation enforces size, retention affects only owned new log filenames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'secure-log-test-'))
  try {
    const old = 'ai-2020-01-01T00-00-00-000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.log'
    for (const name of [old, 'legacy.log']) { writeFileSync(join(directory, name), 'old'); utimesSync(join(directory, name), new Date('2020-01-01'), new Date('2020-01-01')) }
    const writer = privateLogWriter(directory, { service: 'test', maxBytes: 20 })
    writer.write('first line\nsecond line\nthird line\n'); writer.close()
    const names = readdirSync(directory)
    assert.ok(!names.includes(old)); assert.ok(names.includes('legacy.log'))
    assert.equal(names.filter(name => name.startsWith('test-')).length, 3)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
test('unstructured api keys and complete request configurations are dropped', () => {
  for (const line of ['apiKey=synthetic', 'request: { url: private }', 'config = full configuration', 'JWT credential'])
    assert.equal(safeLogLine(line), '[已脱敏：敏感日志记录]')
})
