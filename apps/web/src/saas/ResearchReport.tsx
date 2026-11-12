import { useRef, useState } from 'react'
import { api } from './api'
import type { Board, Task } from '../../../../packages/secretary/model.mjs'
import { researchQualityLabel } from '../../../../packages/secretary/research-quality.mjs'
import { ReportMarkdown } from './ReportMarkdown'
import { legacyReportSections } from './research-markdown'
function ReportOverview({ title, text, sources }: { title: string; text: string; sources: Task['sources'] }) {
  const long = text.length > 700
  return <section><h3>{title}</h3><ReportMarkdown text={long ? text.slice(0, 500) + '…' : text} sources={sources} />
    {long && <details><summary>展开本节全文（上方为原文节选）</summary><ReportMarkdown text={text} sources={sources} /></details>}
  </section>
}
export function ResearchReport({ task, base, canEdit, onUpdate, onSelect }: { task: Task; base: string; canEdit: boolean; onUpdate: (board: Board) => void; onSelect: (id: string) => void }) {
  const [feedback, setFeedback] = useState(''), [cost, setCost] = useState(false), [gaps, setGaps] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submission = useRef<{ id: string; feedback: string } | null>(null)
  const quality = task.quality, sections = task.reportSections || legacyReportSections(task.summary || '')
  const questions = quality?.questions || [], missing = questions.filter(q => q.status !== 'covered')
  const actionable = canEdit && ['review-agent', 'new-agent-8'].includes(task.dept)
  async function act(kind: 'accept' | 'follow-up') {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (kind === 'follow-up' && submission.current?.feedback !== feedback.trim()) submission.current = { id: crypto.randomUUID(), feedback: feedback.trim() }
      const result = await api<{ board: Board; taskId?: string }>(`${base}/research/tasks/${task.id}/${kind}`, kind === 'accept' ? { acknowledgeGaps: gaps } : { requestId: submission.current?.id, feedback: feedback.trim(), acknowledgeCost: cost })
      onUpdate(result.board)
      if (result.taskId) onSelect(result.taskId)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="research-report" aria-label="调研成果与验收">
    <div className="research-quality" role="status">
      <strong>{researchQualityLabel(quality)}</strong>
      {quality?.acceptance && <p>已接受当前范围 · {new Date(quality.acceptance.at).toLocaleString()}。接受不代表缺口已消除。</p>}
      {!!questions.length && <p>{questions.length} 个问题中，{questions.length - missing.length} 个有对应原文，{missing.length} 个仍需补充。自动检查不能替代人工判断。</p>}
      {!quality && <p>旧报告保持原样。尚未进行逐题证据核查，可另建补查任务。</p>}
      {!!missing.length && <details><summary>需要补充的证据</summary><ul>{missing.map(q => <li key={q.id}><strong>{q.question}</strong><p>{q.reason}</p></li>)}</ul></details>}
      {!!quality?.issues.length && <details><summary>检索与核查说明</summary><ul>{quality.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
      {!!questions.length && <details><summary>逐题查看依据</summary>{questions.map(q => <div key={q.id}><h4>{q.question} · {q.status === 'covered' ? '有原文支持' : q.status === 'partial' ? '部分支持' : '缺少证据'}</h4><p>{q.reason}</p>{q.evidence.map((e, i) => <blockquote key={i}><ReportMarkdown text={`[${e.sourceId}] ${e.quote}`} sources={task.sources} /></blockquote>)}</div>)}</details>}
    </div>
    {sections.summary && <ReportOverview title="先看结论" text={sections.summary} sources={task.sources} />}
    {sections.recommendations && <ReportOverview title="建议怎么做" text={sections.recommendations} sources={task.sources} />}
    {([['findings', '事实与对比'], ['analysis', '分析与推断'], ['limitations', '局限与缺口']] as const).map(([key, label]) => sections[key] && <details key={key}><summary>{label}</summary><ReportMarkdown text={sections[key]} sources={task.sources} /></details>)}
    {Object.keys(sections).length ? <details><summary>查看完整原报告</summary><ReportMarkdown text={task.summary || ''} sources={task.sources} /></details> : <ReportMarkdown text={task.summary || ''} sources={task.sources} />}
    {actionable && <div className="research-review">
      <h3>下一步</h3>
      {quality && !quality.acceptance && <div>
        {quality.status === 'partial' && <label><input type="checkbox" checked={gaps} onChange={e => setGaps(e.target.checked)} />我已了解上述缺口，接受当前交付范围</label>}
        <button disabled={busy || (quality.status === 'partial' && !gaps)} onClick={() => void act('accept')}>接受当前成果</button>
      </div>}
      <details><summary>补充调研，保留原报告</summary>
        <label htmlFor="research-feedback">本轮重点要补查什么</label>
        <textarea id="research-feedback" value={feedback} onChange={e => setFeedback(e.target.value)} maxLength={1000} disabled={busy} rows={3} placeholder="例如：核对三家产品的官方价格，缺少证据就明确标出" />
        <p>另建关联任务并归档新报告。单次最多 6 次搜索、12 次网页读取；检索核查达到 6 分钟后不再新增调用，进行中的调用和报告汇总另计时间。</p>
        <label><input type="checkbox" checked={cost} onChange={e => setCost(e.target.checked)} />我了解补查会使用现有模型额度，实际费用由服务商计费</label>
        <button disabled={busy || !cost || !feedback.trim()} onClick={() => void act('follow-up')}>{busy ? '正在提交…' : '创建补查任务'}</button>
      </details>
      {error && <p role="alert" className="error">{error}</p>}
    </div>}
  </section>
}
