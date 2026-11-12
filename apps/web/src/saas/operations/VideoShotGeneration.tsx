import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
type Shot = { id: string; state: string; model: string; result?: { videoUrl?: string; error?: string; specification?: { requested: {ratio: string; resolution: string}; actual: {width: number; height: number} } }; statusUnavailable?: boolean }
export function VideoShotGeneration({ root, taskId, duration, ratio, resolution, onReady }: {
  root: string; taskId: string; duration: number; ratio: string; resolution: string;
  onReady: (url: string) => void
}) {
  const [prompt, setPrompt] = useState(''), [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [shots, setShots] = useState<Shot[]>([])
  const pending = useRef<{ requestId: string; prompt: string; duration: number; ratio: string; resolution: string; costAcknowledged: true } | undefined>(undefined)
  const [uncertain, setUncertain] = useState(false)
  const gate = useRef(false)
  const path = `${root}/tasks/${taskId}/shots`
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { const data = await api<{ items: Shot[] }>(path); if (live) setShots(data.items || []) }
      catch (e) { if (live) setError((e as Error).message) }
      finally { if (live) timer = setTimeout(() => void load(), 5000) }
    }
    void load()
    return () => { live = false; clearTimeout(timer) }
  }, [path])
  const blocked = shots.some(s => ['submitting', 'submitted', 'uncertain'].includes(s.state))
  async function generate() {
    if (gate.current || !approved || !prompt.trim()) return
    gate.current = true; setBusy(true); setError('')
    pending.current ||= { requestId: crypto.randomUUID(), prompt, duration: Math.max(5, Math.ceil(duration)), ratio, resolution, costAcknowledged: true }
    try {
      const data = await api<{ shot: Shot }>(path, pending.current)
      setShots(v => [data.shot, ...v.filter(s => s.id !== data.shot.id)])
      pending.current = undefined; setUncertain(false)
    } catch (e) { setUncertain(true); setError(`${(e as Error).message}。再次查询使用同一编号，不会重复生成。`) }
    finally { gate.current = false; setBusy(false) }
  }
  return <section aria-label="重新生成单镜头">
    <h4>生成新的备用镜头</h4>
    <p>只生成 1 个镜头，{Math.max(5, Math.ceil(duration))} 秒 · {ratio} · {resolution}。沿用已配置的视频模型，不自动重试。</p>
    <label>新镜头要求<textarea value={prompt} maxLength={2000} disabled={busy || uncertain} onChange={e => setPrompt(e.target.value)} /></label>
    <p className="muted">这是一次新的付费生成。当前通道未提供可靠的实时金额，实际费用以服务商账单为准；文字 token 额度不代表视频费用。</p>
    <label><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />我确认新增一次视频生成费用</label>
    <button type="button" disabled={busy || blocked || duration > 15 || !approved || !prompt.trim()} onClick={() => void generate()}>{busy ? '正在提交…' : uncertain ? '查询本次提交' : '只生成这一镜头'}</button>
    {duration > 15 && <p>单镜头生成最多 15 秒，请先缩短本段。</p>}
    {error && <p role="alert">{error}</p>}
    {shots.map(s => <div key={s.id}>
      <p>{s.model} · {s.state === 'completed' ? '新镜头已生成，请预览后选择' : s.state === 'failed' ? '生成失败，可调整后重新提交' : ['uncertain', 'submitting'].includes(s.state) ? '提交结果待核对，请勿重复付费生成' : '正在生成'}{s.statusUnavailable ? ' · 状态暂时无法读取' : ''}</p>
      {s.result?.error && <p role="alert">{s.result.error}</p>}
      {s.result?.specification && <p>要求 {s.result.specification.requested.ratio} / {s.result.specification.requested.resolution}；实际 {s.result.specification.actual.width} × {s.result.specification.actual.height}</p>}
      {s.state === 'completed' && s.result?.videoUrl && <button type="button" onClick={() => onReady(s.result!.videoUrl!)}>预览这份新镜头</button>}
    </div>)}
  </section>
}
