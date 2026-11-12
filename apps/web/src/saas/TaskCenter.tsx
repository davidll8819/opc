import {useEmployeeDirectory,taskDepartments} from './employee-directory'
import './work-records.css'
import { TaskReuseDetails } from './ReuseWorkspace'
import { PrivateVideo, PrivateVideoLink } from './operations/PrivateVideo'
import { TaskBriefSummary } from './TaskBrief'
import { workspaceHash } from './workspace-route'
import { taskAttention } from '../../../../packages/secretary/task-brief.mjs'
import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { ReportMarkdown } from './ReportMarkdown'
import { ResearchReport } from './ResearchReport'
import { safeSourceUrl } from './research-markdown'
import { researchExecutionLabel, researchQualityLabel } from '../../../../packages/secretary/research-quality.mjs'
import { TaskImages } from './TaskImages'
import { TaskRecovery } from './TaskRecovery'
import { unfinishedImage } from './task-image-state'
import { TaskDependencies } from './TaskDependencies'
import { taskRunState, taskStateLabel } from './task-dependencies'
import { type Board, type Task } from '../../../../packages/secretary/model.mjs'
export type TaskFilter = 'all' | 'completed' | 'pending' | 'attention'
const taskState = (task: Task) => researchExecutionLabel(task) || taskStateLabel(task.status)
export function TaskCenter({
  base,
  board,
  filter,
  onFilter,
  selected,
  onSelect,
  onRun,
  onOperations,
  canEdit,
  busyId,
  onUpdate,
}: {
  base: string
  board: Board
  filter: TaskFilter
  onFilter: (v: TaskFilter) => void
  selected?: string
  onSelect: (id?: string) => void
  onRun: (task: Task) => void
  onOperations: (task: Task) => void
  canEdit: boolean
  busyId: string
  onUpdate: (board: Board) => void
}) {
  const departments=taskDepartments(useEmployeeDirectory(base))
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [acting, setActing] = useState(false)
  const [project, setProject] = useState('')
  const [owner, setOwner] = useState('')
  const task = board.tasks.find((t) => t.id === selected)
  const tasks = board.tasks
    .filter(
      (task) =>
        (filter === 'all' ||
          (filter === 'attention' ? !!taskAttention(task) : filter === 'completed' ? task.status === 'completed' : task.status !== 'completed')) &&
        (!project || (task.briefSnapshot?.project || '未分组') === project) && (!owner || task.dept === owner) &&
        `${task.title} ${departments.find((d) => d.id === task.dept)?.person || ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .slice()
    .reverse()
  async function action(type: 'approve' | 'reject' | 'dispatch') {
    if (!task) return
    setActing(true)
    setError('')
    try {
      const snap = await api<{ revision: number }>(`${base}/secretary`)
      const updated = await api<{ board: Board }>(`${base}/secretary`, {
        revision: snap.revision,
        today: new Date().toISOString().slice(0, 10),
        action:
          type === 'dispatch'
            ? { type, batchId: task.batchId }
            : {
                type,
                taskId: task.id,
                feedback: type === 'reject' ? '请根据任务要求修改成果' : '',
              },
      })
      onUpdate(updated.board)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(false)
    }
  }
  return (
    <section className="results-page task-results-page">
      <div className="page-heading">
        <p className="eyebrow">DELIVERABLES</p>
        <h1>{t(task ? '任务成果' : '任务总览')}</h1>
        <p className="muted">{t('完整查看任务、成品与来源，完成成果自动归档到资料室。')}</p>
      </div>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {task ? (
        <article className="result-detail">
          <button onClick={() => onSelect(undefined)}>← {t('返回任务列表')}</button>
          <button onClick={() => { const url = new URL(location.href); url.search = ''; url.hash = workspaceHash(base.split('/').at(-1) || '', { tab: 'tasks', filter, task: task.id }); navigator.clipboard.writeText(url.href).then(() => setError('任务链接已复制；仅有权限的账号可以打开。')).catch(() => setError('未能复制，请从浏览器地址栏复制任务链接。')) }}>复制任务链接</button>
          <header>
            <span className="plan-tag">{t(taskState(task))}</span>
            <h2>{task.title}</h2>
            <p>
              {t(departments.find((d) => d.id === task.dept)?.name || '部门成员')} ·{' '}
              {departments.find((d) => d.id === task.dept)?.person} ·{' '}
              {task.finishedAt ? new Date(task.finishedAt).toLocaleString() : task.due}
            </p>
          </header>
          <p role="status">{t(task.executionNote || taskState(task))}</p>
          <TaskDependencies task={task} tasks={board.tasks} base={base} />
          {task.followUpOf && <button onClick={() => onSelect(task.followUpOf)}>查看原任务</button>}
          {task.dept === 'file-agent' && task.engine === 'research-v1' && <section><p>归档不代表验收，请在原调研任务查看证据或发起补查。</p>{(task.dependsOn || []).filter(id => board.tasks.some(t => t.id === id && t.engine === 'research-v1')).map(id => <button key={id} onClick={() => onSelect(id)}>查看原调研与验收</button>)}</section>}
          {board.tasks.filter(t => t.followUpOf === task.id).map(next => <p key={next.id}><button onClick={() => onSelect(next.id)}>查看补查任务 · {taskState(next)}</button></p>)}
          {canEdit && task.engine && (task.status === 'blocked' || (task.status === 'queued' && !taskRunState(task, board.tasks).prerequisitesReady)) && <TaskRecovery key={`${base}/${task.id}`} base={base} taskId={task.id} onUpdate={onUpdate} onSelect={onSelect} onOperations={() => onOperations(task)} />}
          <TaskImages base={base} task={task} />
          {task.status === 'completed' && !task.images?.length && (
            task.engine === 'research-v1' ? <ResearchReport key={task.id} task={task} base={base} canEdit={canEdit} onUpdate={onUpdate} onSelect={onSelect} /> : <div className="result-document">{task.summary}</div>
          )}
          {task.status !== 'completed' && (
            <p className="result-document">{task.request || task.summary}</p>
          )}
          {task.media?.map((m, i) => (
            <div key={i}>
              {m.type === 'VIDEO' ? (
                <PrivateVideo controls preload="metadata" src={m.url} accessContext={task.runtimeTaskId ? { root: `${base}/operations`, taskId: task.runtimeTaskId } : undefined} style={{ maxWidth: '100%' }} />
              ) : (
                <img src={`${base}/secretary/tasks/${task.id}/media/${i}`} alt={task.title} style={{ maxWidth: '100%' }} />
              )}
              {m.type === 'VIDEO' ? <PrivateVideoLink src={m.url} accessContext={task.runtimeTaskId ? { root: `${base}/operations`, taskId: task.runtimeTaskId } : undefined}>视频 {i + 1} ↗</PrivateVideoLink> : <a href={`${base}/secretary/tasks/${task.id}/media/${i}`} target="_blank" rel="noopener noreferrer">图片 {i + 1} ↗</a>}
            </div>
          ))}
          {task.archiveVideoFileId && (
            <PrivateVideoLink src={`${base}/files/${task.archiveVideoFileId}/video`} download>下载归档成片</PrivateVideoLink>
          )}
          {task.archiveFileId && (
            <a
              className="result-download"
              href={`${base}/files/${task.archiveFileId}/download`}
              download
            >
              {t('下载归档文档')}
            </a>
          )}
          {task.archivedAt && (
            <p className="muted">
              {t('已归档到资料室')} · {new Date(task.archivedAt).toLocaleString()}
            </p>
          )}
          {task.archiveNote && <p role="status">{t(task.archiveNote)}</p>}
          <details className="result-context"><summary>任务需求与知识来源</summary>
          {task.briefSnapshot && <TaskBriefSummary brief={task.briefSnapshot} />}
          <TaskReuseDetails key={`reuse-${task.id}`} base={base} task={task} />
          </details>
          {!!task.sources?.length && (
            <section>
              <h3>{t('调研来源')}</h3>
              {task.sources.map((s) => (
                <p key={s.id}>
                  <a href={safeSourceUrl(s.url)} target="_blank" rel="noopener noreferrer">
                    [{s.id}] {s.title}
                  </a>
                </p>
              ))}
            </section>
          )}
          {!!task.attachmentIds?.length && (
            <section>
              <h3>{t('任务附件')}</h3>
              {task.attachmentIds.map((id, i) => (
                <p key={id}>
                  <a href={`${base}/files/${id}/download`} download>
                    {t('附件')} {i + 1}
                  </a>
                </p>
              ))}
            </section>
          )}
          <div className="result-actions">
            {task.dept === 'app-agent' && (
              <button onClick={() => onOperations(task)}>{t('打开运营工作台')}</button>
            )}
            {taskRunState(task, board.tasks).available && !(task.status === 'blocked' && task.engine) && (
              <button
                disabled={!canEdit || !!busyId || !taskRunState(task, board.tasks).canRun}
                onClick={() => {
                  if (taskRunState(task, board.tasks).canRun) onRun(task)
                }}
              >
                {t(
                  unfinishedImage(task)
                    ? '生成图片'
                    : task.status === 'blocked'
                      ? '重试任务'
                      : '开始执行',
                )}
              </button>
            )}
            {task.runtimePending && <p role="status">{t('正在核对运营任务状态，请勿重复启动')}</p>}
            {task.status === 'draft' && task.batchId && (
              <button disabled={!canEdit || acting} onClick={() => void action('dispatch')}>
                {t('确认派发')}
              </button>
            )}
            {task.status === 'approval' && (
              <>
                <button disabled={!canEdit || acting} onClick={() => void action('approve')}>
                  {t('通过发布')}
                </button>
                <button disabled={!canEdit || acting} onClick={() => void action('reject')}>
                  {t('退回修改')}
                </button>
              </>
            )}
          </div>
          {!!task.steps?.length && (
            <details>
              <summary>{t('查看执行记录')}</summary>
              <ol>
                {task.steps.map((s, i) => (
                  <li key={i}>
                    {t(s.note)}
                    <p>{s.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      ) : (
        <>
          {selected && <p role="status">该任务暂不可见：正在加载、已移除或当前账号无权访问。<button onClick={() => onSelect(undefined)}>查看任务列表</button></p>}
          <div className="result-toolbar">
            {(['all', 'attention', 'completed', 'pending'] as const).map((key) => (
              <button key={key} aria-pressed={filter === key} onClick={() => onFilter(key)}>
                {t({ all: '全部任务', attention: '待我处理', completed: '已完成的任务', pending: '未完成' }[key])}
              </button>
            ))}
            <input
              aria-label={t('搜索任务')}
              placeholder={t('搜索任务或负责人')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="result-toolbar">
            <label className="task-filter-label">项目分组<select value={project} onChange={e => setProject(e.target.value)}><option value="">全部项目</option>{[...new Set(board.tasks.map(task => task.briefSnapshot?.project || '未分组'))].map(name => <option key={name}>{name}</option>)}</select></label>
            <label className="task-filter-label">负责人<select value={owner} onChange={e => setOwner(e.target.value)}><option value="">全部负责人</option>{departments.filter(d => board.tasks.some(task => task.dept === d.id)).map(d => <option key={d.id} value={d.id}>{d.person} · {d.name}</option>)}</select></label>
            <span role="status">{tasks.length} 项任务</span>
          </div>
          {!tasks.length && <p className="result-empty">{t('当前没有符合条件的任务')}</p>}
          <div className="result-grid task-result-list">
            {tasks.map((task) => (
              <button className="result-card" key={task.id} onClick={() => onSelect(task.id)}>
                {task.images?.[0] ? (
                  <img src={`${base}/files/${task.images[0].fileId}/preview`} alt={task.title} />
                ) : (
                  <div className="result-type">
                    {t(task.dept === 'app-agent' ? '运营成果' : '文档与任务')}
                  </div>
                )}
                <span className="plan-tag">{t(taskState(task))}</span>
                {task.status === 'completed' && task.engine === 'research-v1' && <p>{researchQualityLabel(task.quality)}</p>}
                <h2>{task.title}</h2>
                <p>{task.briefSnapshot?.project || '未分组'}{taskAttention(task) ? ` · ${taskAttention(task)}` : ''}</p>
                <p>
                  {departments.find((d) => d.id === task.dept)?.person} · {task.due}
                </p>
                <span>{t(task.status === 'completed' ? '查看成品' : '查看任务')} ↗</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
type StoredFile = { id: string; name: string; mime: string; size: number; created_at: string; deleted_at?: string; protected?: boolean }
export function ArchiveRoom({ base, onTask }: { base: string; onTask: (id: string) => void }) {
  const departments=taskDepartments(useEmployeeDirectory(base))
  const [data, setData] = useState<{ tasks: Task[]; files: StoredFile[] }>({
      tasks: [],
      files: [],
    }),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [dept, setDept] = useState(''),
    [day, setDay] = useState(''),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<StoredFile>(),
    [text, setText] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true)
    void api(`${base}/deliverables/sync`, {})
      .then(() => api<typeof data>(`${base}/deliverables`))
      .then((r) => {
        if (live) setData(r)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [base])
  useEffect(() => {
    setText('')
    if (!preview || !(preview.mime.startsWith('text/') || preview.mime === 'application/json'))
      return
    let live = true
    fetch(`${base}/files/${preview.id}/download`)
      .then(async (r) => {
        if (!r.ok) throw Error(t('文件读取失败'))
        return r.text()
      })
      .then((s) => {
        if (live) setText(s)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base, preview])
  const [storage, setStorage] = useState<{ used: number; trash: number; limit: number; items: StoredFile[] }>()
  const [showTrash, setShowTrash] = useState(false)
  const [fileAction, setFileAction] = useState('')
  const [purgeId, setPurgeId] = useState('')
  const refreshStorage = () => api<NonNullable<typeof storage>>(`${base}/files/storage`).then(setStorage)
  useEffect(() => {
    let live = true
    void api<NonNullable<typeof storage>>(`${base}/files/storage`).then(r => { if (live) setStorage(r) })
      .catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [base])
  async function changeFile(id: string, action: string) {
    if (fileAction) return
    setFileAction(id); setError('')
    try {
      await api(`${base}/files/${id}/${action}`, action === 'purge' ? { confirm: '永久删除' } : {})
      setPurgeId(''); setPreview(undefined)
      await refreshStorage()
    } catch (e) { setError((e as Error).message) }
    finally { setFileAction('') }
  }
  const owner = (id: string) =>
    data.tasks.find(
      (task) => task.archiveFileId === id || task.archiveVideoFileId === id || task.images?.some((img) => img.fileId === id),
    )
  const files = (storage?.items || data.files).filter(
    (f) =>
      Boolean(f.deleted_at) === showTrash &&
      `${f.name} ${owner(f.id)?.title || ''}`.toLowerCase().includes(query.toLowerCase()) &&
      (!dept || owner(f.id)?.dept === dept) &&
      (!day || f.created_at.slice(0, 10) === day) &&
      (kind === 'all' ||
        (kind === 'image'
          ? f.mime.startsWith('image/')
          : kind === 'result'
            ? !!owner(f.id)
            : !owner(f.id))),
  )
  return (
    <section className="results-page archive-records-page">
      <div className="page-heading">
        <p className="eyebrow">ARCHIVE</p>
        <h1>{t('资料室')}</h1>
        <p className="muted">{t('按任务、部门和日期保存成果与附件，仅当前企业中的你可以查看。')}</p>
      </div>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {storage && <details className="archive-capacity" aria-label="资料室容量"><summary>存储与回收站 · 已用 {(storage.used / 1048576).toFixed(1)} MB</summary>
        <p>已用 {(storage.used / 1048576).toFixed(1)} / {storage.limit / 1048576} MB · 回收站 {(storage.trash / 1048576).toFixed(1)} MB</p>
        <progress value={storage.used} max={storage.limit} aria-label="已用容量" />
        <p className="muted">回收站仍占空间，彻底删除后释放。任务、对话或档案引用的文件受保护。</p>
        <button onClick={() => { setShowTrash(v => !v); setPurgeId('') }}>{showTrash ? '返回资料室' : '打开回收站'}</button>
      </details>}
      <div className="result-toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('搜索文件')}
          aria-label={t('搜索文件')}
        />
        <select aria-label={t('文件分类')} value={kind} onChange={(e) => setKind(e.target.value)}>
          {[
            ['all', '全部文件'],
            ['result', '任务成果'],
            ['image', '图片'],
            ['attachment', '上传附件'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
        <select aria-label={t('按部门筛选')} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">{t('全部部门')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {t(d.name)}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label={t('归档日期')}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </div>
      {loading ? (
        <p role="status">{t('正在读取…')}</p>
      ) : (
        !files.length && <p className="result-empty">{t('当前没有符合条件的文件')}</p>
      )}
      <div className="result-grid">
        {files.map((file) => (
          <article className="result-card" key={file.id}>
            {!showTrash && file.mime.startsWith('image/') && (
              <img src={`${base}/files/${file.id}/preview`} alt={file.name} />
            )}
            <div className="archive-file-info"><h2>{file.name}</h2>
            <p>
              {new Date(file.created_at).toLocaleDateString()} · {Math.ceil(file.size / 1024)} KB
            </p>
            </div><div className="result-actions">
              {!showTrash && <button onClick={() => setPreview(file)}>{t('预览')}</button>}
              {showTrash ? <>
                <button disabled={!!fileAction} onClick={() => void changeFile(file.id, 'restore')}>恢复文件</button>
                <button disabled={!!fileAction || file.protected} onClick={() => setPurgeId(file.id)}>彻底删除</button>
                {purgeId === file.id && <div role="alert">
                  <p>永久删除「{file.name}」后无法恢复。</p>
                  <button disabled={!!fileAction} onClick={() => void changeFile(file.id, 'purge')}>确认永久删除</button>
                  <button onClick={() => setPurgeId('')}>取消</button>
                </div>}
              </> : <button disabled={!!fileAction || file.protected} title={file.protected ? '被任务、对话或档案引用' : ''} onClick={() => void changeFile(file.id, 'trash')}>{file.protected ? '引用中，已保护' : '移入回收站'}</button>}
              {!showTrash && <a href={`${base}/files/${file.id}/download`} download>
                {t('下载')}
              </a>}
              {owner(file.id) && (
                <button onClick={() => onTask(owner(file.id)!.id)}>{t('查看原任务')}</button>
              )}
            </div>
          </article>
        ))}
      </div>
      {preview && (
        <div className="asset-modal-backdrop">
          <section
            className="asset-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('文件预览')}
          >
            <header>
              <h2>{preview.name}</h2>
              <button onClick={() => setPreview(undefined)}>{t('关闭')}</button>
            </header>
            {preview.mime.startsWith('image/') ? (
              <img src={`${base}/files/${preview.id}/preview`} alt={preview.name} />
            ) : preview.mime === 'video/mp4' ? (
              <PrivateVideo controls preload="metadata" src={`${base}/files/${preview.id}/video`} style={{ maxWidth: '100%' }} aria-label="归档成片预览" />
            ) : preview.mime.startsWith('text/') || preview.mime === 'application/json' ? (
              (/\.md$/i.test(preview.name) || preview.mime === 'text/markdown') && text ? <ReportMarkdown text={text} /> : <pre>{text || t('正在读取…')}</pre>
            ) : (
              <p>{t('请下载此文件查看')}</p>
            )}
            <a href={`${base}/files/${preview.id}/download`} download>
              {t('下载')}
            </a>
          </section>
        </div>
      )}
    </section>
  )
}
