// Local-only activation, to be run after explicit approval of the five table grants.
// Does not edit model settings, assignments, accounts, task boards or existing files.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { makePool, transaction } from '../apps/api/src/db.mjs'
process.loadEnvFile('.env')
const app = await makePool()
const admin = await makePool({ ...process.env, DATABASE_URL: '', PGUSER: 'office_admin', PGPASSWORD: process.env.LOCAL_DB_PASSWORD })
const tables = ['employee_duty', 'employee_work_leases', 'skill_studio', 'skill_studio_versions', 'skill_studio_runs']
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex')
async function snapshot() {
  return {
    modelSettings: digest((await admin.query('SELECT tenant_id,encrypted_config,revision FROM operations_settings ORDER BY tenant_id')).rows),
    bindings: digest((await admin.query('SELECT * FROM skill_assignments ORDER BY tenant_id,department,skill_id')).rows),
    taskBoards: digest((await admin.query('SELECT tenant_id,user_id,revision,board FROM secretary_workspaces ORDER BY tenant_id,user_id')).rows),
    files: (await admin.query('SELECT count(*)::int n FROM workspace_files')).rows[0].n,
  }
}
try {
  const role = (await app.query('SELECT current_user name')).rows[0].name
  if (role !== 'office_app') throw new Error('Unexpected application role; stop and review')
  const before = await snapshot()
  const migration = await readFile(new URL('../database/migrations/031_staff_skills.sql', import.meta.url), 'utf8')
  await transaction(admin, async db => {
    await db.query('SELECT pg_advisory_xact_lock(51011001)')
    const exists = (await db.query('SELECT name FROM schema_migrations WHERE name=$1', ['031_staff_skills.sql'])).rows.length
    if (!exists) {
      await db.query(migration)
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', ['031_staff_skills.sql'])
    }
    for (const table of tables) await db.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO office_app`)
  })
  const after = await snapshot()
  const unchanged = Object.fromEntries(Object.keys(before).map(key => [key, before[key] === after[key]]))
  await mkdir('.local/verification', { recursive: true, mode: 0o700 })
  await writeFile('.local/verification/staff-migration-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), unchanged }), { mode: 0o600 })
  console.log('Migration 031 applied atomically; five new tables granted to office_app with tenant RLS.')
  console.log(JSON.stringify({ unchanged }))
  const activeTasks = (await admin.query("SELECT count(*)::int n FROM task_jobs WHERE state='running' AND lease_until>now()")).rows[0].n
  const pendingRequests = (await admin.query("SELECT count(*)::int n FROM model_requests WHERE state='pending' AND created_at>now()-interval '10 minutes'")).rows[0].n
  console.log(JSON.stringify({ activeTasks, pendingRequests, restartSafe: activeTasks === 0 && pendingRequests === 0 }))
} catch (error) {
  console.error('Activation stopped:', error.code || error.message)
  process.exitCode = 1
} finally { await app.end(); await admin.end() }
