// The bundled upstream CLI exposes configuration, logs and preset management.
// Gate requests before its HTTP handler runs; only model endpoints are allowed.
import { timingSafeEqual } from 'node:crypto'
import { Server } from 'node:http'
import { routerApiKey } from '../../../router-security.config'

const expected = Buffer.from(routerApiKey())
const emit = Server.prototype.emit
Server.prototype.emit = function (event: string, ...args: any[]) {
  if (event === 'request') {
    const [request, response] = args
    const supplied = request.headers['x-api-key'] || request.headers.authorization?.replace(/^Bearer /i, '') || ''
    const value = Buffer.from(typeof supplied === 'string' ? supplied : '')
    const authenticated = value.length === expected.length && timingSafeEqual(value, expected)
    const allowed = request.method === 'POST'
      && ['/v1/messages', '/v1/messages/count_tokens'].includes(request.url.split('?')[0])
    if (!authenticated || !allowed) {
      response.writeHead(authenticated ? 403 : 401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: authenticated ? 'Management endpoints disabled' : 'Unauthorized' }))
      return true
    }
  }
  return emit.call(this, event, ...args)
}
