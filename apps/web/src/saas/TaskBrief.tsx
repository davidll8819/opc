import { briefFields, type TaskBrief, type BriefSnapshot } from '../../../../packages/secretary/task-brief.mjs'
export function TaskBriefFields({ value, onChange, disabled }: { value: TaskBrief; onChange: (v: TaskBrief) => void; disabled: boolean }) {
  return <div className="task-brief-fields">
    <p>填写后随本次任务保存；预算文字用于说明要求，尚不是自动扣费上限。实际用量请查看“用量与费用”。</p>
    {briefFields.map(([key, label, limit]) => <label key={key}>{label}{key === 'goal' ? '（必填）' : '（选填）'}
      <textarea rows={key === 'goal' || key === 'acceptance' ? 3 : 2} maxLength={limit} value={value[key]} disabled={disabled} required={key === 'goal'} onChange={e => onChange({ ...value, [key]: e.target.value })} />
    </label>)}
  </div>
}
export function TaskBriefSummary({ brief }: { brief: BriefSnapshot }) {
  return <details className="task-brief-summary"><summary>查看任务需求单 · 原始要求</summary>
    <p>保存于 {new Date(brief.capturedAt).toLocaleString()}。调整任务标题、负责人和日期不会改写这份需求。</p>
    <dl>{briefFields.filter(([key]) => brief[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{brief[key]}</dd></div>)}</dl>
    <p>预算为需求约束，尚未实施自动金额上限；对外发布仍须单独确认。</p>
  </details>
}
