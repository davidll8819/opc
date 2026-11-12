// Preloaded before application imports; captures console, Pino and raw writes.
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { privateLogWriter, secureTree } from './runtime-log-security.mjs'
const directory = process.env.OFFICE_SECURE_LOG_DIR
const service = process.env.OFFICE_LOG_SERVICE
if (!directory || !service) throw new Error('Private runtime logging configuration is required')
process.umask(0o077)
secureTree(resolve(directory, '..'))
if (process.env.OFFICE_RUNTIME_CONFIG_DIR) secureTree(process.env.OFFICE_RUNTIME_CONFIG_DIR)
for (const path of JSON.parse(process.env.OFFICE_PRIVATE_CONFIG_FILES || '[]')) secureTree(path)
secureTree(resolve(process.cwd(), '.claude-session/.claude-code-router'))
const secrets = Object.entries(process.env).filter(([key]) => /secret|token|password|api.?key/i.test(key)).map(([, value]) => value)
const outputs = []
for (const stream of [process.stdout, process.stderr]) {
  const writer = privateLogWriter(directory, { service, secrets })
  const decoder = new StringDecoder('utf8')
  outputs.push({ writer, decoder })
  stream.write = (chunk, encoding, callback) => {
    const text = Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk)
    writer.write(text)
    const done = typeof encoding === 'function' ? encoding : callback
    if (done) process.nextTick(done)
    return true
  }
}
process.on('exit', () => { for (const { writer, decoder } of outputs) { writer.write(decoder.end()); writer.close() } })
