import { useEffect, useState } from 'react'
import { api } from './api'
import {useEmployeeDirectory} from './employee-directory'

type Check = { name: string; state: 'passed' | 'failed' | 'skipped' | 'unverified'; detail: string; model?: string }
type Result = { stale?: boolean; department: string; checkedAt: string; checks: Check[] }
const labels = { passed: '通过', failed: '需处理', skipped: '未测试', unverified: '仅核对配置' }
export function EmployeeSelfCheck({ base }: { base: string }) {
  const employees=useEmployeeDirectory(base),DEPARTMENT_NAMES:Record<string,string>=Object.fromEntries(employees.map(e=>[e.departmentKey,`${e.name} · ${e.department}`]))
  const [results, setResults] = useState<Record<string, Result>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Result[]>([])
  useEffect(() => {
    let live = true
    void api<{ items: Result[] }>(`${base}/employees/self-check/history`).then(data => {
      if (!live) return
      setHistory(data.items)
      const latest: Record<string, Result> = {}
      for (const item of data.items) latest[item.department] ||= item
      setResults(latest)
    }).catch(e => { if (live) setError(e.message) })
    return () => { live = false }
  }, [base])
  async function check(ids: string[]) {
    setError('')
    for (const department of ids) {
      setBusy(department)
      try {
        const result = await api<Result>(`${base}/employees/self-check`, { department })
        setHistory(current => [result, ...current].slice(0, 100))
        setResults(current => ({ ...current, [department]: result }))
      } catch (e) { setError((e as Error).message); break }
    }
    setBusy('')
  }
  return <section className="builder-card ops-settings" aria-label="员工一键自检">
    <div className="heading-row"><h2>员工一键自检</h2><button disabled={!!busy} onClick={() => void check(Object.keys(DEPARTMENT_NAMES))}>{busy ? `正在检查：${DEPARTMENT_NAMES[busy]}` : '检查全部员工'}</button></div>
    <p className="muted">使用已保存的配置测试文字回复和工具协议，会产生少量模型费用。图片、视频和搜索只核对配置；不会生成媒体、执行真实工具或对外发布。未启用的员工跳过。</p>
    {error && <p className="error" role="alert">{error}</p>}
    {Object.entries(DEPARTMENT_NAMES).map(([id, name]) => <div key={id} className="self-check-row">
      <div className="heading-row"><h3>{name}</h3><button disabled={!!busy} onClick={() => void check([id])}>{busy === id ? '自检中…' : '自检'}</button></div>
      {results[id] ? <><p className="small muted">检查于 {new Date(results[id].checkedAt).toLocaleString()}{results[id].stale && ' · 配置已变更，请重新自检'}</p><ul>{results[id].checks.map((item, index) => <li key={index}><strong>{item.name} · {labels[item.state]}</strong>{item.model && ` · ${item.model}`}<p className={item.state === 'failed' ? 'error' : 'small muted'}>{item.detail}</p></li>)}</ul></> : <p className="small muted" role="status">尚未自检</p>}
      {history.filter(item => item.department === id).length > 1 && <details><summary>查看此前自检记录</summary>{history.filter(item => item.department === id).slice(1, 6).map(item => <p key={item.checkedAt}>{new Date(item.checkedAt).toLocaleString()} · {item.checks.filter(c => c.state === 'failed').length ? '有项目需处理' : '查看项目结果'}{item.stale ? ' · 旧配置' : ''}</p>)}</details>}
    </div>)}
  </section>
}
