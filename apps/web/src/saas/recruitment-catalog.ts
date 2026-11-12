import { EMPLOYEES, EMPLOYEE_BY_DEPARTMENT } from '../../../../packages/employees/registry.mjs'

export type RecruitmentCharacter = {
  id: string
  name: string
  employeeId: string | null
  department: string
  departmentEn: string
  responsibility: string
  portrait: string
  style: string
  styleEn: string
}
// Character identities are independent from employee instances. Adding a catalog entry
// must not create a colleague, allocate a desk or change an existing employee's history.
// Portraits and style descriptions come from design/characters/anime-v3-2026-11-03/manifest.json.
const characters = [
  {
    id: 'li-waner',
    name: '李婉儿',
    employeeId: 'marvis',
    reserveDepartment: null,
    style: '优雅干练',
    styleEn: 'Elegant and composed',
  },
  {
    id: 'zhao-yameng',
    name: '赵雅梦',
    employeeId: 'file-agent',
    reserveDepartment: null,
    style: '知性温柔',
    styleEn: 'Thoughtful and gentle',
  },
  {
    id: 'lin-youwei',
    name: '林幼薇',
    employeeId: 'new-agent-7',
    reserveDepartment: null,
    style: '文艺清新',
    styleEn: 'Artistic and assured',
  },
  {
    id: 'pai-aqi',
    name: '派阿奇',
    employeeId: 'data-agent',
    reserveDepartment: null,
    style: '成熟坚定',
    styleEn: 'Professional and composed',
  },
  {
    id: 'long-aotian',
    name: '龙傲天',
    employeeId: 'code-agent',
    reserveDepartment: null,
    style: '冷静技术型',
    styleEn: 'Focused and dependable',
  },
  {
    id: 'ye-fan',
    name: '叶凡',
    employeeId: 'app-agent',
    reserveDepartment: null,
    style: '时髦创作型',
    styleEn: 'Relaxed and inventive',
  },
  {
    id: 'liu-shi',
    name: '刘市',
    employeeId: 'review-agent',
    reserveDepartment: null,
    style: '知性研究型',
    styleEn: 'Analytical and thoughtful',
  },
  {
    id: 'xi-luo',
    name: '西罗',
    employeeId: 'new-agent-8',
    reserveDepartment: null,
    style: '自信商务型',
    styleEn: 'Confident and professional',
  },
  {
    id: 'xu-zhining',
    name: '许知宁',
    employeeId: 'xu-zhining',
    reserveDepartment: 'outreach',
    style: '自信明艳',
    styleEn: 'Confident and expressive',
  },
  {
    id: 'cheng-zhiyao',
    name: '程知遥',
    employeeId: 'cheng-zhiyao',
    reserveDepartment: 'dev',
    style: '冷静利落',
    styleEn: 'Calm and precise',
  },
  {
    id: 'su-ying',
    name: '苏映',
    employeeId: 'su-ying',
    reserveDepartment: 'content_ops',
    style: '时髦有活力',
    styleEn: 'Creative and energetic',
  },
  {
    id: 'shen-qinglan',
    name: '沈清岚',
    employeeId: 'shen-qinglan',
    reserveDepartment: 'market_research',
    style: '睿智从容',
    styleEn: 'Insightful and poised',
  },
]
export const RECRUITMENT_CATALOG: readonly RecruitmentCharacter[] = characters.map((character) => {
  const employee = character.employeeId
    ? EMPLOYEES.find((employee) => employee.id === character.employeeId)
    : EMPLOYEE_BY_DEPARTMENT[character.reserveDepartment!]
  if (!employee) throw new Error(`Missing recruitment role: ${character.id}`)
  return {
    id: character.id,
    name: character.name,
    employeeId: character.employeeId,
    department: employee.role === 'secretary' ? '私人秘书' : employee.department,
    departmentEn: employee.role === 'secretary' ? 'Personal secretary' : employee.departmentEn,
    responsibility: employee.responsibility,
    portrait: `/assets/recruitment/${character.id}/portrait.png`,
    style: character.style,
    styleEn: character.styleEn,
  }
})
