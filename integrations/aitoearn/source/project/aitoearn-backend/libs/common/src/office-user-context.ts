import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac } from 'node:crypto'
import type { OfficeBridgeConfig } from './office-bridge'

export const officeUserContext = new AsyncLocalStorage<string>()

/** A signed internal identity, never a provider API key. No process-wide credential mutation. */
export function officeModelToken(config: OfficeBridgeConfig, userId = officeUserContext.getStore()): string {
  if (!userId || !/^[a-f0-9]{24}$/.test(userId))
    throw new Error('Personal Office identity is required for model access')
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub: userId, iss: config.tenantId, aud: 'wishtaday-personal-model', exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url')
  const signature = createHmac('sha256', config.secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}
