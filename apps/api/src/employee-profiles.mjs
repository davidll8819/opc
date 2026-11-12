import {employeeDirectory} from './employee-directory.mjs'
import { readDuty, employeeRoleInstructions } from './employee-duty.mjs'
import { EMPLOYEES, EMPLOYEE_BY_DEPARTMENT, departmentChatInstructions, modelDepartment } from '../../../packages/employees/registry.mjs'
import { loadPolicy } from './operations/gateway.mjs'
import { loadSecrets } from './operations/credentials.mjs'
import { defaultCapabilities, resolveCapability } from './operations/policy.mjs'

export function employeeModels(policy, department, credentialConfigured) {
  const configuration = policy?.departments[department] || policy?.departments[modelDepartment(department)]
  return Object.fromEntries(
    ['text', 'search', 'image', 'video'].map((kind) => {
      const slot =
        kind === 'text'
          ? configuration
          : (configuration?.capabilities || defaultCapabilities(modelDepartment(department)))[kind]
      const enabled = Boolean(configuration?.enabled && slot?.enabled)
      let model = '',
        fallback = ''
      if (enabled) {
        try {
          ;({ model, fallback } = resolveCapability(policy, department, kind))
        } catch (error) {
          if (error.statusCode !== 409) throw error
        }
      }
      return [
        kind,
        {
          enabled,
          configured: Boolean(enabled && model && credentialConfigured),
          model,
          fallback,
          source: policy?.employeeProfiles?.[(EMPLOYEE_BY_DEPARTMENT[department]?.id || department)]?.modelOverrides?.[kind] ? 'employee' : slot?.model ? 'department' : 'company',
        },
      ]
    }),
  )
}

export function registerEmployeeProfiles(app, { scoped, env }) {
  app.get('/api/tenants/:tenantId/employees', (req) =>
    scoped(req, async (db, tenant, ctx) => {
      let policy,
        credentialConfigured = false
      try {
        policy = (await loadPolicy(db, ctx.tenantId, env)).policy
        credentialConfigured = Boolean((await loadSecrets(db, env, ctx.tenantId, ctx.userId)).ai)
      } catch (error) {
        if (error.statusCode !== 409) throw error
      }
      const assignments = (
        await db.query(
          'SELECT a.department,s.id,s.name,s.version FROM skill_assignments a JOIN installed_skills s ON s.tenant_id=a.tenant_id AND s.id=a.skill_id WHERE a.tenant_id=$1 ORDER BY s.name,s.id',
          [ctx.tenantId],
        )
      ).rows
      const duty = await readDuty(db,ctx.tenantId)
      return {
        employees: (await employeeDirectory(db,ctx.tenantId)).map((employee) => ({
          ...employee,
          department: duty.find(e=>e.employeeId===employee.id)?.jobTitle || employee.department,
          organizationDepartment: duty.find(e=>e.employeeId===employee.id)?.departmentName,
          responsibility: duty.find(e=>e.employeeId===employee.id)?.capabilities || employee.responsibility,
          chatInstructions: departmentChatInstructions(employee.departmentKey) + employeeRoleInstructions(duty.find(e=>e.employeeId===employee.id)),
          models: employeeModels(policy, employee.departmentKey, credentialConfigured),
          skills: assignments
            .filter((a) => a.department === employee.departmentKey)
            .map(({ id, name, version }) => ({ id, name, version })),
        })),
      }
    }),
  )
}
