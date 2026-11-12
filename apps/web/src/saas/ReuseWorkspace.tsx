import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { TaskBriefFields } from './TaskBrief'
import {
  emptyBrief,
  briefFields,
  type TaskBrief,
} from '../../../../packages/secretary/task-brief.mjs'
import { departments, type Board, type Task } from '../../../../packages/secretary/model.mjs'
import './reuse.css'
import { ReuseTransfer } from './ReuseTransfer'
import { downloadWorkflow } from './reuse-download'

type Step = { title: string; dept: string; brief: string; dependsOn: number[] }
type Workflow = { brief: TaskBrief; steps: Step[] }
export type Entry = {
  id?: string
  version?: number
  kind: 'memory' | 'knowledge' | 'brand' | 'template'
  title: string
  project: string
  enabled: boolean
  body: { content: string; source: string } | Workflow
}
type Notice = { key: string; taskId: string; title: string; label: string; read: boolean }
const labels = {
  memory: '长期记忆',
  knowledge: '项目资料',
  brand: '品牌规则',
  template: '流程模板',
}
const fresh = (kind: Entry['kind']): Entry => ({
  kind,
  title: '',
  project: '',
  enabled: true,
  body:
    kind === 'template'
      ? {
          brief: {
            ...emptyBrief,
            project: '{{项目}}',
            goal: '{{目标}}',
            acceptance: '{{验收要求}}',
          },
          steps: [
            {
              title: '整理本次资料',
              dept: 'file-agent',
              brief: '{{目标}}；验收：{{验收要求}}',
              dependsOn: [],
            },
          ],
        }
      : { content: '', source: '' },
})
const parameters = (entry: Entry) => [
  ...new Set(
    [...JSON.stringify(entry.body).matchAll(/\{\{([\p{L}\p{N}_]{1,30})\}\}/gu)].map((m) => m[1]),
  ),
]
export function ReuseWorkspace({
  base,
  board,
  canRun,
  onDraft,
  onTask,
}: {
  base: string
  board: Board
  canRun: boolean
  onDraft: (board: Board) => void
  onTask: (id: string) => void
}) {
  const [tab, setTab] = useState<'knowledge' | 'memory' | 'template' | 'notices'>('knowledge')
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('all'),
    [scope, setScope] = useState('all')
  const [items, setItems] = useState<Entry[]>([]),
    [notices, setNotices] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('')
  const [edit, setEdit] = useState<Entry>(),
    [versions, setVersions] =
      useState<{ version: number; title: string; project: string; body: Entry['body'] }[]>()
  const [selected, setSelected] = useState<Entry>(),
    [values, setValues] = useState<Record<string, string>>({}),
    [preview, setPreview] = useState<Workflow>()
  const [due, setDue] = useState(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  )
  const [sourceTask, setSourceTask] = useState(''),
    [question, setQuestion] = useState(''),
    [project, setProject] = useState(''),
    [found, setFound] =
      useState<{ title: string; version: number; source: string; content: string }[]>()
  const runId = useRef<string | undefined>(undefined)
  const load = useCallback(async () => {
    const [list, notifications] = await Promise.all([
      api<{ items: Entry[] }>(`${base}/reuse`),
      api<{ items: Notice[] }>(`${base}/reuse/notices`),
    ])
    setItems(list.items)
    setNotices(notifications.items)
  }, [base])
  useEffect(() => {
    let alive = true
    load()
      .catch((e) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [load])
  useEffect(() => {
    if (tab !== 'notices') return
    const timer = setInterval(() => {
      if (!document.hidden) load().catch(() => setError('通知刷新失败，保留上次记录，请重试'))
    }, 15000)
    return () => clearInterval(timer)
  }, [tab, load])
  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const changeTab = (next: typeof tab) => {
    if (edit && !window.confirm('编辑内容尚未保存，离开编辑？')) return
    setTab(next)
    setSearch('')
    setStatus('all')
    setScope('all')
    setEdit(undefined)
    setSelected(undefined)
    setVersions(undefined)
    setPreview(undefined)
    setError('')
    setMessage('')
  }
  const body = edit && 'steps' in edit.body ? edit.body : undefined
  const updateWorkflow = (next: Workflow) => edit && setEdit({ ...edit, body: next })
  const group = items.filter((i) =>
    tab === 'knowledge' ? ['knowledge', 'brand'].includes(i.kind) : i.kind === tab,
  )
  const list = group.filter(
    (i) =>
      (!search.trim() ||
        `${i.title} ${i.project} ${'content' in i.body ? i.body.content : i.body.brief.goal}`
          .toLowerCase()
          .includes(search.trim().toLowerCase())) &&
      (status === 'all' || i.enabled === (status === 'enabled')) &&
      (scope === 'all' || (scope === 'global' ? !i.project : i.project === scope.slice(8))),
  )
  return (
    <section className="reuse-workspace" aria-label="工作知识与复用">
      <header>
        <div>
          <h1>工作知识</h1>
          <p className="reuse-privacy">当前企业 · 仅你可见 · {items.length} 条已保存</p>
        </div>
        <button disabled={busy} onClick={() => void act(load)}>刷新</button>
      </header>
      <nav aria-label="工作知识分类" className="reuse-tabs">
        <button aria-pressed={tab === 'knowledge'} onClick={() => changeTab('knowledge')}>
          知识库
        </button>
        <button aria-pressed={tab === 'memory'} onClick={() => changeTab('memory')}>
          长期记忆
        </button>
        <button aria-pressed={tab === 'template'} onClick={() => changeTab('template')}>
          流程模板
        </button>
        <button aria-pressed={tab === 'notices'} onClick={() => changeTab('notices')}>
          任务通知
          {notices.some((n) => !n.read) ? ` · ${notices.filter((n) => !n.read).length} 未读` : ''}
        </button>
      </nav>
      {loading && <p role="status">正在读取你的工作知识…</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {tab === 'notices' ? (
        <section>
          <h2>需要留意的任务</h2>
          <p>根据当前任务状态生成；不会自动重试、付费执行或对外发送。标为已读不会改变任务。</p>
          {!notices.length && <p>暂无完成、受阻或待审核的任务。</p>}
          <ul className="reuse-list">
            {notices.map((n) => (
              <li key={n.key}>
                <div>
                  <strong>{n.title}</strong>
                  <p>
                    {n.label} · {n.read ? '已读' : '未读'}
                  </p>
                </div>
                <div className="reuse-actions">
                  <button onClick={() => onTask(n.taskId)}>查看任务</button>
                  {!n.read && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(`${base}/reuse/notices/read`, { key: n.key })
                          await load()
                        })
                      }
                    >
                      标为已读
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <div className="reuse-section-heading">
            <div>
              <h2>
                {tab === 'template'
                  ? '可执行的流程模板'
                  : tab === 'memory'
                    ? '常用要求与已确认事实'
                    : '项目资料与品牌规则'}
              </h2>
              <p>
                {tab === 'template'
                  ? '按步骤交接成果，填好本次参数，再确认分工。'
                  : tab === 'memory'
                    ? '保存稳定偏好与已确认事实；随时修正、停用，避免旧要求影响新任务。'
                    : '按项目管理资料与品牌规则。启用后参与检索，任务中保留使用版本。'}
              </p>
            </div>
          </div>
          <div className="reuse-toolbar"><div className="reuse-actions">
            {tab !== 'template' ? (
              <>
                {tab === 'memory' ? (
                  <button disabled={busy} onClick={() => setEdit(fresh('memory'))}>
                    新增长期记忆
                  </button>
                ) : (
                  <>
                    <button disabled={busy} onClick={() => setEdit(fresh('knowledge'))}>
                      新增项目资料
                    </button>
                    <button disabled={busy} onClick={() => setEdit(fresh('brand'))}>
                      新增品牌规则
                    </button>
                  </>
                )}
              </>
            ) : (
              <button disabled={busy} onClick={() => setEdit(fresh('template'))}>
                新建流程模板
              </button>
            )}
          </div>
          <ReuseTransfer key={tab} base={base} kind={tab} onImported={load} />
          </div>
          <div className="reuse-filters">
            <label>
              搜索当前分类
              <input
                type="search"
                placeholder="名称、项目或内容"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">全部状态</option>
                <option value="enabled">已启用</option>
                <option value="disabled">已停用</option>
              </select>
            </label>
            {tab !== 'template' && (
              <label>
                适用项目
                <select value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="all">全部项目</option>
                  <option value="global">全项目适用</option>
                  {[...new Set(group.map((i) => i.project).filter(Boolean))].map((p) => (
                    <option key={p} value={`project:${p}`}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {tab === 'template' && canRun && (
            <details>
              <summary>从已完成流程提取模板</summary>
              <p>
                只提取负责人和前后依赖，旧客户文字、附件、成果、日期和预算全部不带入。请补充可复用的步骤说明。
              </p>
              <label>
                已完成任务
                <select
                  aria-label="已完成任务"
                  value={sourceTask}
                  onChange={(e) => setSourceTask(e.target.value)}
                >
                  <option value="">请选择</option>
                  {board.tasks
                    .filter((t) => t.status === 'completed')
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                </select>
              </label>
              <button
                disabled={busy || !sourceTask}
                onClick={() =>
                  void act(async () => {
                    setEdit(
                      await api<Entry>(
                        `${base}/reuse/template-source/${encodeURIComponent(sourceTask)}`,
                      ),
                    )
                    setMessage('流程结构已提取，请补充步骤说明后保存')
                  })
                }
              >
                提取流程结构
              </button>
            </details>
          )}
          <div
            className={`reuse-library-layout ${edit || selected || versions ? 'has-detail' : ''}`}
          >
            <div className="reuse-library">
              <p className="reuse-list-count">
                显示 {list.length} / {group.length} 条
              </p>
              {!loading &&
                !list.length &&
                (search || status !== 'all' || scope !== 'all' ? (
                  <p className="reuse-empty">没有符合筛选条件的条目。清空搜索或切换状态再试。</p>
                ) : (
                  <p>
                    还没有
                    {tab === 'template'
                      ? '流程模板。新建模板或从已完成流程提取结构，下一次只需填写变化参数。'
                      : '工作知识。先保存一条常用要求，后续秘书和任务会使用启用的适用内容。'}
                  </p>
                ))}
              <ul className="reuse-list">
                {list.map((item) => (
                  <li
                    key={item.id}
                    className={
                      edit?.id === item.id || selected?.id === item.id ? 'is-selected' : ''
                    }
                  >
                    <div>
                      <strong>{item.title}</strong>
                      <p className="reuse-excerpt">
                        {'content' in item.body
                          ? item.body.content.slice(0, 160)
                          : item.body.brief.goal}
                        {'content' in item.body && item.body.content.length > 160 ? '…' : ''}
                      </p>
                      <p>
                        {labels[item.kind]} · v{item.version} · {item.enabled ? '已启用' : '已停用'}{' '}
                        ·{' '}
                        {item.project || (item.kind === 'template' ? '每次填写项目' : '全项目适用')}
                      </p>
                      <p className="reuse-use-note">
                        {item.kind === 'template'
                          ? `${'steps' in item.body ? item.body.steps.length : 0} 个步骤 · 填参数后创建分工`
                          : item.enabled
                            ? '参与调用 · 秘书 / 新任务 / 普通员工对话'
                            : '已停用 · 新工作不再选入'}
                      </p>
                    </div>
                    <div className="reuse-actions">
                      {item.kind === 'template' && (
                        <>
                          <button
                            disabled={busy || !item.enabled || !canRun}
                            onClick={() => {
                              setSelected(item)
                              setValues({})
                              setPreview(undefined)
                              setEdit(undefined)
                              runId.current = undefined
                            }}
                          >
                            填写本次参数
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(async () =>
                                downloadWorkflow(
                                  await api(`${base}/reuse/${item.id}/export`),
                                  item.title,
                                ),
                              )
                            }
                          >
                            导出模板
                          </button>
                        </>
                      )}
                      <button
                        disabled={busy}
                        onClick={() => {
                          setEdit(structuredClone(item))
                          setSelected(undefined)
                          setVersions(undefined)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setVersions(
                              (
                                await api<{ items: NonNullable<typeof versions> }>(
                                  `${base}/reuse/${item.id}/versions`,
                                )
                              ).items,
                            )
                            setEdit(undefined)
                            setSelected(undefined)
                          })
                        }
                      >
                        查看版本
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `删除「${item.title}」及其版本记录？未来新任务不再使用；已有任务的原始要求和知识快照保留。`,
                            )
                          )
                            void act(async () => {
                              await api(
                                `${base}/reuse/${item.id}`,
                                { expectedVersion: item.version },
                                'DELETE',
                              )
                              await load()
                              setMessage('条目及版本已删除，已有任务快照保留')
                            })
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="reuse-workbench">
              {!edit && !selected && !versions && (
                <aside className="reuse-guide">
                  <h3>
                    {tab === 'template' ? '什么样的模板能直接使用？' : '保存之后，员工怎么用？'}
                  </h3>
                  <p>
                    {tab === 'template'
                      ? '可执行模板必须有清楚的步骤、系统内负责人、步骤要求和依赖关系。上传 JSON 后先校验，再填写变量、预览、创建待确认分工。'
                      : '秘书和新任务会按项目与当前问题选取启用条目；普通员工对话也会带入适用知识。下方可以预查本次会选中什么。'}
                  </p>
                  <p>
                    {tab === 'template'
                      ? '普通流程说明、n8n 或 Coze 文件目前需要先转换；上传文件不会自动执行其中的代码。'
                      : '知识按关键词与近义词匹配；记忆和品牌规则按项目带入。不是每条都必定命中，也不会追溯改写旧任务。'}
                  </p>
                </aside>
              )}
              {edit && (
                <form
                  className="reuse-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(async () => {
                      const { id, version, kind, title, project, enabled, body } = edit
                      await api(
                        `${base}/reuse${id ? '/' + id : ''}`,
                        {
                          kind,
                          title,
                          project,
                          enabled,
                          body,
                          ...(id ? { expectedVersion: version } : {}),
                        },
                        id ? 'PUT' : 'POST',
                      )
                      setEdit(undefined)
                      await load()
                      setMessage('已保存，新任务将使用启用的最新版本')
                    })
                  }}
                >
                  <h2>
                    {edit.id ? '编辑' : '新增'}
                    {labels[edit.kind]}
                  </h2>
                  <label>
                    名称
                    <input
                      required
                      maxLength={100}
                      value={edit.title}
                      onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                    />
                  </label>
                  {edit.kind !== 'template' && (
                    <label>
                      适用项目（留空为全项目）
                      <input
                        maxLength={80}
                        value={edit.project}
                        onChange={(e) => setEdit({ ...edit, project: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="reuse-check">
                    <input
                      type="checkbox"
                      checked={edit.enabled}
                      onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
                    />{' '}
                    启用，用于后续工作
                  </label>
                  {'content' in edit.body && (
                    <>
                      <label>
                        内容
                        <textarea
                          aria-label="内容"
                          required
                          rows={6}
                          maxLength={4000}
                          value={edit.body.content}
                          onChange={(e) =>
                            setEdit({
                              ...edit,
                              body: {
                                ...(edit.body as { content: string; source: string }),
                                content: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        来源或确认依据
                        <input
                          required
                          maxLength={300}
                          value={edit.body.source}
                          onChange={(e) =>
                            setEdit({
                              ...edit,
                              body: {
                                ...(edit.body as { content: string; source: string }),
                                source: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <p>
                        仅主动保存的内容会成为知识；不同项目按名称精确匹配。修改后保留历史版本；当前明确要求优先，冲突应由员工说明。
                      </p>
                    </>
                  )}
                  {body && (
                    <>
                      <p>
                        把每次变化的内容写成 {'{{参数名}}'}
                        。不要写入旧客户私有资料。保存模板不会启动任务。
                      </p>
                      <TaskBriefFields
                        value={body.brief}
                        onChange={(brief) => updateWorkflow({ ...body, brief })}
                        disabled={busy}
                      />
                      {body.steps.map((step, i) => (
                        <fieldset key={i}>
                          <legend>流程步骤 {i + 1}</legend>
                          <label>
                            步骤名称
                            <input
                              required
                              maxLength={120}
                              value={step.title}
                              onChange={(e) =>
                                updateWorkflow({
                                  ...body,
                                  steps: body.steps.map((s, n) =>
                                    n === i ? { ...s, title: e.target.value } : s,
                                  ),
                                })
                              }
                            />
                          </label>
                          <label>
                            负责人
                            <select
                              aria-label="负责人"
                              value={step.dept}
                              onChange={(e) =>
                                updateWorkflow({
                                  ...body,
                                  steps: body.steps.map((s, n) =>
                                    n === i ? { ...s, dept: e.target.value } : s,
                                  ),
                                })
                              }
                            >
                              {departments.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name} · {d.person}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            步骤要求
                            <textarea
                              aria-label="步骤要求"
                              required
                              rows={3}
                              maxLength={2000}
                              value={step.brief}
                              onChange={(e) =>
                                updateWorkflow({
                                  ...body,
                                  steps: body.steps.map((s, n) =>
                                    n === i ? { ...s, brief: e.target.value } : s,
                                  ),
                                })
                              }
                            />
                          </label>
                          <p>需要先完成：</p>
                          {body.steps.map(
                            (s, n) =>
                              n !== i && (
                                <label className="reuse-check" key={n}>
                                  <input
                                    type="checkbox"
                                    checked={step.dependsOn.includes(n)}
                                    onChange={(e) =>
                                      updateWorkflow({
                                        ...body,
                                        steps: body.steps.map((s, j) =>
                                          j === i
                                            ? {
                                                ...s,
                                                dependsOn: e.target.checked
                                                  ? [...s.dependsOn, n]
                                                  : s.dependsOn.filter((x) => x !== n),
                                              }
                                            : s,
                                        ),
                                      })
                                    }
                                  />
                                  步骤 {n + 1} · {s.title}
                                </label>
                              ),
                          )}
                          <button
                            type="button"
                            disabled={body.steps.length === 1}
                            onClick={() =>
                              updateWorkflow({
                                ...body,
                                steps: body.steps
                                  .filter((_, n) => n !== i)
                                  .map((s) => ({
                                    ...s,
                                    dependsOn: s.dependsOn
                                      .filter((n) => n !== i)
                                      .map((n) => (n > i ? n - 1 : n)),
                                  })),
                              })
                            }
                          >
                            移除此步骤
                          </button>
                        </fieldset>
                      ))}
                      <button
                        type="button"
                        disabled={body.steps.length >= 10}
                        onClick={() =>
                          updateWorkflow({
                            ...body,
                            steps: [
                              ...body.steps,
                              { title: '', dept: 'file-agent', brief: '{{目标}}', dependsOn: [] },
                            ],
                          })
                        }
                      >
                        添加流程步骤
                      </button>
                    </>
                  )}
                  <div className="reuse-actions">
                    <button disabled={busy}>保存{edit.id ? '新版本' : ''}</button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm('放弃尚未保存的编辑？')) setEdit(undefined)
                      }}
                    >
                      取消编辑
                    </button>
                  </div>
                </form>
              )}
              {selected && (
                <form
                  className="reuse-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(async () => {
                      setPreview(
                        await api<Workflow>(`${base}/reuse/${selected.id}/preview`, {
                          values,
                          version: selected.version,
                        }),
                      )
                      runId.current = crypto.randomUUID()
                    })
                  }}
                >
                  <h2>复用 · {selected.title}</h2>
                  <p>模板 v{selected.version}。先预览，再创建待确认分工；此操作不调用模型。</p>
                  {parameters(selected).map((name) => (
                    <label key={name}>
                      {name}
                      <textarea
                        aria-label={name}
                        required
                        rows={2}
                        maxLength={1000}
                        value={values[name] || ''}
                        onChange={(e) => {
                          setValues({ ...values, [name]: e.target.value })
                          setPreview(undefined)
                        }}
                      />
                    </label>
                  ))}
                  <label>
                    本次截止日期
                    <input
                      required
                      type="date"
                      value={due}
                      onChange={(e) => {
                        setDue(e.target.value)
                        setPreview(undefined)
                      }}
                    />
                  </label>
                  <button disabled={busy || !due}>预览本次流程</button>
                  {preview && (
                    <section aria-label="本次流程预览">
                      <h3>待确认的本次要求</h3>
                      <dl>
                        {briefFields
                          .filter(([k]) => preview.brief[k])
                          .map(([k, label]) => (
                            <div key={k}>
                              <dt>{label}</dt>
                              <dd>{preview.brief[k]}</dd>
                            </div>
                          ))}
                      </dl>
                      <ol>
                        {preview.steps.map((s, i) => (
                          <li key={i}>
                            <strong>{s.title}</strong> ·{' '}
                            {departments.find((d) => d.id === s.dept)?.person}
                            <p>{s.brief}</p>
                            <p>
                              {s.dependsOn.length
                                ? `等待步骤 ${s.dependsOn.map((n) => n + 1).join('、')}`
                                : '无前置步骤'}
                            </p>
                          </li>
                        ))}
                      </ol>
                      <p>
                        新任务会附上当前启用且适用于本次项目的知识快照。调研流程自动补归档步骤。
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const result = await api<{ board: Board }>(
                              `${base}/reuse/${selected.id}/draft`,
                              { values, version: selected.version, requestId: runId.current, due },
                            )
                            setPreview(undefined)
                            setSelected(undefined)
                            onDraft(result.board)
                          })
                        }
                      >
                        创建待确认分工
                      </button>
                    </section>
                  )}
                </form>
              )}
              {versions && (
                <section>
                  <h2>历史版本</h2>
                  {versions.map((v) => (
                    <details key={v.version}>
                      <summary>
                        {v.title} · v{v.version} · {v.project || '全项目'}
                      </summary>
                      {'content' in v.body ? (
                        <>
                          <p className="reuse-text">{v.body.content}</p>
                          <p>来源：{v.body.source}</p>
                        </>
                      ) : (
                        <>
                          <dl>
                            {briefFields.map(([k, label]) => (
                              <div key={k}>
                                <dt>{label}</dt>
                                <dd>{'brief' in v.body && v.body.brief[k]}</dd>
                              </div>
                            ))}
                          </dl>
                          <ol>
                            {v.body.steps.map((s, i) => (
                              <li key={i}>
                                {s.title}：{s.brief}
                              </li>
                            ))}
                          </ol>
                        </>
                      )}
                    </details>
                  ))}
                </section>
              )}
              {tab !== 'template' && (
                <details>
                  <summary>检查本次会用到哪些知识</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      void act(async () => {
                        setFound(
                          (
                            await api<{ items: NonNullable<typeof found> }>(
                              `${base}/reuse/search`,
                              {
                                question,
                                project,
                              },
                            )
                          ).items,
                        )
                      })
                    }}
                  >
                    <label>
                      本次项目
                      <input
                        maxLength={80}
                        value={project}
                        onChange={(e) => {
                          setProject(e.target.value)
                          setFound(undefined)
                        }}
                      />
                    </label>
                    <label>
                      本次问题
                      <input
                        required
                        maxLength={1000}
                        value={question}
                        onChange={(e) => {
                          setQuestion(e.target.value)
                          setFound(undefined)
                        }}
                      />
                    </label>
                    <button disabled={busy}>检索工作知识</button>
                  </form>
                  <p>
                    长期记忆与品牌规则按项目带入；项目资料按关键词和常见近义词选取。每次最多 12
                    条、正文总计 12000 字，不额外调用模型。
                  </p>
                  {found &&
                    (found.length ? (
                      found.map((f, i) => (
                        <article key={i}>
                          <h3>
                            {f.title} · v{f.version}
                          </h3>
                          <p className="reuse-text">{f.content}</p>
                          <p>来源：{f.source}</p>
                        </article>
                      ))
                    ) : (
                      <p>没有匹配的已启用知识，请核对项目名或补充关键词。</p>
                    ))}
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export function TaskReuseDetails({ base, task }: { base: string; task: Task }) {
  const [rating, setRating] = useState('adopted'),
    [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [items, setItems] = useState<
    { id: string; rating: string; note: string; created_at: string }[]
  >([])
  const load = useCallback(
    () =>
      api<{ items: typeof items }>(`${base}/reuse/feedback/${encodeURIComponent(task.id)}`).then(
        (r) => setItems(r.items),
      ),
    [base, task.id],
  )
  useEffect(() => {
    load().catch(() => setError('反馈读取失败，请重新打开任务'))
  }, [load])
  return (
    <section className="reuse-task">
      {task.templateSource && (
        <p>
          来自模板「{task.templateSource.title}」v{task.templateSource.version}
        </p>
      )}
      {task.knowledgeSnapshot && (
        <details>
          <summary>本次使用的工作知识 · {task.knowledgeSnapshot.records.length} 条</summary>
          <p>任务创建时的快照；后续更正或删除知识不会改写本次原始要求。</p>
          {task.knowledgeSnapshot.records.map((r) => (
            <article key={r.id}>
              <h3>
                {r.title} · v{r.version}
              </h3>
              <p className="reuse-text">{r.content}</p>
              <p>
                来源：{r.source} · {r.project || '全项目适用'}
              </p>
            </article>
          ))}
        </details>
      )}
      {['completed', 'review', 'revision', 'approval'].includes(task.status) && (
        <details>
          <summary>成果使用反馈</summary>
          <p>记录是否有用，不会自动重新执行、扣费或替代正式审核。</p>
          {error && <p role="alert">{error}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setBusy(true)
              setError('')
              api(`${base}/reuse/feedback/${encodeURIComponent(task.id)}`, { rating, note })
                .then(() => {
                  setNote('')
                  return load()
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false))
            }}
          >
            <label>
              使用结果
              <select
                aria-label="使用结果"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
              >
                <option value="adopted">已采纳</option>
                <option value="revise">需要修改</option>
                <option value="unusable">暂不可用</option>
              </select>
            </label>
            <label>
              具体反馈
              <textarea
                aria-label="具体反馈"
                required
                maxLength={1000}
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button disabled={busy}>保存反馈</button>
          </form>
          <ul>
            {items.map((i) => (
              <li key={i.id}>
                {{ adopted: '已采纳', revise: '需要修改', unusable: '暂不可用' }[i.rating]} ·{' '}
                {i.note} · {new Date(i.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
