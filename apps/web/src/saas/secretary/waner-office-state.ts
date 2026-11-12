import type { Board, Task } from '../../../../../packages/secretary/model.mjs'
export const taskLabels: Record<Task['status'], string> = {
  draft: '待确认分工', queued: '等待执行', working: '执行中', approval: '等待批准',
  review: '待验收', authorized: '等待发布', revision: '待修改', completed: '执行完成', blocked: '需要处理',
}
const needsAttention = new Set(['blocked', 'approval', 'review', 'revision', 'draft'])
export function roomSnapshot(board: Pick<Board, 'tasks'>) {
  const attention = board.tasks.filter(t => needsAttention.has(t.status))
  const working = board.tasks.filter(t => t.status === 'working')
  const recent = [...board.tasks].sort((a,b) =>
    (Date.parse(b.updatedAt || b.finishedAt || '') || 0) - (Date.parse(a.updatedAt || a.finishedAt || '') || 0))
  const featured = [...attention, ...working, ...recent.filter(t => !needsAttention.has(t.status) && t.status !== 'working')].slice(0, 3)
  const mode = attention.length ? 'attention' : working.length ? 'working' : 'idle'
  const line = attention.length ? `有 ${attention.length} 项工作需要你处理。` : working.length ? `有 ${working.length} 项工作正在执行，我会帮你跟进。` : '我在这里，随时可以交代工作。'
  return { attention, working, featured, mode, line }
}
