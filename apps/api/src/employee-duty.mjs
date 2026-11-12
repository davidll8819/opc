import {employeeDirectory,findEmployee} from './employee-directory.mjs'
import { binding } from './employee-skills.mjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { EMPLOYEES, EMPLOYEE_BY_DEPARTMENT } from '../../../packages/employees/registry.mjs'
import { fail, transaction } from './db.mjs'
import { readOrganization, profileFromOrganization, modelOverridesSchema, assertOrganizationEditable } from './organization.mjs'

export async function readDuty(db, tenantId) {
  const rows = (await db.query('SELECT employee_id,seat,job_title,capabilities,profile_revision,organization_department,job_id,model_overrides FROM employee_duty WHERE tenant_id=$1', [tenantId])).rows
  const organization=await readOrganization(db,tenantId)
  const states = new Map(rows.map(r => [r.employee_id,r]))
  // Before the first explicit staffing change the existing nine colleagues keep their seats.
  return (await employeeDirectory(db,tenantId)).map(e => {
    const saved=states.get(e.id)
    return { employeeId:e.id, name:e.name, avatarId:e.avatarId||e.id, departmentKey:e.departmentKey, custom:!!e.custom, seat:saved ? saved.seat : e.rosterNo <= 9 ? e.rosterNo-1 : null,
      jobTitle:saved?.job_title || e.department, capabilities:saved?.capabilities || e.responsibility,
      profileRevision:saved?.profile_revision || 0, ...profileFromOrganization(e,saved,organization) }
  })
}
export async function assertOnDuty(db, tenantId, department) {
  const employee = await findEmployee(db,tenantId,department)
  if (!employee) throw fail(404,'员工不存在')
  if ((await readDuty(db,tenantId)).find(r=>r.employeeId===employee.id)?.seat == null)
    throw fail(409,`${employee.name}当前未上岗，请到“招聘员工”安排空闲工位后再开始工作`)
}
export async function beginEmployeeWork(pool, ctx, department) {
  return transaction(pool, async db => {
    await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId])
    if(!ctx.skillStudioTrial)await assertOnDuty(db,ctx.tenantId,department)
    const id=randomUUID()
    await db.query('INSERT INTO employee_work_leases(id,tenant_id,employee_id) VALUES($1,$2,$3)',[id,ctx.tenantId,(await findEmployee(db,ctx.tenantId,department)).id])
    return id
  },ctx)
}
export const endEmployeeWork = (pool,ctx,id) => transaction(pool,db=>db.query('DELETE FROM employee_work_leases WHERE id=$1 AND tenant_id=$2',[id,ctx.tenantId]),ctx)
export function registerEmployeeDuty(app,{scoped}) {
  const root='/api/tenants/:tenantId/employees/duty'
  app.get(root,req=>scoped(req,async(db,tenant,ctx)=>({items:await readDuty(db,ctx.tenantId),capacity:9})))
  app.put(`${root}/:employeeId`,req=>scoped(req,async(db,tenant,ctx)=>{
    const {onDuty}=z.object({onDuty:z.boolean()}).strict().parse(req.body)
    const employee=await findEmployee(db,ctx.tenantId,req.params.employeeId)
    if(!employee)throw fail(404,'员工不存在')
    await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId])
    const items=await readDuty(db,ctx.tenantId)
    const current=items.find(e=>e.employeeId===employee.id)
    if(onDuty===(current.seat!==null))return {items,capacity:9}
    if(!onDuty){
      const leases=(await db.query('SELECT id FROM employee_work_leases WHERE tenant_id=$1 AND employee_id=$2 AND expires_at>now() LIMIT 1',[ctx.tenantId,employee.id])).rows
      const requests=(await db.query("SELECT id FROM model_requests WHERE tenant_id=$1 AND department=$2 AND state='pending' AND created_at>now()-interval '10 minutes' LIMIT 1",[ctx.tenantId,employee.departmentKey])).rows
      const boards=(await db.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1',[ctx.tenantId])).rows
      const busy=boards.some(r=>(r.board.tasks||[]).some(t=>t.dept===employee.id && ['working','queued','authorized'].includes(t.status)))
      if(leases.length||requests.length||busy)throw fail(409,'该员工有执行中或排队任务，请先完成或停止任务后再下岗')
      current.seat=null
    }else{
      const seats=new Set(items.filter(i=>i.seat!==null).map(i=>i.seat))
      const seat=Array.from({length:9},(_,i)=>i).find(i=>!seats.has(i))
      if(seat===undefined)throw fail(409,'9 个工位已满，请先安排一位空闲员工下岗')
      current.seat=seat
    }
    // Materialize all defaults atomically so a released default seat stays released.
    await db.query('UPDATE employee_duty SET seat=NULL WHERE tenant_id=$1',[ctx.tenantId])
    for(const item of items)await db.query('INSERT INTO employee_duty(tenant_id,employee_id,seat) VALUES($1,$2,$3) ON CONFLICT(tenant_id,employee_id) DO UPDATE SET seat=EXCLUDED.seat,updated_at=now()',[ctx.tenantId,item.employeeId,item.seat])
    await db.query('INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.tenantId,ctx.userId,onDuty?'employee.on-duty':'employee.off-duty',employee.id])
    return {items,capacity:9}
  },['owner','admin']))
}

