export const emptyBrief = Object.freeze({ project: '', goal: '', audience: '', format: '', acceptance: '', budget: '', materials: '' })
export const briefFields = [
  ['project', '项目名称', 80], ['goal', '任务目标', 1000], ['audience', '目标受众', 400],
  ['format', '交付格式', 400], ['acceptance', '验收要求', 1000],
  ['budget', '预算与执行限制', 300], ['materials', '允许使用的资料范围', 600],
]
export function formatTaskBrief(brief) {
  if (!brief) return ''
  return ['任务需求单（用户确认的原始要求）', ...briefFields.filter(([key]) => brief[key]).map(([key, label]) => `${label}：${brief[key]}`),
    '预算为用户要求，不代表系统已实施人民币金额上限；对外发布仍需用户确认。'].join('\n')
}
export function taskAttention(task) {
  if (task.status === 'draft') return '待确认分工'
  if (['approval', 'review'].includes(task.status)) return '待审核'
  if (task.status === 'blocked') return '受阻，需核对或补充'
  if (task.status === 'revision') return '待修改'
  if (task.status === 'completed' && task.engine === 'research-v1' && task.dept !== 'file-agent' && task.quality && !task.quality.acceptance) return '待验收成果'
  return ''
}
