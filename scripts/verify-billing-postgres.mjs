// Creates and removes only a uniquely named temporary local database.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { settings, pgClient, pgEnvironment } from './backup/common.mjs'
import { migrate } from '../database/migrate.mjs'
import { beginBilling, finishBilling } from '../apps/api/src/billing.mjs'
await settings()
const admin = await pgClient(), name = `billing_test_${randomUUID().replaceAll('-', '')}`
let pool, created = false
try {
  await admin.query(`CREATE DATABASE "${name}"`)
  created = true
  const env = pgEnvironment(name)
  pool = new pg.Pool({host:env.PGHOST,port:Number(env.PGPORT||5432),user:env.PGUSER,password:env.PGPASSWORD,database:name,max:8})
  await migrate(pool)
  const tenantId=randomUUID(),userId=randomUUID(),other=randomUUID(),ctx={tenantId,userId}
  await pool.query("INSERT INTO users(id,subject,email) VALUES($1,$2,'billing-test@example.invalid')",[userId,userId])
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Temporary billing verification'),($2,'Other temporary tenant')",[tenantId,other])
  await pool.query('INSERT INTO billing_prices(id,tenant_id,model,input_microusd,output_microusd,sale_input_microusd,sale_output_microusd,reference,created_by) VALUES($1,$2,$3,1000000,2000000,2000000,3000000,$4,$5)',[randomUUID(),tenantId,'test-model','synthetic-contract',userId])
  await pool.query('INSERT INTO billing_limits(tenant_id,enabled,daily_microusd) VALUES($1,true,250)',[tenantId])
  const outcomes=await Promise.allSettled(Array.from({length:6},()=>beginBilling(pool,ctx,{model:'test-model',department:'archive',input:100,output:50})))
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.statusCode===429).length,5)
  const id=outcomes.find(r=>r.status==='fulfilled').value
  await Promise.all(Array.from({length:6},()=>finishBilling(pool,ctx,id,'completed',{input:100,output:50},'synthetic-receipt')))
  const row=(await pool.query('SELECT count(*)::int n,sum(cost_microusd)::text cost FROM billing_calls WHERE tenant_id=$1',[tenantId])).rows[0]
  assert.equal(row.n,1);assert.equal(row.cost,'200')
  await pool.query('GRANT USAGE ON SCHEMA public TO office_app')
  await pool.query('GRANT SELECT ON billing_calls TO office_app')
  const db=await pool.connect()
  try {
    await db.query('BEGIN');await db.query('SET LOCAL ROLE office_app')
    await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[other,userId])
    assert.equal((await db.query('SELECT count(*)::int n FROM billing_calls')).rows[0].n,0)
    await db.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId])
    assert.equal((await db.query('SELECT count(*)::int n FROM billing_calls')).rows[0].n,1)
    await db.query('ROLLBACK')
  } finally {db.release()}
  console.log(JSON.stringify({temporaryPostgres:true,parallelRequests:6,accepted:1,blocked:5,duplicateSettlements:6,settledOnce:true,rowLevelIsolation:true,paidModelCalls:0}))
} finally {
  await pool?.end()
  if(created)await admin.query(`DROP DATABASE "${name}"`)
  await admin.end()
  console.log('Temporary database removed; existing databases preserved')
}
