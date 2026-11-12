import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import { workspaceHash } from './workspace-route'
import type { Board } from '../../../../packages/secretary/model.mjs'
import './task-recovery.css'
type Settings = { maxOutputTokens: 4096 | 8192 | 16384; deliveryNote: string }
type Recovery = { available: boolean; dependenciesReady: boolean; needsConfirmation: boolean; reason: string; revision: number; problem: {
  code: string; title: string; description: string; note: string; adjustable: boolean; settings: Settings;
  destination: 'usage' | 'settings' | 'archive' | 'operations' | null;
  hasExternalRun: boolean;
  dependencies: { id: string; title: string; status: string }[];
  partialResult: { text: string; savedAt: string; limit: number } | null;
} }
export function TaskRecovery({ base, taskId, onUpdate, onSelect, onOperations }: { base: string; taskId: string; onUpdate: (board: Board) => void; onSelect?: (id: string) => void; onOperations?: () => void }) {
  const [state, setState] = useState<Recovery | null>(null)
  const [settings, setSettings] = useState<Settings>({ maxOutputTokens: 4096, deliveryNote: '' })
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [stale, setStale] = useState(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false), pending = useRef(false)
  const tenant = base.split('/').at(-1) || ''
  useEffect(() => {
    let live = true
    mounted.current = true
    setState(null); setError(''); setNotice(''); setStale(false); setConfirmed(false)
    api<Recovery>(`${base}/tasks/${taskId}/recovery`).then(data => {
      if (live) { setState(data); setSettings(data.problem.settings) }
    }).catch(e => { if (live) setError(e.message) })
    return () => { live = false; mounted.current = false }
  }, [base, taskId, reload])
  async function save(resume: boolean) {
    if (!state || pending.current || stale || (resume && !confirmed)) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await api<{ board: Board; revision: number }>(`${base}/tasks/${taskId}/recovery`, {
        revision: state.revision,
        ...(state.problem.adjustable ? { settings } : {}),
        ...(resume ? { acknowledgeRisk: confirmed } : {}),
      }, resume ? 'POST' : 'PATCH')
      if (!mounted.current) return
      setState({ ...state, revision: result.revision, available: resume ? false : state.available,
        problem: { ...state.problem, adjustable: resume ? false : state.problem.adjustable, settings } })
      setConfirmed(false)
      setNotice(resume ? '已恢复当前步骤，等待后台执行；前置成果保留。' : '设置已保存，仅影响本任务；尚未恢复或产生模型调用。')
      onUpdate(result.board)
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message)
        if ((e as Error & { status?: number }).status === 409) setStale(true)
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const problem = state?.problem
  const changed = !!problem && JSON.stringify(settings) !== JSON.stringify(problem.settings)
  return <section className="task-problem-panel" aria-label="任务问题处理">
    <h3>任务问题处理</h3>
    {error && <p role="alert" className="error">{error}</p>}
    {!state && !error && <p role="status">正在检查问题与处理条件…</p>}
    {(stale || (!state && error)) && <button type="button" onClick={() => setReload(n => n + 1)}>重新读取任务与已保存设置</button>}
    {state && problem && <>
      <h4>{problem.title}</h4><p>{problem.description}</p>
      {problem.note && <details><summary>查看失败详情</summary><p>{problem.note}</p></details>}
      {problem.dependencies.map(dep => <button type="button" key={dep.id} onClick={() => onSelect ? onSelect(dep.id) : location.assign(workspaceHash(tenant, { tab: 'tasks', filter: 'all', task: dep.id }))}>处理前置任务：{dep.title}</button>)}
      {(problem.destination === 'operations' || problem.hasExternalRun) && onOperations && <button type="button" onClick={onOperations}>打开原运营任务核对</button>}
      {problem.destination && problem.destination !== 'operations' && <a href={workspaceHash(tenant, { tab: problem.destination, filter: 'all' }) + (problem.destination === 'usage' ? `&budgetTask=${encodeURIComponent(taskId)}` : '')}>{({usage:'查看费用与预算设置',settings:'打开模型设置与员工自检',archive:'打开资料室处理素材'})[problem.destination]}</a>}
      {problem.partialResult?.text && <details><summary>查看已保存的未完成文本</summary><p>这是截断的草稿，尚未作为成品交给后续员工。恢复会按调整后的要求重新执行本步骤，不是保证从断点续写。</p><pre>{problem.partialResult.text}</pre></details>}
      {state.available && problem.adjustable && <fieldset disabled={busy || stale}>
        <legend>仅调整当前任务</legend>
        <label>本任务单次输出长度<select value={settings.maxOutputTokens} onChange={e => { setSettings({ ...settings, maxOutputTokens: Number(e.target.value) as Settings['maxOutputTokens'] }); setConfirmed(false); setNotice('') }}>
          <option value={4096}>4096 Token（默认）</option><option value={8192}>8192 Token</option><option value={16384}>16384 Token</option>
        </select></label>
        <p className="task-problem-hint">Token 是模型计算文本长度的单位，部分模型也将推理计入其中。更高上限可能增加费用，仍受模型能力和现有预算限制。</p>
        <label>补充交付要求（可精简，最多2000字）<textarea rows={4} maxLength={2000} value={settings.deliveryNote} onChange={e => { setSettings({ ...settings, deliveryNote: e.target.value }); setConfirmed(false); setNotice('') }} /></label>
        <button type="button" onClick={() => { setSettings({ ...settings, deliveryNote: '保留完成本任务必需的内容，直接给出可交付成果；省略重复背景和长篇分析。若为视频分镜，用紧凑表格给出时段、画面、字幕和制作提示，未核实信息不得编造。' }); setConfirmed(false); setNotice('') }}>填入精简交付建议</button>
        <p className="task-problem-hint">原始需求和调研保留；不会改变员工或企业的模型设置。</p>
        <button type="button" disabled={!changed} onClick={() => void save(false)}>{busy ? '正在保存…' : '仅保存设置，不执行'}</button>
      </fieldset>}
      {state.available && state.dependenciesReady && <>
        <label className="task-problem-confirm"><input type="checkbox" disabled={busy || stale} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对现有成果，同意重新执行当前步骤可能再次计费；原用量和预占记录保留。此步骤完成后，已安排的后续任务会继续。</label>
        <button type="button" className="task-problem-resume" disabled={busy || stale || !confirmed} onClick={() => void save(true)}>{busy ? '正在提交…' : changed ? '保存并恢复此步骤' : '恢复此步骤'}</button>
      </>}
      {!state.available && !notice && <p>{state.reason}</p>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
