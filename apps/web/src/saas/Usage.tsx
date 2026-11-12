import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { csvCell, dollars, toMicros } from './billing-format'
import './billing.css'
type Call = {
  rate_snapshot?: { input?: string; output?: string; saleInput: string; saleOutput: string } | null
  id: string
  task_id: string | null
  user_id: string | null
  department: string
  step: string
  model: string
  kind: string
  state: string
  legacy: boolean
  cost_microusd: string | null
  sale_microusd: string | null
  reviewed_cost: string | null
  review_reference: string | null
  reserved_microusd: string | null
  provider_request_id: string | null
  price_id: string | null
  input_tokens: string | null
  output_tokens: string | null
  created_at: string
  finished_at: string | null
}
type Price = {
  id: string
  model: string
  input_microusd: string
  output_microusd: string
  sale_input_microusd: string
  sale_output_microusd: string
  reference: string
}
type Billing = {
  role: string
  day: string
  summary: { calls: number; unpriced: number; known_cost: string | null; known_sale: string }
  legacy: { calls: number; unknown: number }
  limits: { enabled: boolean; daily_microusd: string } | null
  today: { used: string; reserved: string; unpriced: number } | null
  prices: Price[]
  testOrdersEnabled: boolean
  coverage: string
}
type Page = { calls: Call[]; hasMore: boolean; offset: number }
type Order = { id: string; amount_microusd: string; state: string }
const kinds: Record<string, string> = {
  text: '文字',
  search: '联网搜索',
  image: '图片',
  video: '视频',
  audio: '语音',
  tool: '工具',
}
const departments: Record<string, string> = {
  secretary: '秘书处',
  content_ops: '运营部',
  archive: '资料室',
  design: '设计部',
  dev: '程序部',
  market_research: '市场调研',
  outreach: '拓客部',
  compliance: '合规部',
  intern: '实习生',
}
const states: Record<string, string> = {
  pending: '处理中',
  completed: '已返回',
  rejected: '请求被拒绝',
  unknown: '结果待核对',
}
const time = (s: string) =>
  new Date(s).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
