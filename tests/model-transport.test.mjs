import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as netServer } from 'node:net'
import { createServer as tlsServer } from 'node:tls'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createModelTransport, MODEL_TRANSPORT_OPTIONS } from '../apps/api/src/operations/model-transport.mjs'

test('model-only transport retains caller cancellation, refuses redirects/different origins and sends once', async () => {
  const calls = [], signal = AbortSignal.timeout(1000)
  const transport = createModelTransport({ fetcher: async (...args) => { calls.push(args); throw Object.assign(Error('fixture'), { cause: { code: 'ECONNRESET' } }) } })
  try {
    await assert.rejects(transport.fetch('https://app.4yi.ai/api/v1/chat/completions', { method: 'POST', body: 'fixture-body', signal }), /fixture/)
    assert.equal(calls.length, 1); assert.equal(calls[0][1].signal, signal); assert.equal(calls[0][1].redirect, 'error')
    assert.equal(calls[0][1].body, 'fixture-body'); assert.ok(calls[0][1].dispatcher)
    for (const url of ['http://app.4yi.ai/api/v1/models', 'https://example.com/', 'https://user:password@app.4yi.ai/api/v1/models']) assert.throws(() => transport.fetch(url), /not allowed/)
    assert.equal(calls.length, 1)
    assert.equal(MODEL_TRANSPORT_OPTIONS.connectTimeout, 30000)
    assert.equal(MODEL_TRANSPORT_OPTIONS.autoSelectFamily, true)
  } finally { await transport.close() }
})

test('real delayed TLS handshake fails at the old 10s deadline and succeeds at 30s without a duplicate HTTP request', { timeout: 35000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-connect-'))
  let server, secure, received = 0
  const sockets = new Set(), timers = new Set(), clients = []
  try {
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')], { stdio: 'ignore' })
    const key = await readFile(join(dir,'key.pem')), cert = await readFile(join(dir,'cert.pem'))
    secure = tlsServer({ key, cert }, socket => {
      socket.once('data', () => { received++; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK') })
      socket.on('error', () => {})
    })
    secure.on('tlsClientError', () => {})
    server = netServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
      const timer = setTimeout(() => { timers.delete(timer); if (!socket.destroyed) secure.emit('connection', socket) }, 11200)
      timers.add(timer)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const origin = `https://localhost:${server.address().port}`
    const old = createModelTransport({ origin, agentOptions: { connectTimeout: 10000, connect: { ca: cert } } })
    const fixed = createModelTransport({ origin, agentOptions: { connect: { ca: cert } } }); clients.push(old, fixed)
    const results = await Promise.allSettled([
      old.fetch(origin, { method: 'POST', body: 'old', signal: AbortSignal.timeout(30000) }),
      fixed.fetch(origin, { method: 'POST', body: 'fixed', signal: AbortSignal.timeout(30000) }).then(r => r.text()),
    ])
    assert.equal(results[0].status, 'rejected'); assert.equal(results[0].reason.cause?.code, 'UND_ERR_CONNECT_TIMEOUT')
    assert.deepEqual(results[1], { status: 'fulfilled', value: 'OK' })
    assert.equal(received, 1, 'only the established connection may transmit a model request')
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets) socket.destroy()
    await Promise.all(clients.map(c => c.close()))
    if (server) await new Promise(r => server.close(r))
    secure?.close(); await rm(dir, { recursive: true, force: true })
  }
})
