import {employeeDirectory} from './employee-directory.mjs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { EMPLOYEES, modelDepartment, DEPARTMENT_NAMES } from '../../../packages/employees/registry.mjs'
import { fail } from './db.mjs'
import { defaultCapabilities } from './operations/policy.mjs'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const name = z.string().trim().min(1).max(60)
const description = z.string().trim().max(4000)
export const modelOverridesSchema = z.object(Object.fromEntries(['text','search','image','video'].map(k=>[k,z.string().trim().max(150).default('')]))).strict()
export const blankModels = () => ({ text:'', search:'', image:'', video:'' })
const departmentSchema = z.object({id,name,description,models:modelOverridesSchema}).strict()
const jobSchema = z.object({id,departmentId:id,name,capabilities:description}).strict()
const schema = z.object({revision:z.number().int().nonnegative(),departments:z.array(departmentSchema).min(1).max(100),jobs:z.array(jobSchema).max(300)}).strict()

export async function readOrganization(db, tenantId) {
  const saved=(await db.query('SELECT revision,departments,jobs FROM organization_settings WHERE tenant_id=$1',[tenantId])).rows[0]
  if(saved)return saved
  const roots=EMPLOYEES.filter(e=>!e.modelDepartment)
  return { revision:0,
    departments:roots.map(e=>({id:e.departmentKey,name:e.department,description:'',models:blankModels()})),
    jobs:EMPLOYEES.map(e=>({id:`job_${e.departmentKey}`,departmentId:modelDepartment(e.departmentKey),name:e.department,capabilities:e.responsibility})) }
}

export function profileFromOrganization(employee, saved, organization) {
  const departmentId=saved?.organization_department || modelDepartment(employee.departmentKey)
  const department=organization.departments.find(d=>d.id===departmentId)
  return { departmentId,departmentName:department?.name || DEPARTMENT_NAMES[departmentId] || employee.department,departmentDescription:department?.description || '',
    jobId:saved?.job_id ?? (employee.custom?'':`job_${employee.departmentKey}`),modelOverrides:{...blankModels(),...saved?.model_overrides} }
}

// Business departments are independent from stable employee/tool IDs. Nothing is written to legacy model settings.
export function organizationPolicy(policy, organization, profiles, employees=EMPLOYEES) {
  const next={...policy,departments:{...policy.departments},employeeProfiles:Object.fromEntries(profiles.map(p=>[p.employeeId,p]))}
  for(const employee of employees){
    const profile=profiles.find(p=>p.employeeId===employee.id)
    const org=organization.departments.find(d=>d.id===profile?.departmentId)
    const source=org?.id || modelDepartment(employee.departmentKey)
    const inherited=policy.departments[source] || {enabled:true,tier:'fast',skills:[],need_confirm:true,capabilities:Object.fromEntries(['search','image','video'].map(k=>[k,{enabled:!!policy.tiers[k],model:''}]))}
    const d={...inherited,capabilities:structuredClone(inherited.capabilities || defaultCapabilities(source))}
    for(const kind of ['text','search','image','video']){
      const model=profile?.modelOverrides?.[kind] || org?.models?.[kind]
      if(!model)continue
      d.enabled=true
      if(kind==='text'){ d.model=model; d.fallback=undefined }
      else d.capabilities[kind]={enabled:true,model}
    }
    next.departments[employee.departmentKey]=d
  }
  return next
}

// Keep multi-stage/video work consistent: configuration edits wait for active work to finish.
export async function assertOrganizationEditable(db, tenantId) {
  const leases=(await db.query('SELECT id FROM employee_work_leases WHERE tenant_id=$1 AND expires_at>now() LIMIT 1',[tenantId])).rows
  const jobs=(await db.query("SELECT task_id FROM task_jobs WHERE tenant_id=$1 AND state='running' AND lease_until>now() LIMIT 1",[tenantId])).rows
  const boards=(await db.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1',[tenantId])).rows
  if(leases.length || jobs.length || boards.some(r=>(r.board.tasks || []).some(t=>t.status==='working')))
    throw fail(409,'当前有员工任务正在执行，请等任务结束或停止后再保存部门与员工设置，以免中途更换工作配置')
}

export function registerOrganization(app,{scoped}) {
  const root='/api/tenants/:tenantId/organization'
  app.get(root,req=>scoped(req,(db,tenant,ctx)=>readOrganization(db,ctx.tenantId)))
  app.put(root,req=>scoped(req,async(db,tenant,ctx)=>{
    const input=schema.parse(req.body)
    await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE',[ctx.tenantId])
    await assertOrganizationEditable(db,ctx.tenantId)
    const current=await readOrganization(db,ctx.tenantId)
    if(current.revision!==input.revision)throw fail(409,'部门或岗位已被其他页面更新，请重新载入后再保存')
    for(const list of [input.departments,input.jobs])if(new Set(list.map(r=>r.id)).size!==list.length)throw fail(400,'部门或岗位编号重复')
    if(new Set(input.departments.map(d=>d.name.toLocaleLowerCase())).size!==input.departments.length)throw fail(400,'部门名称不能重复')
    if(new Set(input.jobs.map(j=>`${j.departmentId}/${j.name.toLocaleLowerCase()}`)).size!==input.jobs.length)throw fail(400,'同一部门的岗位名称不能重复')
    const departmentIds=new Set(input.departments.map(d=>d.id)),jobIds=new Set(input.jobs.map(j=>j.id))
    if(input.jobs.some(j=>!departmentIds.has(j.departmentId)))throw fail(400,'岗位必须属于当前工作空间的部门')
    const rows=(await db.query('SELECT employee_id,organization_department,job_id FROM employee_duty WHERE tenant_id=$1',[ctx.tenantId])).rows
    for(const employee of await employeeDirectory(db,ctx.tenantId)){
      const saved=rows.find(r=>r.employee_id===employee.id),profile=profileFromOrganization(employee,saved,current)
      if(!departmentIds.has(profile.departmentId))throw fail(409,'部门还有员工，请先调动员工再删除')
      if(profile.jobId && !jobIds.has(profile.jobId))throw fail(409,'岗位还有员工，请先调整员工岗位再删除')
      if(profile.jobId && input.jobs.find(j=>j.id===profile.jobId)?.departmentId!==profile.departmentId)throw fail(409,'已有员工的岗位不能直接跨部门移动，请新建岗位并调动员工')
    }
    await db.query(`INSERT INTO organization_settings(tenant_id,revision,departments,jobs) VALUES($1,1,$2,$3)
      ON CONFLICT(tenant_id) DO UPDATE SET revision=organization_settings.revision+1,departments=$2,jobs=$3,updated_at=now()`,[ctx.tenantId,JSON.stringify(input.departments),JSON.stringify(input.jobs)])
    await db.query('INSERT INTO audit_events(id,tenant_id,user_id,action) VALUES($1,$2,$3,$4)',[randomUUID(),ctx.tenantId,ctx.userId,'organization.updated'])
    return readOrganization(db,ctx.tenantId)
  },['owner','admin']))
}