export function Usage({ base }: { base: string }) {
  const loaded = useRef(false)
  const routeParams = new URLSearchParams(location.hash.slice(1))
  const requestedTask = routeParams.get('workspace') === base.split('/').at(-1) && /^[a-zA-Z0-9_-]{1,80}$/.test(routeParams.get('budgetTask') || '') ? routeParams.get('budgetTask')! : ''
  const [taskBudget, setTaskBudget] = useState({ taskId: requestedTask, amount: '', enabled: true }),
    [taskLimits, setTaskLimits] = useState<
      { task_id: string; enabled: boolean; amount_microusd: string }[]
    >([])
  const [data, setData] = useState<Billing>(),
    [page, setPage] = useState<Page>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [attention, setAttention] = useState(false),
    [task, setTask] = useState(''),
    [filter, setFilter] = useState(requestedTask),
    [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Call>(),
    [daily, setDaily] = useState(''),
    [enabled, setEnabled] = useState(false)
  const [rate, setRate] = useState({
      model: '',
      input: '',
      output: '',
      saleInput: '',
      saleOutput: '',
      reference: '',
    }),
    [review, setReview] = useState({ upstream: '', reference: '' }),
    [orders, setOrders] = useState<Order[]>([])
  const query = `?offset=${offset}${attention ? '&attention=true' : ''}${filter ? `&task=${encodeURIComponent(filter)}` : ''}`
  const refresh = useCallback(async () => {
    const [a, b] = await Promise.all([
      api<Billing>(`${base}/billing`),
      api<Page>(`${base}/billing/calls${query}`),
    ])
    setData(a)
    setPage(b)
    if (a.role !== 'member')
      setTaskLimits(
        (await api<{ limits: typeof taskLimits }>(`${base}/billing/task-limits`)).limits,
      )
    if (a.testOrdersEnabled && a.role !== 'member')
      setOrders((await api<{ orders: Order[] }>(`${base}/billing/test-orders`)).orders)
  }, [base, query])
  useEffect(() => {
    let active = true
    Promise.all([api<Billing>(`${base}/billing`), api<Page>(`${base}/billing/calls${query}`)])
      .then(([a, b]) => {
        if (active) {
          setData(a)
          setPage(b)
          setError('')
          if (!loaded.current && a.limits) {
            setDaily(dollars(a.limits.daily_microusd).slice(1))
            setEnabled(a.limits.enabled)
            loaded.current = true
          }
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base, query])
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      await refresh()
      setNotice(message)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const admin = !!data && data.role !== 'member'
  function exportPage() {
    if (!page) return
    const rows = [
      [
        '调用编号',
        '任务编号',
        '北京时间',
        '类别',
        '模型',
        '状态',
        '输入词元',
        '输出词元',
        '估算采购USD微元',
        '估算售价USD微元',
        '人工核对采购USD微元',
        '服务商请求编号',
        '价格版本',
      ],
      ...page.calls.map((c) => [
        c.id,
        c.task_id,
        time(c.created_at),
        kinds[c.kind],
        c.model,
        states[c.state],
        c.input_tokens,
        c.output_tokens,
        c.cost_microusd,
        c.sale_microusd,
        c.reviewed_cost,
        c.provider_request_id,
        c.price_id,
      ]),
    ]
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = 'Wishtaday-费用明细-当前页.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="billing-page">
      <header className="billing-title">
        <div>
          <h1>用量与费用</h1>
          <p>先核对待确认费用，再决定是否继续任务。</p>
        </div>
        <button disabled={busy} onClick={() => act(async () => {}, '已刷新')}>
          刷新记录
        </button>
      </header>
      {error && (
        <p role="alert" className="billing-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!data ? (
        <p role="status">正在读取费用记录…</p>
      ) : (
        <>
          <div className="billing-totals">
            <div>
              <span>待核价调用 · 全部历史</span>
              <strong>{data.summary.unpriced}</strong>
            </div>
            <div>
              <span>已记录调用 · 全部历史</span>
              <strong>{data.summary.calls}</strong>
            </div>
            <div>
              <span>{admin ? '已核价部分的采购金额' : '已核价部分的估算使用费'} · USD</span>
              <strong>
                {data.summary.unpriced === data.summary.calls && data.summary.calls > 0
                  ? '待核价'
                  : dollars(admin ? data.summary.known_cost : data.summary.known_sale)}
              </strong>
            </div>
          </div>
          <p className="billing-note">
            美元计价 · 北京时间。待核价不等于免费；目前未启用真实扣款。
          </p>
          <section aria-label="调用明细">
            <div className="billing-toolbar">
              <h2>调用明细</h2>
              <button disabled={!page?.calls.length} onClick={exportPage}>
                导出当前页 CSV
              </button>
            </div>
            <form
              className="billing-toolbar"
              onSubmit={(e) => {
                e.preventDefault()
                setFilter(task.trim())
                setOffset(0)
                setSelected(undefined)
              }}
            >
              <label>
                任务编号
                <input
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                  placeholder="全部任务与日常对话"
                />
              </label>
              <button>筛选</button>
              <label className="billing-check">
                <input
                  type="checkbox"
                  checked={attention}
                  onChange={(e) => {
                    setAttention(e.target.checked)
                    setOffset(0)
                    setSelected(undefined)
                  }}
                />
                仅看未核对
              </label>
            </form>
            {!page ? (
              <p>正在读取明细…</p>
            ) : !page.calls.length ? (
              <p className="billing-empty">
                当前条件下没有调用记录。发生新的模型调用后会自动记录。
              </p>
            ) : (
              <div className="billing-table">
                <table>
                  <thead>
                    <tr>
                      <th>时间与用途</th>
                      <th>模型与类别</th>
                      <th>处理状态</th>
                      <th className="num">{admin ? '采购估算 / 核对' : '使用费估算'} · USD</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.calls.map((c) => (
                      <tr key={c.id}>
                        <td>
                          {time(c.created_at)}
                          <small>
                            {departments[c.step] || c.step} ·{' '}
                            {c.task_id
                              ? `任务 ${c.task_id.slice(0, 8)}`
                              : c.user_id
                                ? c.legacy
                                  ? '历史调用 · 未关联任务'
                                  : '日常调用'
                                : '运行服务 · 未关联任务'}
                          </small>
                        </td>
                        <td>
                          {c.model}
                          <small>
                            {kinds[c.kind]}
                            {c.legacy ? ' · 历史记录' : ''}
                          </small>
                        </td>
                        <td>
                          {states[c.state]}
                          <small>
                            {c.review_reference
                              ? '已附人工核对凭证'
                              : c.cost_microusd === null
                                ? '费用待核对'
                                : '按调用时价格估算'}
                          </small>
                        </td>
                        <td className="num">
                          {dollars(admin ? c.cost_microusd : c.sale_microusd)}
                          {admin && c.reviewed_cost !== null && (
                            <small>核对 {dollars(c.reviewed_cost)}</small>
                          )}
                        </td>
                        <td>
                          <button
                            aria-label={`查看调用 ${c.id}`}
                            onClick={() => {
                              setSelected(c)
                              setReview({ upstream: '', reference: '' })
                            }}
                          >
                            详情
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!!page && (offset > 0 || page.hasMore) && (
              <div className="billing-toolbar">
                <button
                  disabled={offset === 0 || busy}
                  onClick={() => {
                    setOffset(Math.max(0, offset - 50))
                    setSelected(undefined)
                  }}
                >
                  上一页
                </button>
                <span>
                  第 {offset + 1}–{offset + page.calls.length} 条
                </span>
                <button
                  disabled={!page.hasMore || busy}
                  onClick={() => {
                    setOffset(offset + 50)
                    setSelected(undefined)
                  }}
                >
                  下一页
                </button>
              </div>
            )}
          </section>
          {selected && (
            <section className="billing-detail" aria-label="调用详情">
              <div className="billing-toolbar">
                <h2>调用详情</h2>
                <button onClick={() => setSelected(undefined)}>收起详情</button>
              </div>
              <dl>
                {[
                  ['调用编号', selected.id],
                  ['任务编号', selected.task_id || '尚未关联'],
                  ['上游请求编号', selected.provider_request_id || '上游未提供或历史未记录'],
                  ['价格版本', selected.price_id || '尚未核价'],
                  [
                    '调用时单价（USD / 百万词元）',
                    selected.rate_snapshot
                      ? `${dollars(admin ? selected.rate_snapshot.input : selected.rate_snapshot.saleInput)} 输入 / ${dollars(admin ? selected.rate_snapshot.output : selected.rate_snapshot.saleOutput)} 输出`
                      : '未记录价格',
                  ],
                  [
                    '用量（输入 / 输出词元）',
                    `${selected.input_tokens ?? '未知'} / ${selected.output_tokens ?? '未知'}`,
                  ],
                  [
                    '耗时',
                    selected.finished_at
                      ? `${((+new Date(selected.finished_at) - +new Date(selected.created_at)) / 1000).toFixed(1)} 秒`
                      : '仍在处理',
                  ],
                  ['核对凭证', selected.review_reference || '尚未添加'],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              {admin && selected.state !== 'pending' && !selected.review_reference && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act(async () => {
                      await api(`${base}/billing/reviews`, {
                        callId: selected.id,
                        upstream: toMicros(review.upstream),
                        reference: review.reference,
                      })
                      setSelected(undefined)
                    }, '已保存人工核对凭证，原始调用状态保留')
                  }}
                >
                  <h3>记录上游账单核对结果</h3>
                  <p>
                    仅在拿到真实账单后填写。此操作保留原始记录，不能直接退款，也不会释放旧词元预占。
                  </p>
                  <div className="billing-form">
                    <label>
                      上游实际收费（USD）
                      <input
                        required
                        inputMode="decimal"
                        value={review.upstream}
                        onChange={(e) => setReview({ ...review, upstream: e.target.value })}
                      />
                    </label>
                    <label>
                      账单或工单编号
                      <input
                        required
                        maxLength={120}
                        value={review.reference}
                        onChange={(e) => setReview({ ...review, reference: e.target.value })}
                      />
                    </label>
                  </div>
                  <button disabled={busy}>保存核对凭证</button>
                </form>
              )}
            </section>
          )}
          {admin && (
            <details className="billing-settings">
              <summary>金额预算 · {data.limits?.enabled ? '已开启' : '未开启'}</summary>
              <p>
                北京时间 {data.day}：已计入 {dollars(data.today?.used)}，预留{' '}
                {dollars(data.today?.reserved)}。当前日预算 {dollars(data.limits?.daily_microusd)}。
              </p>
              <p>
                预算按采购估算拦截后续调用，不能保证上游最终费用不超过估算。开启后，缺少可靠价格的媒体、搜索及工具调用会暂停；历史待核对费用也会阻止继续调用。任务需求单中的文字预算仍是参考要求。
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(
                    () => api(`${base}/billing/limit`, { enabled, daily: toMicros(daily) }),
                    '预算已保存',
                  )
                }}
              >
                <div className="billing-form">
                  <label>
                    新的每日预算（USD）
                    <input
                      required
                      inputMode="decimal"
                      value={daily}
                      onChange={(e) => setDaily(e.target.value)}
                    />
                  </label>
                  <label className="billing-check">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                    />
                    保存时开启金额拦截
                  </label>
                </div>
                <button disabled={busy}>保存预算</button>
              </form>
            </details>
          )}
          {admin && (
            <details className="billing-settings" open={!!requestedTask}>
              <summary>单个任务的金额上限</summary>
              {requestedTask && <p>已带入受阻任务编号；填写金额并保存后才会修改预算。<a href={`#${new URLSearchParams({ workspace: base.split('/').at(-1) || '', view: 'tasks', filter: 'all', task: requestedTask })}`}>返回任务问题处理</a></p>}
              <p>
                调研、资料与普通员工任务可独立设置。先创建分工，再填写任务编号；限额跨天累计。视频任务尚不能逐次关联，需使用企业日预算。此处保存才会启用拦截，需求单里的文字不会自动设置限额。
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(
                    () =>
                      api(`${base}/billing/task-limits`, {
                        taskId: taskBudget.taskId,
                        enabled: taskBudget.enabled,
                        amount: toMicros(taskBudget.amount),
                      }),
                    '任务金额上限已保存',
                  )
                }}
              >
                <div className="billing-form">
                  <label>
                    需要限制的任务编号
                    <input
                      required
                      value={taskBudget.taskId}
                      onChange={(e) => setTaskBudget({ ...taskBudget, taskId: e.target.value })}
                    />
                  </label>
                  <label>
                    任务累计采购预算（USD）
                    <input
                      required
                      inputMode="decimal"
                      value={taskBudget.amount}
                      onChange={(e) => setTaskBudget({ ...taskBudget, amount: e.target.value })}
                    />
                  </label>
                  <label className="billing-check">
                    <input
                      type="checkbox"
                      checked={taskBudget.enabled}
                      onChange={(e) => setTaskBudget({ ...taskBudget, enabled: e.target.checked })}
                    />
                    启用任务金额拦截
                  </label>
                </div>
                <button disabled={busy}>保存任务上限</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(async () => {}, '任务上限已读取')}
                >
                  读取已有上限
                </button>
              </form>
              {taskLimits.map((l) => (
                <p key={l.task_id}>
                  {l.task_id} · {dollars(l.amount_microusd)} · {l.enabled ? '启用' : '停用'}
                </p>
              ))}
            </details>
          )}
          {admin && (
            <details className="billing-settings">
              <summary>文字模型价格 · {data.prices.length} 个已配置</summary>
              <p>
                单价单位为 USD /
                百万词元。每次保存立即产生新版本，旧账单不重算。此版本按含税总价填写；缓存折扣、搜索和媒体附加费用尚待供应商核验。售价仅用于估算报价，尚未收款。
              </p>
              {data.prices.map((p) => (
                <p key={p.id}>
                  {p.model}：采购 {dollars(p.input_microusd)} / {dollars(p.output_microusd)}；售价{' '}
                  {dollars(p.sale_input_microusd)} / {dollars(p.sale_output_microusd)} ·{' '}
                  {p.reference}
                </p>
              ))}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void act(
                    () =>
                      api(`${base}/billing/prices`, {
                        ...rate,
                        input: toMicros(rate.input),
                        output: toMicros(rate.output),
                        saleInput: toMicros(rate.saleInput),
                        saleOutput: toMicros(rate.saleOutput),
                      }),
                    '新价格版本已保存',
                  )
                }}
              >
                <div className="billing-form">
                  {(
                    [
                      ['model', '模型编号'],
                      ['input', '输入采购单价'],
                      ['output', '输出采购单价'],
                      ['saleInput', '输入售价'],
                      ['saleOutput', '输出售价'],
                      ['reference', '价格凭证编号'],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k}>
                      {label}
                      <input
                        required
                        maxLength={k === 'model' ? 160 : 120}
                        value={rate[k]}
                        onChange={(e) => setRate({ ...rate, [k]: e.target.value })}
                      />
                    </label>
                  ))}
                </div>
                <button disabled={busy}>保存新的价格版本</button>
              </form>
            </details>
          )}
          <details className="billing-settings">
            <summary>支付、退款与核对范围</summary>
            <p>{data.coverage}</p>
            <p>
              采购金额优先采用人工核对数，未核对部分按保存单价估算；估算使用费是按售价计算的报价。核对结果与原始估算并列保留。
            </p>
            <p>
              真实支付宝、微信支付、4yi
              账户余额与账单接口尚未核验接入。没有可展示的真实账户余额；当前不会自动扣款或退款。
            </p>
            <p>
              旧文字调用共 {data.legacy.calls} 次，其中 {data.legacy.unknown}{' '}
              次结果待核对。历史记录不会按新单价补算。云端助手原有用量见下方历史汇总，尚未合并到本明细。
            </p>
            {data.testOrdersEnabled && admin && (
              <>
                <h3>隔离测试订单 · 不涉及真实资金</h3>
                <button
                  disabled={busy}
                  onClick={() =>
                    act(
                      () =>
                        api(`${base}/billing/test-orders`, {
                          requestId: crypto.randomUUID(),
                          amount: '1000000',
                        }),
                      '已创建 1 美元模拟订单',
                    )
                  }
                >
                  创建 1 美元模拟订单
                </button>
                <button disabled={busy} onClick={() => act(async () => {}, '测试订单已刷新')}>
                  查看测试订单
                </button>
                {orders.map((o) => (
                  <div className="billing-toolbar" key={o.id}>
                    <span>
                      {o.id.slice(0, 8)} · {dollars(o.amount_microusd)} ·{' '}
                      {
                        { pending: '待模拟支付', paid: '已模拟支付', refunded: '已模拟退款' }[
                          o.state
                        ]
                      }
                    </span>
                    {o.state !== 'refunded' && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              api(`${base}/billing/test-orders/${o.id}/events`, {
                                event: o.state === 'pending' ? 'paid' : 'refunded',
                                amount: o.amount_microusd,
                              }),
                            '模拟订单状态已更新',
                          )
                        }
                      >
                        {o.state === 'pending' ? '模拟支付成功' : '模拟全额退款'}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </details>
          <LegacyUsage base={base} />
        </>
      )}
    </div>
  )
}
function LegacyUsage({ base }: { base: string }) {
  const [rows, setRows] = useState<
      {
        operation: string
        status: string
        requests: number
        input_tokens: string
        output_tokens: string
      }[]
    >(),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    api<{ usage: NonNullable<typeof rows> }>(`${base}/usage`)
      .then((r) => {
        if (active) setRows(r.usage)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    return () => {
      active = false
    }
  }, [base])
  return (
    <details className="billing-settings">
      <summary>云端助手原有用量（UTC 自然月）</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : !rows ? (
        <p>正在读取…</p>
      ) : !rows.length ? (
        <p>本月没有云端助手调用。</p>
      ) : (
        rows.map((r, i) => (
          <p key={i}>
            {r.operation} · {r.status} · {r.requests} 次 · 输入 {r.input_tokens} / 输出{' '}
            {r.output_tokens} 词元
          </p>
        ))
      )}
    </details>
  )
}
