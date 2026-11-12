import {useEmployeeDirectory} from './employee-directory'
import { Recruitment } from './Recruitment'
import { useSecretarySync } from './secretary/secretary-sync'
import { WanerOffice } from './secretary/WanerOffice'
import { ReuseWorkspace } from './ReuseWorkspace'
import { useWorkspaceRoute } from './workspace-route'
import { WorkspaceHelp } from './WorkspaceHelp'
import './onboarding.css'
import { deriveOfficeWorkStatuses } from './office-work-status'
import { TaskCenter, ArchiveRoom, type TaskFilter } from './TaskCenter'
import { WorkspaceTools } from './WorkspaceTools'
import { type Task } from '../../../../packages/secretary/model.mjs'
import { lazy, Suspense, useCallback, useEffect, useState, useMemo } from 'react'
import { t, useLanguage } from '@/i18n'
import { api, type Tenant } from './api'
import { Members } from './Members'
import { Usage } from './Usage'
import { Skills, type SkillView } from './Skills'
import { SkillUpload } from './SkillUpload'
import { EmployeeDialog } from './EmployeeDialog'
import { SecretaryWorkspace } from './secretary/SecretaryWorkspace'
import { OperationsDialog } from './operations/OperationsDialog'
import type { OperationsHandoff } from './operations/OperationsWorkspace'
import type { OperationsBrief } from './operations/models'
import { Settings } from './Settings'
import { NavigationIcon } from './NavigationIcon'
import { OfficeHeaderStats, OfficeRightPanel } from '@/components/OfficeDashboardChrome'
const Office = lazy(() => import('../App'))
export function Workspace({ tenant, privateOrigin }: { tenant: Tenant; privateOrigin?: string | null }) {
  const language = useLanguage()
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [operationsVisited, setOperationsVisited] = useState(false)
  const [handoff, setHandoff] = useState<OperationsHandoff>()
  const openOperations = useCallback(
    (brief?: string, task?: Task, savedBrief?: OperationsBrief) => {
      if (brief?.trim() || task)
        setHandoff({
          id: crypto.randomUUID(),
          text: brief?.trim() || '',
          secretaryTaskId: task?.id,
          runtimeTaskId: task?.runtimeTaskId,
          brief: savedBrief,
        })
      setOperationsVisited(true)
      setOperationsOpen(true)
    },
    [],
  )
  const [returningToProfile, setReturningToProfile] = useState(false)
  const [skillEmployee, setSkillEmployee] = useState('')
  const [recruitmentEmployee, setRecruitmentEmployee] = useState<string>()
  const [returnToRecruitment, setReturnToRecruitment] = useState(false)
  const [skillView, setSkillView] = useState<SkillView>('catalog')
  const [skillRevision, setSkillRevision] = useState(0)
  const skillInstalled = () => {
    setSkillRevision((n) => n + 1)
    setSkillView('installed')
  }
  const [automatic, setAutomatic] = useState(true)
  const [route, navigate] = useWorkspaceRoute(tenant.id)
  const { tab, filter: taskFilter, task: selectedTask } = route
  const setTab = useCallback((tab: string) => navigate({ tab, filter: 'all' }), [navigate])
  const setTaskFilter = (filter: TaskFilter) => navigate({ tab: 'tasks', filter })
  const setSelectedTask = (task?: string) => navigate({ tab: 'tasks', filter: taskFilter, task })
  const openTasks = (filter: TaskFilter = 'all', id?: string) => {
    navigate({ tab: 'tasks', filter, task: id })
  }
  const base = `/api/tenants/${tenant.id}`
  const employeeRoster=useEmployeeDirectory(base)
  const secretarySync = useSecretarySync(base)
  const { board } = secretarySync.snapshot
  const setBoard = secretarySync.replaceBoard
  const [conversationOpen, setConversationOpen] = useState(false)
  const openSecretary = useCallback(() => { setConversationOpen(true); setTab('secretary') }, [setTab])
  const [tool, setTool] = useState(''),
    [dictated, setDictated] = useState(''),
    [agentId, setAgentId] = useState<string>()
  const selectedEmployee = employeeRoster.find(employee => employee.id === agentId && employee.role !== 'secretary')
  const [status, setStatus] = useState<{
      departments: {
        id: string
        name: string
        ready: boolean
        enabled?: boolean
        active?: boolean
      }[]
      memoryMb: number
      uptime: number
    } | null>(null)
  const workIndicators = useMemo(() => deriveOfficeWorkStatuses(board, status), [board, status])
  const [busyTask, setBusyTask] = useState(''),
    [taskError, setTaskError] = useState('')
  const openTaskOperations = (task: Task) => openOperations(`${task.title}\n${task.summary}`, task)
  async function runTask(task: Task) {
    setBusyTask(task.id)
    setTaskError('')
    try {
      const result = await api<import('./secretary/secretary-sync').SecretarySnapshot>(
        `${base}/secretary/tasks/${task.id}/run`,
        task.status === 'completed' ? { regenerateImage: true } : {},
      )
      secretarySync.accept(result)
    } catch (e) {
      setTaskError((e as Error).message)
    } finally {
      setBusyTask('')
    }
  }
  useEffect(() => {
    if (tab === 'secretary' && dictated) setDictated('')
  }, [tab, dictated])
  const openSettings = () => {
    setOperationsOpen(false)
    setTool('')
    setTab('settings')
  }
  const openRecruitmentEmployee = useCallback(
    (id: string) => {
      if (id === 'marvis') openSecretary()
      else {
        setReturningToProfile(false)
        setAgentId(id)
        setTab('recruitment')
      }
    },
    [setTab, openSecretary],
  )
  const openPerson = useCallback(
    (id: string) => {
      if (id === 'app-agent') openOperations()
      else openRecruitmentEmployee(id)
    },
    [openOperations, openRecruitmentEmployee],
  )
  useEffect(() => {
    let live = true
    let pending = false
    const update = async () => {
      if (document.hidden || pending) return
      pending = true
      await api<NonNullable<typeof status>>(`${base}/workspace/status`)
        .then((s) => {
          if (live) {
            setStatus(s)
          }
        })
        .catch(() => {
          /* Secretary synchronization reports its own connection state. */
        })
        .finally(() => {
          pending = false
        })
    }
    update()
    const timer = setInterval(update, 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [base])

  useEffect(() => {
    const ids = [
      ...new Set(
        board.tasks
          .filter((task) => task.runtimeTaskId && task.status === 'working')
          .map((task) => task.runtimeTaskId!),
      ),
    ]
    if (!ids.length) return
    let live = true,
      pending = false
    const sync = async () => {
      if (pending || document.hidden) return
      pending = true
      try {
        for (const id of ids) await api(`${base}/operations/tasks/${id}`)
      } catch {
        if (live) setTaskError('运营任务状态暂时无法核对')
      } finally {
        pending = false
      }
    }
    void sync()
    const timer = setInterval(() => void sync(), 7000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [base, board.tasks.map((task) => `${task.runtimeTaskId}:${task.status}`).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`workspace ${tab === 'recruitment' ? 'workspace-recruitment' : ''} ${tab === 'help' ? 'workspace-onboarding' : ''} ${tab === 'secretary' ? 'workspace-waner-office' : ''} ${['help', 'secretary', 'waner-office', 'tasks', 'archive', 'reuse', 'recruitment'].includes(tab) ? 'workspace-secretary-layout' : ''}`}
    >
      <aside className="workspace-nav">
        <p className="eyebrow">{tab === 'help' ? '工作空间' : 'WORKSPACE'}</p>
        <h2>{tenant.name}</h2>
        <span className="plan-tag">{tenant.plan === 'enterprise' ? t('企业版') : t('个人版')}</span>
        <nav lang={language} aria-label={t('主导航')}>
          {[
            ['secretary', t('私人秘书')],
            ['office', t('办公室')],
            ['recruitment', language === 'en' ? 'Recruit employees' : '招聘员工'],
            ['tasks', t('任务成果')],
            ['archive', t('资料室')],
            ['skills', t('技能库')],
            ['reuse', t('工作知识')],
            ['members', t('企业成员')],
            ['settings', t('设置')],
            ['usage', t('用量与费用')],
            ['help', t('使用帮助')],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-current={tab === key ? 'page' : undefined}
              className={tab === key ? 'selected' : ''}
              onClick={() => {
                setAgentId(undefined)
                if (key === 'secretary') setConversationOpen(false)
                setTab(key)
                if (key === 'tasks') {
                  openTasks('all')
                }
              }}
            >
              <NavigationIcon name={key} />
              <span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="workspace-note">
          <strong>{t('专属于当前企业')}</strong>
          <p>{t('助手配置、成员和使用记录都在此工作空间中管理。')}</p>
        </div>
      </aside>
      <main
        className={`workspace-content ${tab === 'office' ? 'workspace-office' : tab === 'skills' ? 'workspace-skills' : tab === 'secretary' ? 'workspace-secretary' : ''}`}
      >
        {tab === 'tasks' && (taskError || secretarySync.error) && (
          <p className="error" role="alert">
            {t(taskError || secretarySync.error)}
          </p>
        )}
        {tab === 'help' && <WorkspaceHelp onStart={() => setTab('secretary')} onTasks={() => openTasks('attention')} onUsage={() => setTab('usage')} />}
        <div className="waner-office-view" hidden={tab !== 'secretary'}>
          <WanerOffice privateOrigin={privateOrigin} board={board} error={secretarySync.error} loaded={secretarySync.lastSynced > 0}
            lastSynced={secretarySync.lastSynced} conversationOpen={tab === 'secretary' && conversationOpen}
            onConversationChange={setConversationOpen} onTask={id => openTasks('all', id)} onAllTasks={() => openTasks('attention')}>
            <SecretaryWorkspace base={base} canEdit={tenant.role !== 'member'} sync={secretarySync} active={tab === 'secretary' && conversationOpen}
              openSkills={() => { setReturningToProfile(false); setSkillEmployee('marvis'); setSkillView('catalog'); setTab('skills') }}
              initialProfile={returningToProfile && skillEmployee === 'marvis'}
              openOperations={openOperations} openSettings={openSettings}
              initialInput={dictated} onVoice={() => setTool('voice')}
              onTask={id => openTasks('all', id)} />
          </WanerOffice>
        </div>
        {tab === 'office' && (
          <>
            <OfficeHeaderStats
              board={board}
              status={status}
              onTasks={(filter) => openTasks(filter)}
              onSettings={openSettings}
            />
            <div className="office-scene-toolbar">
              <span>{t('办公室互动')}</span>
              <button aria-pressed={automatic} onClick={() => setAutomatic(!automatic)}>
                {t(automatic ? '关闭互动' : '开启互动')}
              </button>
              <small>{t('红灯执行中 · 黄灯待确认或待处理 · 绿灯空闲')}</small>
            </div>
            <Suspense fallback={<p>{t('正在加载办公室…')}</p>}>
              <Office
                tenantId={tenant.id}
                workIndicators={workIndicators}
                automatic={automatic}
                onAutomaticChange={setAutomatic}
                onOpenOperations={openOperations}
                onOpenPerson={openPerson}
              />
            </Suspense>
          </>
        )}
        {tab === 'tasks' && (
          <TaskCenter
            base={base}
            board={board}
            filter={taskFilter}
            onFilter={setTaskFilter}
            selected={selectedTask}
            onSelect={setSelectedTask}
            onRun={runTask}
            onOperations={openTaskOperations}
            canEdit={tenant.role !== 'member'}
            busyId={busyTask}
            onUpdate={setBoard}
          />
        )}
        {tab === 'archive' && <ArchiveRoom base={base} onTask={(id) => openTasks('all', id)} />}
        {tab === 'recruitment' && <Recruitment base={base} canEdit={tenant.role !== 'member'} onOpenEmployee={openRecruitmentEmployee}
          initialEmployeeId={recruitmentEmployee} onSelection={setRecruitmentEmployee}
          onOpenSkills={id => { setReturnToRecruitment(true); setSkillEmployee(id); setSkillView('catalog'); setTab('skills') }} />}
        {tab === 'members' && <Members base={base} tenant={tenant} />}{' '}
        {tab === 'skills' && (
          <Skills
            base={base}
            employeeId={skillEmployee}
            onEmployee={setSkillEmployee}
            returnProfile={() => {
              if (returnToRecruitment) { setReturnToRecruitment(false); setAgentId(undefined); setTab('recruitment'); return }
              setReturningToProfile(true)
              setAgentId(skillEmployee)
              if (skillEmployee === 'marvis') openSecretary()
              else setTab('recruitment')
            }}
            canEdit={tenant.role !== 'member'}
            view={skillView}
            onView={setSkillView}
            revision={skillRevision}
            onInstalled={skillInstalled}
            openOperations={openOperations}
          />
        )}
        {tab === 'recruitment' && selectedEmployee && (
          <EmployeeDialog
            key={selectedEmployee.id}
            employee={selectedEmployee}
            close={() => { setAgentId(undefined); setReturningToProfile(false) }}
            initialProfile={returningToProfile}
            onTool={setTool}
            tasks={board.tasks.filter(task => task.dept === selectedEmployee.id)}
            onRun={runTask}
            onTaskOperations={openTaskOperations}
            busyTask={busyTask}
            canEdit={tenant.role !== 'member'}
            base={base}
            openSettings={openSettings}
            openSkills={(employeeId) => {
              setReturnToRecruitment(false)
              setSkillEmployee(employeeId)
              setSkillView('catalog')
              setTab('skills')
            }}
            openOperations={openOperations}
          />
        )}
        {tab === 'settings' && <Settings base={base} canEdit={tenant.role !== 'member'} />}
        {tab === 'usage' && <Usage base={base} />}
        {tab === 'reuse' && <ReuseWorkspace base={base} board={board} canRun={tenant.role !== 'member'} onDraft={next => { setBoard(next); openSecretary() }} onTask={id => openTasks('all', id)} />}
      </main>
      {tool && (
        <WorkspaceTools
          key={tool}
          base={base}
          tool={tool}
          onClose={() => setTool('')}
          openSettings={openSettings}
          onDictated={(text) => {
            setDictated(text)
            openSecretary()
          }}
        />
      )}
      {operationsVisited && (
        <OperationsDialog
          open={operationsOpen}
          onClose={() => setOperationsOpen(false)}
          base={base}
          canEdit={tenant.role !== 'member'}
          handoff={handoff}
          openSettings={openSettings}
        />
      )}
      {['help', 'secretary', 'waner-office', 'tasks', 'archive', 'reuse', 'recruitment'].includes(tab) ? null : tab === 'office' ? (
        <OfficeRightPanel
          base={base}
          board={board}
          onRun={runTask}
          onOperations={openTaskOperations}
          busyId={busyTask}
          canEdit={tenant.role !== 'member'}
          error={taskError}
          onTask={(task) => openTasks('all', task.id)}
        />
      ) : tab === 'skills' ? (
        <aside className="workspace-extension skill-upload-rail" aria-label={t('技能上传区')}>
          <SkillUpload
            base={base}
            canEdit={tenant.role !== 'member'}
            onInstalled={skillInstalled}
          />
        </aside>
      ) : (
        <aside className="workspace-extension" aria-label={t('右侧预留区')}>
          <div className="extension-placeholder">
            <span aria-hidden="true">＋</span>
            <h2>{t('扩展区域')}</h2>
            <p>{t('为后续功能预留')}</p>
          </div>
        </aside>
      )}
    </div>
  )
}
