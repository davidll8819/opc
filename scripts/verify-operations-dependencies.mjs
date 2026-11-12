// Exercises actual installed packages with synthetic data; no provider calls.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const root = resolve('integrations/aitoearn/source/project/aitoearn-backend')
const ai = createRequire(join(root, 'apps/aitoearn-ai/package.json'))
async function main() {
  const sharp = ai('sharp')
  const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#336699' } }).resize(4, 4).png().toBuffer()
  const metadata = await sharp(image).metadata()
  assert.equal(metadata.width, 4); assert.equal(metadata.height, 4)
  console.log('sharp: actual image encoding/resize/decode PASS')
  const volcano = createRequire(ai.resolve('@volcengine/openapi'))
  const protobuf = volcano('protobufjs')
  const message = protobuf.Root.fromJSON({ nested: { Test: { fields: { label: { type: 'string', id: 1 } } } } }).lookupType('Test')
  assert.equal(message.decode(message.encode({ label: 'synthetic' }).finish()).label, 'synthetic')
  assert.match(volcano('uuid').v4(), /^[a-f0-9-]{36}$/)
  console.log('Volcengine protobuf and UUID dependencies: round-trip PASS')
  const serverRequire = createRequire(join(root, 'apps/aitoearn-server/package.json'))
  const { XMLParser, XMLBuilder } = serverRequire('fast-xml-parser')
  assert.equal(new XMLParser().parse(new XMLBuilder().build({ message: { text: '中文 & <tag>' } })).message.text, '中文 & <tag>')
  console.log('XML builder/parser: escaped round-trip PASS')
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') })
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  try {
    const url = `http://127.0.0.1:${server.address().port}/`
    for (const library of [ai('axios'), volcano('axios')]) {
      const response = await library.get(url, { proxy: false, timeout: 5000 })
      assert.equal(response.data.ok, true)
    }
    console.log('current and legacy HTTP clients: local request PASS')
  } finally { await new Promise(ok => server.close(ok)) }
  const directory = await mkdtemp(join(tmpdir(), 'nyc-security-check-'))
  try {
    await writeFile(join(directory, '.nycrc.yml'), 'all: true\ninclude:\n  - src/**/*.ts\n')
    const nyc = ai(join(root, 'node_modules/.pnpm/@istanbuljs+load-nyc-config@1.1.0/node_modules/@istanbuljs/load-nyc-config'))
    const config = await nyc.loadNycConfig({ cwd: directory })
    assert.equal(config.all, true); assert.deepEqual(config.include, ['src/**/*.ts'])
    console.log('coverage YAML loader after legacy dependency removal: PASS')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
main().catch(error => { console.error('Dependency verification failed:', error.code || error.name); process.exitCode = 1 })
