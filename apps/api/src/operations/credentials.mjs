import { personalCredential } from '../personal-key.mjs'
import { configKey, decryptConfig } from './security.mjs'
import { tenantSecrets } from './policy.mjs'
// Legacy workspace settings remain server-side. loadSecrets always replaces AI credentials
// with this user's personal credential, including an empty value when none is saved.
export function resolveSecrets(value, env, tenantId) {
  const fallback = tenantSecrets(env,tenantId)
  return { ai: value?.credentials?.ai || value?.aiKey || fallback.ai, relay: value?.credentials?.relay || value?.relayKey || fallback.relay }
}
export async function loadSecrets(db,env,tenantId,userId) {
  const row = (await db.query('SELECT encrypted_config FROM operations_settings WHERE tenant_id=$1',[tenantId])).rows[0]
  const value = row ? decryptConfig(row.encrypted_config,await configKey(env),tenantId) : null
  return {...resolveSecrets(value,env,tenantId),...await personalCredential(db,env,{tenantId,userId})}
}
