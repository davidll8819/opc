import { SignJWT } from 'jose'
import { runtimeUserId } from '../../apps/api/src/personal-key.mjs'
export function personalToken(secret,tenant,user) {
 return new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(runtimeUserId(tenant,user)).setIssuer(tenant).setAudience('wishtaday-personal-model').setExpirationTime('5m').sign(new TextEncoder().encode(secret))
}
