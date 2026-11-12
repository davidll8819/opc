import { useCallback, useEffect, useState } from 'react'
export const workspaceTabs = ['secretary', 'waner-office', 'office', 'recruitment', 'tasks', 'archive', 'members', 'skills', 'agents', 'settings', 'usage', 'help', 'reuse'] as const
const canonicalTab = (tab: string) => tab === 'waner-office' ? 'secretary' : tab === 'agents' ? 'recruitment' : tab
export type WorkspaceRoute = { tab: string; filter: 'all' | 'completed' | 'pending' | 'attention'; task?: string }
export function readWorkspaceRoute(hash: string, tenantId: string): WorkspaceRoute {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const tab = params.get('view') || ''
  const filter = params.get('filter') || ''
  const task = params.get('task') || ''
  if (params.get('workspace') !== tenantId || !workspaceTabs.includes(tab as typeof workspaceTabs[number])) return { tab: 'secretary', filter: 'all' }
  return { tab: canonicalTab(tab), filter: ['all', 'completed', 'pending', 'attention'].includes(filter) ? filter as WorkspaceRoute['filter'] : 'all', task: tab === 'tasks' && /^[a-zA-Z0-9_-]{1,80}$/.test(task) ? task : undefined }
}
export function workspaceHash(tenantId: string, route: WorkspaceRoute) {
  const params = new URLSearchParams({ workspace: tenantId, view: canonicalTab(route.tab) })
  if (route.tab === 'tasks') {
    params.set('filter', route.filter)
    if (route.task) params.set('task', route.task)
  }
  return `#${params}`
}
export function useWorkspaceRoute(tenantId: string) {
  const [route, setRoute] = useState(() => readWorkspaceRoute(location.hash, tenantId))
  useEffect(() => {
    const update = () => setRoute(readWorkspaceRoute(location.hash, tenantId))
    update()
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [tenantId])
  const navigate = useCallback((next: WorkspaceRoute) => {
    setRoute({ ...next, tab: canonicalTab(next.tab) })
    const hash = workspaceHash(tenantId, next)
    if (location.hash !== hash) location.hash = hash
  }, [tenantId])
  return [route, navigate] as const
}
