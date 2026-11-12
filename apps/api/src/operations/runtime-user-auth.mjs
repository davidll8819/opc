import { jwtVerify } from 'jose'
import { transaction,fail } from '../db.mjs'
export async function runtimeUserContext(pool,entry,authorization) {
 let payload
 try{({payload}=await jwtVerify(String(authorization||'').replace(/^Bearer /,''),new TextEncoder().encode(entry.bridgeSecret),{algorithms:['HS256'],audience:'wishtaday-personal-model',issuer:entry.tenantId}))}catch{throw fail(403,'模型请求缺少有效的用户身份')}
 if(typeof payload.sub!=='string'||!/^[a-f0-9]{24}$/.test(payload.sub))throw fail(403,'运行用户身份无效')
 const identity=await transaction(pool,async db=>(await db.query('SELECT r.user_id FROM runtime_identities r JOIN memberships m ON m.tenant_id=r.tenant_id AND m.user_id=r.user_id WHERE r.tenant_id=$1 AND r.runtime_user_id=$2',[entry.tenantId,payload.sub])).rows[0],{tenantId:entry.tenantId,userId:''})
 if(!identity)throw fail(403,'运行用户未连接个人 Key')
 return {tenantId:entry.tenantId,userId:identity.user_id}
}
