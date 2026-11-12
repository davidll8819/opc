import { readFile } from 'node:fs/promises'
import { validatePrivateAccess } from './private-access.mjs'
import { makePool } from './db.mjs'
import { connectCache } from './cache.mjs'
import { awsAgents } from './agents.mjs'
import { buildApp } from './app.mjs'
import { assertProductionEnvironment, assertRestrictedDatabaseRole } from './startup-checks.mjs'
import { fouryiEnvironment } from './fouryi-identity.mjs'
const environment = fouryiEnvironment(process.env)
await assertProductionEnvironment(environment)
const pool = await makePool()
if (process.env.NODE_ENV === 'production') await assertRestrictedDatabaseRole(pool)
const cache = await connectCache(process.env.REDIS_URL)
let privateConfig = {}
if (process.env.AUTH_MODE === 'local' && process.env.NODE_ENV !== 'production') {
  try {
    const saved = validatePrivateAccess(JSON.parse(await readFile(new URL('../../../.local/private-access.json', import.meta.url), 'utf8')))
    privateConfig = { PRIVATE_APP_ORIGIN: saved.origin, PRIVATE_TAILSCALE_LOGIN: saved.login }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const app = await buildApp({ pool, cache, agents: awsAgents(environment), env: { ...environment, ...privateConfig } })
await app.listen({
  port: Number(process.env.PORT || 3000),
  host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1',
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    await cache.quit()
    process.exit(0)
  })
