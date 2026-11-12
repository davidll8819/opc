import { EMPLOYEES } from '../../../packages/employees/registry.mjs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { fail } from './db.mjs'
export async function employeeDirectory(db,tenantId) {
 const rows=(await db.query('SELECT id,name,avatar_id FROM custom_employees WHERE tenant_id=$1 ORDER BY created_at,id',[tenantId])).rows
 return [...EMPLOYEES,...rows.map((r,index)=>({id:r.id,name:r.name,avatarId:r.avatar_id,color:EMPLOYEES.find(e=>e.id===r.avatar_id)?.color||0x78946a,departmentKey:r.id,department:'自定义岗位',departmentEn:'Custom role',responsibility:'根据已配置的岗位能力完成任务',role:'employee',rosterNo:EMPLOYEES.length+index+1,custom:true}))]
}
export async function findEmployee(db,tenantId,id) {
 const item=(await employeeDirectory(db,tenantId)).find(e=>e.id===id||e.departmentKey===id)
 if(!item)throw fail(404,'员工不存在于当前工作空间')
 return item
}
export function registerCustomEmployees(app,{scoped}) {
 app.post('/api/tenants/:tenantId/employees',req=>scoped(req,async(db,tenant,ctx)=>{
  const input=z.object({name:z.string().trim().min(1).max(40),avatarId:z.enum(EMPLOYEES.map(e=>e.id)),departmentId:z.string().min(1).max(80),jobTitle:z.string().trim().min(1).max(60),capabilities:z.string().trim().min(1).max(4000)}).strict().parse(req.body)
  await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId])
  const people=await employeeDirectory(db,ctx.tenantId)
  if(people.length>=113)throw fail(409,'自建员工最多 100 位，请先使用已有员工')
  if(people.some(e=>e.name===input.name))throw fail(409,'这个工作空间已有同名员工，请换一个名字')
  const org=(await db.query('SELECT departments FROM organization_settings WHERE tenant_id=$1',[ctx.tenantId])).rows[0]
  const ids=org?org.departments.map(d=>d.id):EMPLOYEES.filter(e=>!e.modelDepartment).map(e=>e.departmentKey)
  if(!ids.includes(input.departmentId))throw fail(404,'部门不属于当前工作空间')
  const id=`custom_${randomUUID().replaceAll('-','')}`
  await db.query('INSERT INTO custom_employees(tenant_id,id,name,avatar_id) VALUES($1,$2,$3,$4)',[ctx.tenantId,id,input.name,input.avatarId])
  await db.query("INSERT INTO employee_duty(tenant_id,employee_id,seat,job_title,capabilities,profile_revision,organization_department,job_id) VALUES($1,$2,NULL,$3,$4,1,$5,'')",[ctx.tenantId,id,input.jobTitle,input.capabilities,input.departmentId])
  await db.query('INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.tenantId,ctx.userId,'employee.created',id])
  return {id,name:input.name,departmentKey:id,custom:true}
 },['owner','admin']))
}
