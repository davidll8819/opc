import { useAudioSource } from './useAudioSource'
import { useRef, useState } from 'react'
import { api } from '../api'
type Caption = { start: number; end: number; text: string }
type Result = { narration: { name: string; base64: string }; subtitles: Caption[]; duration: number }
export function VideoNarration({ root, taskId, duration, onApply }: {
  root: string; taskId: string; duration: number; onApply: (result: Result, captions: boolean) => void
}) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<Result>(), [captions, setCaptions] = useState(false)
  const audioUrl = useAudioSource(result?.narration)
  const gate = useRef(false)
  async function generate() {
    if (gate.current) return
    gate.current = true; setBusy(true); setError(''); setResult(undefined)
    try { setResult(await api<Result>(`${root}/tasks/${taskId}/narration`, { text, duration })) }
    catch (e) { setError((e as Error).message) }
    finally { gate.current = false; setBusy(false) }
  }
  return <section aria-label="中文配音">
    <h4>中文配音与自动字幕</h4>
    <p className="muted">使用本机中文语音，无模型调用费用。按句号分句，每句最多100字；字幕时间来自实际朗读时长。</p>
    <label>配音文案<textarea value={text} maxLength={1500} disabled={busy} onChange={e => { setText(e.target.value); setResult(undefined) }} /></label>
    <button type="button" disabled={busy || !text.trim()} onClick={() => void generate()}>{busy ? '正在生成配音…' : '生成配音试听'}</button>
    {error && <p role="alert">{error}</p>}
    {result && <>
      <audio controls src={audioUrl} aria-label="新配音试听" />
      <p>配音 {result.duration.toFixed(2)} 秒，共 {result.subtitles.length} 句</p>
      <label><input type="checkbox" checked={captions} onChange={e => setCaptions(e.target.checked)} />同时用配音字幕替换当前字幕</label>
      <button type="button" disabled={result.duration > duration} onClick={() => { onApply(result, captions); setResult(undefined) }}>采用这份配音</button>
    </>}
  </section>
}
