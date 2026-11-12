import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// Execute the actual component's send handler, with delayed network completion
// and React's functional state update semantics. No live conversation is written.
const source = await readFile(new URL('../src/saas/secretary/SecretaryWorkspace.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  async function send() {')
const end = source.indexOf('\n  const quick =', start)
assert.ok(start > 0 && end > start)
const create = new Function('input', 'act', 'setInput', `
const busy=false, uploading=false, editable=true, loading=false, online=true;
const attachments=[], intent='plan', language='zh';
const isOperationsNavigation=()=>false, handToOperations=()=>{};
const setAttachments=()=>{}, setIntent=()=>{};
${source.slice(start, end)}
return send;
`)
function delayedSend(initial) {
  let value = initial, resolve
  const response = new Promise(done => { resolve = done })
  const calls = []
  const send = create(initial, action => { calls.push(action); return response }, update => { value = typeof update === 'function' ? update(value) : update })
  return { pending: send(), calls, resolve, type(text) { value = text }, read() { return value } }
}
test('delayed successful reply preserves a newly typed secretary draft', async () => {
  const h = delayedSend('  第一条请求  ')
  assert.equal(h.calls[0].text, '第一条请求')
  h.type('正在等待时写的第二条：中文 & <draft>')
  h.resolve(true); await h.pending
  assert.equal(h.read(), '正在等待时写的第二条：中文 & <draft>')
})
test('delayed success clears only the unchanged original draft', async () => {
  const h = delayedSend('  原消息  ')
  h.resolve(true); await h.pending
  assert.equal(h.read(), '')
})
test('failed reply keeps the original or edited draft', async () => {
  for (const replacement of [undefined, '修改后的草稿']) {
    const h = delayedSend('原消息')
    if (replacement) h.type(replacement)
    h.resolve(false); await h.pending
    assert.equal(h.read(), replacement || '原消息')
  }
})
