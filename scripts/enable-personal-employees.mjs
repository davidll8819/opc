// Enable personal credentials and custom employees without changing existing employee or model records.
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {makePool,transaction} from '../apps/api/src/db.mjs'
process.loadEnvFile('.env')
const pool=await makePool({...process.env,DATABASE_URL:'',PGUSER:'office_admin',PGPASSWORD:process.env.LOCAL_DB_PASSWORD})
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex')
async function snapshot(){return {
 models:digest((await pool.query('SELECT tenant_id,encrypted_config,revision FROM operations_settings ORDER BY tenant_id')).rows),
 bindings:digest((await pool.query('SELECT * FROM skill_assignments ORDER BY tenant_id,department,skill_id')).rows),
 tasks:digest((await pool.query('SELECT tenant_id,user_id,revision,board FROM secretary_workspaces ORDER BY tenant_id,user_id')).rows),
 seats:digest((await pool.query('SELECT tenant_id,employee_id,seat FROM employee_duty ORDER BY tenant_id,employee_id')).rows),
}}
try{
 const live=(await pool.query("SELECT count(*)::int n FROM task_jobs WHERE state='running' AND lease_until>now()")).rows[0].n
 const pending=(await pool.query("SELECT count(*)::int n FROM model_requests WHERE state='pending' AND created_at>now()-interval '10 minutes'")).rows[0].n
 if(live||pending)throw new Error('Active tasks exist; wait before enabling')
 const before=await snapshot()
 await transaction(pool,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(51011001)')
  if(!(await db.query('SELECT name FROM schema_migrations WHERE name=$1',['033_organization.sql'])).rows.length)throw new Error('Migration 033 required first')
  for(const name of ['034_personal_keys.sql','035_custom_employees.sql']){
   if(!(await db.query('SELECT name FROM schema_migrations WHERE name=$1',[name])).rows.length){
    await db.query(await readFile(new URL('../database/migrations/'+name,import.meta.url),'utf8'))
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name])
   }
  }
  await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON personal_model_keys,runtime_identities,personal_provider_assets,custom_employees TO office_app')
  await db.query('GRANT SELECT ON legacy_runtime_tasks TO office_app')
 })
 const after=await snapshot()
 const unchanged=Object.fromEntries(Object.keys(before).map(key=>[key,before[key]===after[key]]))
 await mkdir('.local/verification',{recursive:true,mode:0o700})
 await writeFile('.local/verification/personal-employees-migration.json',JSON.stringify({unchanged,checkedAt:new Date().toISOString()}),{mode:0o600})
 console.log(JSON.stringify({migration:'034/035 applied; four tables CRUD, historical ownership read-only; tenant/user RLS enabled',unchanged}))
 const activeTasks=(await pool.query("SELECT count(*)::int n FROM task_jobs WHERE state='running' AND lease_until>now()")).rows[0].n
 const pendingRequests=(await pool.query("SELECT count(*)::int n FROM model_requests WHERE state='pending' AND created_at>now()-interval '10 minutes'")).rows[0].n
 console.log(JSON.stringify({activeTasks,pendingRequests,restartSafe:activeTasks===0&&pendingRequests===0}))
}catch(e){console.error('Activation failed:',e.code||e.message);process.exitCode=1}finally{await pool.end()}