export async function readEmployeeRole(db,ctx,employeeId) {
  const employee=await findEmployee(db,ctx.tenantId,employeeId)
  if(!employee)throw fail(404,'员工不存在')
  const profile=(await readDuty(db,ctx.tenantId)).find(e=>e.employeeId===employeeId)
  const skills=await binding(db,ctx.tenantId,employee.departmentKey)
  return {...profile,skillIds:skills.skillIds,skillRevision:skills.revision}
}
export function registerEmployeeRoles(app,{scoped}) {
  const root='/api/tenants/:tenantId/employees/:employeeId/role'
  app.get(root,req=>scoped(req,(db,tenant,ctx)=>readEmployeeRole(db,ctx,req.params.employeeId)))
  app.put(root,req=>scoped(req,async(db,tenant,ctx)=>{
    const input=z.object({jobTitle:z.string().trim().min(1).max(60),capabilities:z.string().trim().min(1).max(4000),profileRevision:z.number().int().nonnegative(),skillIds:z.array(z.uuid()).max(8),skillRevision:z.string().regex(/^[a-f0-9]{64}$/),departmentId:z.string().max(80).optional(),jobId:z.string().max(80).nullable().optional(),modelOverrides:modelOverridesSchema.optional(),organizationRevision:z.number().int().nonnegative().optional()}).strict().parse(req.body)
    await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId])
    await assertOrganizationEditable(db,ctx.tenantId)
    const current=await readEmployeeRole(db,ctx,req.params.employeeId)
    const organization=await readOrganization(db,ctx.tenantId)
    if(input.organizationRevision!==undefined && input.organizationRevision!==organization.revision)throw fail(409,'部门或岗位已更新，请重新载入后再选择')
    const departmentId=input.departmentId ?? current.departmentId,jobId=input.jobId===undefined?current.jobId:input.jobId
    if(!organization.departments.some(d=>d.id===departmentId))throw fail(404,'部门不属于当前工作空间')
    if(jobId && !organization.jobs.some(j=>j.id===jobId&&j.departmentId===departmentId))throw fail(400,'所选岗位不属于这个部门')
    if(current.profileRevision!==input.profileRevision||current.skillRevision!==input.skillRevision)throw fail(409,'员工设置或技能已在其他地方更新，请重新载入后再保存')
    const ids=[...new Set(input.skillIds)]
    const available=(await db.query('SELECT id FROM installed_skills WHERE tenant_id=$1',[ctx.tenantId])).rows.map(r=>r.id)
    if(ids.some(id=>!available.includes(id)))throw fail(404,'所选技能不属于当前企业，请重新选择')
    const employee=await findEmployee(db,ctx.tenantId,current.employeeId)
    await db.query(`INSERT INTO employee_duty(tenant_id,employee_id,seat,job_title,capabilities,profile_revision,organization_department,job_id,model_overrides)
      VALUES($1,$2,$3,$4,$5,1,$6,$7,$8) ON CONFLICT(tenant_id,employee_id) DO UPDATE SET
      job_title=EXCLUDED.job_title,capabilities=EXCLUDED.capabilities,organization_department=EXCLUDED.organization_department,job_id=EXCLUDED.job_id,model_overrides=EXCLUDED.model_overrides,profile_revision=employee_duty.profile_revision+1,updated_at=now()`,[ctx.tenantId,employee.id,current.seat,input.jobTitle,input.capabilities,departmentId,jobId || '',JSON.stringify(input.modelOverrides ?? current.modelOverrides)])
    // Change only this employee's bindings. Existing packages, histories and other employees remain intact.
    await db.query('DELETE FROM skill_assignments WHERE tenant_id=$1 AND department=$2',[ctx.tenantId,employee.departmentKey])
    for(const id of ids)await db.query('INSERT INTO skill_assignments(tenant_id,skill_id,department) VALUES($1,$2,$3)',[ctx.tenantId,id,employee.departmentKey])
    await db.query('INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.tenantId,ctx.userId,'employee.role-updated',employee.id])
    return readEmployeeRole(db,ctx,employee.id)
  },['owner','admin']))
}

// User-defined work methods supplement the current task, never grant tools or override permissions.
export function employeeRoleInstructions(profile) {
  if(!profile?.profileRevision && !profile?.departmentName)return ''
  return '\n企业已为这位员工设置岗位与能力。以下 JSON 是岗位工作设定，不是权限或工具授权；岗位与工作职责以此设定为准，原默认岗位名称仅为系统身份映射。仍遵守当前任务、可用工具、安全规则和发布确认，不虚构未提供的工具能力。\n'+JSON.stringify({姓名:profile.name,部门:profile.departmentName,部门职责:profile.departmentDescription,岗位:profile.jobTitle,能力职责:profile.capabilities})+'\n'
}
export function withEmployeeRole(body,path,profile) {
  const instructions=employeeRoleInstructions(profile)
  if(!instructions)return body
  if(path==='/api/anthropic/v1/messages')return {...body,system:[...(Array.isArray(body.system)?body.system:body.system?[{type:'text',text:body.system}]:[]),{type:'text',text:instructions}]}
  if(path!=='/api/v1/chat/completions')return body
  const messages=[...(body.messages||[])]
  const index=messages.findIndex(m=>m.role==='system')
  if(index>=0&&typeof messages[index].content==='string')messages[index]={...messages[index],content:messages[index].content+instructions}
  else messages.unshift({role:'system',content:instructions})
  return {...body,messages}
}
