// Add columns to the existing employee table; no new table/role grants and no profile changes.
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
 const before=await snapshot()
 await transaction(pool,async db=>{
  await db.query('SELECT pg_advisory_xact_lock(51011001)')
  if(!(await db.query('SELECT name FROM schema_migrations WHERE name=$1',['031_staff_skills.sql'])).rows.length)throw new Error('Migration 031 required first')
  if(!(await db.query('SELECT name FROM schema_migrations WHERE name=$1',['032_employee_role_settings.sql'])).rows.length){
   await db.query(await readFile(new URL('../database/migrations/032_employee_role_settings.sql',import.meta.url),'utf8'))
   await db.query('INSERT INTO schema_migrations(name) VALUES($1)',['032_employee_role_settings.sql'])
  }
 })
 const after=await snapshot()
 const unchanged=Object.fromEntries(Object.keys(before).map(key=>[key,before[key]===after[key]]))
 await mkdir('.local/verification',{recursive:true,mode:0o700})
 await writeFile('.local/verification/employee-role-migration.json',JSON.stringify({unchanged,checkedAt:new Date().toISOString()}),{mode:0o600})
 console.log(JSON.stringify({migration:'032 applied; no new privileges',unchanged}))
 const activeTasks=(await pool.query("SELECT count(*)::int n FROM task_jobs WHERE state='running' AND lease_until>now()")).rows[0].n
 const pendingRequests=(await pool.query("SELECT count(*)::int n FROM model_requests WHERE state='pending' AND created_at>now()-interval '10 minutes'")).rows[0].n
 console.log(JSON.stringify({activeTasks,pendingRequests,restartSafe:activeTasks===0&&pendingRequests===0}))
}catch(e){console.error('Activation failed:',e.code||e.message);process.exitCode=1}finally{await pool.end()}
