import { VideoNarration } from './VideoNarration'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useVideoDraft } from './useVideoDraft'
import { VideoDraftPreview } from './VideoDraftPreview'
import { PrivateVideo, PrivateVideoLink } from './PrivateVideo'
import { VideoShotReplacement } from './VideoShotReplacement'
import './video-editor.css'

type Segment = { url: string; start: number; end: number }
type Subtitle = { start: number; end: number; text: string }
type Draft = {
  title: string
  segments: Segment[]
  subtitles: Subtitle[]
  ratio: '9:16' | '16:9' | '1:1'
  resolution: '720p' | '1080p'
  fit: 'contain' | 'cover'
  originalVolume: number
  musicVolume: number
  narrationVolume?: number
  narrationCues?: { start: number; end: number }[]
  musicFade?: number
  duckMusic?: boolean
}
type Edit = {
  id: string
  isFinal?: boolean
  state: string
  phase: string
  error?: string
  spec: Draft & { musicName?: string; narrationName?: string }
  result?: {
    width: number
    height: number
    duration: number
    bytes: number
    archive?: { fileId: string; manifestId: string; archivedAt: string }
  }
  createdAt: string
}
type Music = { name: string; base64: string }
type SavedDraft = {
  draft: Draft
  music?: Music
  narration?: Music
  savedNarration?: { id: string; name: string }
  savedMusic?: { id: string; name: string }
  formatInitialized?: boolean
}
type Submission = Draft & { narration?: Music; narrationFromEditId?: string; requestId: string; music?: Music; musicFromEditId?: string }

export function VideoEditor({
  root,
  taskId,
  videos,
  canEdit,
}: {
  root: string
  taskId: string
  videos: { url: string }[]
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>({
    title: '视频剪辑',
    segments: [{ url: videos[0].url, start: 0, end: 5 }],
    subtitles: [],
    ratio: '9:16',
    resolution: '720p',
    fit: 'contain',
    originalVolume: 1,
    musicVolume: 0.2,
  })
  const [formatInitialized, setFormatInitialized] = useState(false)
  const [replacement, setReplacement] = useState<{ index: number; original: Segment }>()
  const [undoReplacement, setUndoReplacement] = useState<{
    index: number
    before: Segment
    after: Segment
  }>()
  const [replacementMessage, setReplacementMessage] = useState('')
  const [previewIndex, setPreviewIndex] = useState(0)
  const [sourceSize, setSourceSize] = useState<Record<string, { width: number; height: number }>>(
    {},
  )
  const formatTouched = useRef(false)
  const timingTouched = useRef(false)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [music, setMusic] = useState<Music>()
  const [narration, setNarration] = useState<Music>()
  const [savedNarration, setSavedNarration] = useState<{ id: string; name: string }>()
  const [savedMusic, setSavedMusic] = useState<{ id: string; name: string }>()
  const musicInput = useRef<HTMLInputElement>(null)
  const [edits, setEdits] = useState<Edit[]>([])
  const [selected, setSelected] = useState('')
  const [compareId, setCompareId] = useState('')
  const [finalizing, setFinalizing] = useState(false)
  const [error, setError] = useState(''),
    [loadError, setLoadError] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<{
    draft: Draft
    music?: Music
    savedMusic?: { id: string; name: string }
    narration?: Music
    savedNarration?: { id: string; name: string }
    width: number
    height: number
    duration: number
    warnings: string[]
  }>()
  const checkCurrent =
    check?.draft === draft && check?.music === music && check?.savedMusic === savedMusic && check?.narration === narration && check?.savedNarration === savedNarration
  const [sending, setSending] = useState(false),
    [uncertain, setUncertain] = useState(false)
  const [loading, setLoading] = useState(false),
    [fileBusy, setFileBusy] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [archiving, setArchiving] = useState(false)
  const pending = useRef<Submission | null>(null),
    live = useRef(true),
    submitting = useRef(false)
  const fileSequence = useRef(0)
  const duration = Math.round(draft.segments.reduce((n, s) => n + s.end - s.start, 0) * 1000) / 1000
  const result = edits.find((e) => e.id === selected) || edits[0]
  const path = `${root}/tasks/${taskId}/edits`
  const autosave = useVideoDraft<SavedDraft>(
    `${root}/tasks/${taskId}/edit-draft`,
    { draft, music, savedMusic, narration, savedNarration, formatInitialized },
    (saved) => {
      setReplacement(undefined)
      setUndoReplacement(undefined)
      setReplacementMessage('')
      setDraft(saved.draft)
      setNarration(saved.narration)
      setSavedNarration(saved.savedNarration)
      setMusic(saved.music)
      setSavedMusic(saved.savedMusic)
      setFormatInitialized(saved.formatInitialized ?? true)
      formatTouched.current = saved.formatInitialized ?? true
      timingTouched.current = true
    },
    open,
    canEdit,
  )
  const previewSegment = draft.segments[previewIndex] || draft.segments[0]
  const source = sourceSize[previewSegment.url]
  const aspect = draft.ratio === '9:16' ? 9 / 16 : draft.ratio === '16:9' ? 16 / 9 : 1
  const cropped =
    !!source && draft.fit === 'cover' && Math.abs(source.width / source.height - aspect) > 0.02

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (!open) return
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>
    setLoading(true)
    const load = async () => {
      try {
        const data = await api<{ items: Edit[] }>(path)
        if (!cancelled) {
          setEdits(data.items)
          setLoadError('')
        }
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message)
      } finally {
        if (!cancelled) {
          setLoading(false)
          timer = setTimeout(() => void load(), 3000)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, path])
  function accepted(edit: Edit) {
    if (!live.current) return
    setEdits((items) => [edit, ...items.filter((e) => e.id !== edit.id)])
    setSelected(edit.id)
    pending.current = null
    setUncertain(false)
    setError('')
  }
  async function submit(recover = false, onlyCheck = false) {
    if (submitting.current || replacement) return
    submitting.current = true
    setSending(true)
    setError('')
    let exportStarted = recover
    try {
      const body = recover
        ? pending.current
        : {
            ...draft,
            ...(narration ? { narration } : savedNarration ? { narrationFromEditId: savedNarration.id } : {}),
            ...(music ? { music } : savedMusic ? { musicFromEditId: savedMusic.id } : {}),
            requestId: crypto.randomUUID(),
          }
      if (!body) return
      if (!recover) {
        setChecking(true)
        const checked = await api<{
          width: number
          height: number
          duration: number
          warnings: string[]
        }>(`${path}/check`, body)
        setChecking(false)
        if (!live.current) return
        setCheck({ ...checked, draft, music, savedMusic, narration, savedNarration })
        // Warnings require a second deliberate click after the user sees them.
        if (
          onlyCheck ||
          (checked.warnings.length &&
            (!checkCurrent || JSON.stringify(checked.warnings) !== JSON.stringify(check?.warnings)))
        )
          return
      }
      exportStarted = true
      pending.current = body
      if (recover) {
        try {
          const data = await api<{ edit: Edit }>(`${root}/video-edits/${body.requestId}`)
          accepted(data.edit)
          return
        } catch (e) {
          if ((e as Error & { status?: number }).status !== 404) throw e
        }
      }
      accepted((await api<{ edit: Edit }>(path, body)).edit)
    } catch (e) {
      if (!live.current) return
      const status = (e as Error & { status?: number }).status
      const definite = !exportStarted || (status && status >= 400 && status < 500)
      if (!exportStarted) setCheck(undefined)
      setError(
        !exportStarted && !status
          ? '导出检查连接中断，尚未提交导出；请重试检查。'
          : (e as Error).message,
      )
      setUncertain(!definite)
      if (definite) pending.current = null
    } finally {
      submitting.current = false
      if (live.current) {
        setSending(false)
        setChecking(false)
      }
    }
  }
  async function retry(id: string) {
    setRetrying(id)
    setError('')
    try {
      accepted((await api<{ edit: Edit }>(`${root}/video-edits/${id}/retry`, {})).edit)
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setRetrying('')
    }
  }
  async function archive(id: string) {
    setArchiving(true)
    setError('')
    try {
      const data = await api<{ archive: NonNullable<Edit['result']>['archive'] }>(
        `${root}/video-edits/${id}/archive`,
        {},
      )
      if (live.current)
        setEdits((items) =>
          items.map((e) =>
            e.id === id && e.result ? { ...e, result: { ...e.result, archive: data.archive } } : e,
          ),
        )
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setArchiving(false)
    }
  }
  async function chooseMusic(file?: File) {
    const sequence = ++fileSequence.current
    setError('')
    setMusic(undefined)
    setSavedMusic(undefined)
    if (!file) return
    if (file.size > 8 * 1024 * 1024 || !file.size) {
      setError('请选择不超过8MB的音频文件')
      return
    }
    setFileBusy(true)
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('配乐读取失败，请重新选择'))
        reader.readAsDataURL(file)
      })
      if (live.current && sequence === fileSequence.current)
        setMusic({ name: file.name, base64: encoded })
    } catch (e) {
      if (live.current && sequence === fileSequence.current) setError((e as Error).message)
    } finally {
      if (live.current && sequence === fileSequence.current) setFileBusy(false)
    }
  }
  function segment(index: number, patch: Partial<Segment>) {
    timingTouched.current = true
    setDraft((d) => ({
      ...d,
      segments: d.segments.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }))
  }
  function loadRecipe(edit: Edit) {
    setUndoReplacement(undefined)
    setReplacementMessage('')
    formatTouched.current = true
    setFormatInitialized(true)
    const s = edit.spec
    setDraft({
      title: s.title,
      segments: s.segments.map((item) => ({ ...item })),
      subtitles: s.subtitles.map((item) => ({ ...item })),
      ratio: s.ratio,
      resolution: s.resolution,
      fit: s.fit,
      originalVolume: s.originalVolume,
      musicVolume: s.musicVolume,
      narrationVolume: s.narrationVolume, narrationCues: s.narrationCues, musicFade: s.musicFade, duckMusic: s.duckMusic,
    })
    setMusic(undefined)
    setNarration(undefined)
    setSavedNarration(s.narrationName ? { id: edit.id, name: s.narrationName } : undefined)
    setSavedMusic(s.musicName ? { id: edit.id, name: s.musicName } : undefined)
    if (musicInput.current) musicInput.current.value = ''
    setError('')
  }
  function subtitle(index: number, patch: Partial<Subtitle>) {
    setDraft((d) => ({
      ...d,
      subtitles: d.subtitles.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }))
  }
  function move(index: number, delta: number) {
    setDraft((d) => {
      const segments = [...d.segments]
      ;[segments[index], segments[index + delta]] = [segments[index + delta], segments[index]]
      return { ...d, segments }
    })
  }
  return (
    <section className="video-editor" aria-label="视频剪辑">
      <div className="heading-row">
        <h3>剪辑成片</h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setReplacement(undefined)
            setOpen((value) => !value)
          }}
        >
          {open ? '收起剪辑' : '打开视频剪辑'}
        </button>
      </div>
      <p className="muted">
        复用本任务的视频，剪辑后另存成片。草稿自动保存，导出后可预览、下载和归档。
      </p>
      {open && (
        <>
          <p role="status">{autosave.message}</p>
          {autosave.failed && (
            <div>
              {autosave.ready && (
                <button type="button" onClick={autosave.retry}>
                  重试保存草稿
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (
                    !autosave.ready ||
                    window.confirm('重新载入会替换当前未保存的草稿，是否继续？')
                  )
                    void autosave.load()
                }}
              >
                重新载入已保存草稿
              </button>
            </div>
          )}
          {autosave.ready && (
            <div className="video-editor-grid">
              <div className="video-editor-preview">
                <h4>字幕与配乐实时预览</h4>
                <VideoDraftPreview
                  accessContext={{ root, taskId }}
                  segments={draft.segments}
                  subtitles={draft.subtitles}
                  aspect={aspect}
                  fit={draft.fit}
                  resolution={draft.resolution}
                  originalVolume={draft.originalVolume}
                  musicVolume={draft.musicVolume}
                  music={music}
                  narration={narration}
                  savedNarrationUrl={savedNarration ? `${root}/video-edits/${savedNarration.id}/narration` : undefined}
                  narrationVolume={draft.narrationVolume ?? 1}
                  narrationCues={draft.narrationCues}
                  musicFade={draft.musicFade}
                  duckMusic={draft.duckMusic}
                  savedMusicUrl={
                    savedMusic ? `${root}/video-edits/${savedMusic.id}/music` : undefined
                  }
                  onSegment={setPreviewIndex}
                  onMetadata={(url, value, width, height) => {
                    if (url && Number.isFinite(value)) setDurations((d) => ({ ...d, [url]: value }))
                    if (width && height) {
                      setSourceSize((s) => ({ ...s, [url]: { width, height } }))
                      if (!formatInitialized && !formatTouched.current) {
                        const ratios: Draft['ratio'][] = ['16:9', '9:16', '1:1']
                        const ratio = ratios.reduce((a, b) =>
                          Math.abs(
                            Math.log(
                              width / height / (Number(a.split(':')[0]) / Number(a.split(':')[1])),
                            ),
                          ) <
                          Math.abs(
                            Math.log(
                              width / height / (Number(b.split(':')[0]) / Number(b.split(':')[1])),
                            ),
                          )
                            ? a
                            : b,
                        )
                        setDraft((d) => ({
                          ...d,
                          ratio,
                          resolution: Math.min(width, height) >= 1080 ? '1080p' : '720p',
                          segments: d.segments.map((s, i) =>
                            i === 0 && !timingTouched.current
                              ? { ...s, end: Math.min(value, 180) }
                              : s,
                          ),
                        }))
                        setFormatInitialized(true)
                      }
                    }
                  }}
                />
                <p>素材时长：{durations[previewSegment.url]?.toFixed(2) || '—'} 秒</p>
                {source && (
                  <p>
                    原片：{source.width} × {source.height}
                    。默认选择最接近的受支持规格，最高1080p；保留完整画面。
                  </p>
                )}
                {cropped && (
                  <p role="status">
                    当前将居中裁掉画面边缘，请先播放上方预览检查主体。可切换“保留完整画面”避免裁切。
                  </p>
                )}
                {result && (
                  <div className="video-editor-result" aria-live="polite">
                    <h4>{result.spec.title}</h4>
                    <p role="status">{result.phase}</p>
                    <button
                      type="button"
                      disabled={!canEdit || sending || uncertain || fileBusy || !!replacement}
                      onClick={() => loadRecipe(result)}
                    >
                      载入这份剪辑设置
                    </button>
                    {result.error && (
                      <p className="error" role="alert">
                        {result.error}
                      </p>
                    )}
                    {result.state === 'failed' && (
                      <button
                        disabled={!canEdit || !!retrying || sending || uncertain}
                        onClick={() => void retry(result.id)}
                      >
                        重试这份剪辑
                      </button>
                    )}
                    {result.state === 'completed' && (
                      <>
                        <PrivateVideo
                          key={result.id}
                          controls
                          preload="metadata"
                          src={`${root}/video-edits/${result.id}/media`}
                          aria-label="剪辑成片预览"
                        />
                        <p>
                          {result.result?.width} × {result.result?.height} ·{' '}
                          {result.result?.duration.toFixed(2)} 秒
                        </p>
                        <PrivateVideoLink src={`${root}/video-edits/${result.id}/media`} download>
                          下载剪辑成片
                        </PrivateVideoLink>
                        {result.result?.archive ? (
                          <div role="status">
                            <p>已确认并归档到任务成果和资料室。尚未对外发布。</p>
                            <PrivateVideoLink
                              src={`${root.replace(/\/operations$/, '')}/files/${result.result.archive.fileId}/video`}
                              download
                            >
                              下载归档成片
                            </PrivateVideoLink>
                          </div>
                        ) : (
                          <div>
                            <p>预览满意后确认成片；归档不会对外发布。</p>
                            <button
                              type="button"
                              disabled={!canEdit || archiving}
                              onClick={() => void archive(result.id)}
                            >
                              {archiving ? '正在保存成片…' : '确认成片并归档'}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void submit()
                }}
              >
                {replacement && (
                  <VideoShotReplacement
                    generation={{ root, taskId, ratio: draft.ratio, resolution: draft.resolution }}
                    key={replacement.index}
                    index={replacement.index}
                    segment={replacement.original}
                    videos={videos}
                    disabled={!canEdit || sending || uncertain || fileBusy}
                    onCancel={() => setReplacement(undefined)}
                    onApply={(after) => {
                      // A late preview must never replace a different or reordered segment.
                      if (draft.segments[replacement.index] !== replacement.original) {
                        setReplacement(undefined)
                        setError('片段已变化，请重新选择要替换的片段。')
                        return
                      }
                      timingTouched.current = true
                      setUndoReplacement({
                        index: replacement.index,
                        before: replacement.original,
                        after,
                      })
                      // Keep the exact replacement object for the targeted undo check.
                      setDraft((d) => ({
                        ...d,
                        segments: d.segments.map((s, i) => (i === replacement.index ? after : s)),
                      }))
                      setReplacementMessage(
                        `片段 ${replacement.index + 1} 已替换，其他片段、字幕和配乐已保留。`,
                      )
                      setReplacement(undefined)
                    }}
                  />
                )}
                {replacementMessage && <p role="status">{replacementMessage}</p>}
                {undoReplacement &&
                  draft.segments[undoReplacement.index] === undoReplacement.after && (
                    <button
                      type="button"
                      disabled={!canEdit || sending || uncertain || fileBusy || !!replacement}
                      onClick={() => {
                        setDraft((d) => ({
                          ...d,
                          segments: d.segments.map((s, i) =>
                            i === undoReplacement.index && s === undoReplacement.after
                              ? undoReplacement.before
                              : s,
                          ),
                        }))
                        setUndoReplacement(undefined)
                        setReplacementMessage('已撤销本次替换，其他设置已保留。')
                      }}
                    >
                      撤销本次替换
                    </button>
                  )}
                <fieldset disabled={!canEdit || sending || uncertain || fileBusy || !!replacement}>
                  <h4>下一次导出设置</h4>
                  <label>
                    成片名称
                    <input
                      value={draft.title}
                      maxLength={80}
                      required
                      onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    />
                  </label>
                  <div className="video-edit-format">
                    <label>
                      成片比例
                      <select
                        value={draft.ratio}
                        onChange={(e) => (
                          (formatTouched.current = true),
                          setFormatInitialized(true),
                          setDraft((d) => ({ ...d, ratio: e.target.value as Draft['ratio'] }))
                        )}
                      >
                        <option value="9:16">9:16 竖屏</option>
                        <option value="16:9">16:9 横屏</option>
                        <option value="1:1">1:1 方形</option>
                      </select>
                    </label>
                    <label>
                      导出清晰度
                      <select
                        value={draft.resolution}
                        onChange={(e) => {
                          formatTouched.current = true
                          setFormatInitialized(true)
                          setDraft((d) => ({
                            ...d,
                            resolution: e.target.value as Draft['resolution'],
                          }))
                        }}
                      >
                        <option value="720p">720p</option>
                        <option value="1080p">1080p</option>
                      </select>
                    </label>
                    <label>
                      画面适配
                      <select
                        value={draft.fit}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, fit: e.target.value as Draft['fit'] }))
                        }
                      >
                        <option value="contain">保留完整画面，空处留黑</option>
                        <option value="cover">铺满画面，居中裁掉边缘</option>
                      </select>
                    </label>
                  </div>
                  <h4>片段顺序 · 共 {duration.toFixed(2)} 秒</h4>
                  <p className="muted">最多8段、总计180秒，按下方顺序拼接。时间以原视频为准。</p>
                  {draft.segments.map((s, i) => (
                    <div className="video-edit-row" key={i}>
                      <div>
                        <p>
                          片段 {i + 1} ·{' '}
                          {videos.some((v) => v.url === s.url)
                            ? `视频 ${videos.findIndex((v) => v.url === s.url) + 1}`
                            : '已保存素材'}
                        </p>
                        <button
                          type="button"
                          aria-label={`替换片段${i + 1}`}
                          onClick={() => {
                            setReplacementMessage('')
                            setReplacement({ index: i, original: s })
                          }}
                        >
                          替换镜头
                        </button>
                      </div>
                      <label>
                        开始（秒）
                        <input
                          aria-label={`片段${i + 1}开始`}
                          type="number"
                          min="0"
                          max="180"
                          step="any"
                          required
                          value={s.start}
                          onChange={(e) => segment(i, { start: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        结束（秒）
                        <input
                          aria-label={`片段${i + 1}结束`}
                          type="number"
                          min={s.start + 0.1}
                          max="180"
                          step="any"
                          required
                          value={s.end}
                          onChange={(e) => segment(i, { end: Number(e.target.value) })}
                        />
                      </label>
                      <div className="video-edit-actions">
                        <button
                          type="button"
                          disabled={!i}
                          onClick={() => move(i, -1)}
                          aria-label={`上移片段${i + 1}`}
                        >
                          上移
                        </button>
                        <button
                          type="button"
                          disabled={i === draft.segments.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label={`下移片段${i + 1}`}
                        >
                          下移
                        </button>
                        <button
                          type="button"
                          disabled={draft.segments.length === 1}
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              segments: d.segments.filter((_, n) => n !== i),
                            }))
                          }
                          aria-label={`移除片段${i + 1}`}
                        >
                          移除
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={draft.segments.length >= 8}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        segments: [
                          ...d.segments,
                          {
                            url: videos[0].url,
                            start: 0,
                            end: Math.min(5, durations[videos[0].url] || 5),
                          },
                        ],
                      }))
                    }
                  >
                    添加片段
                  </button>
                  <h4>字幕</h4>
                  <p className="muted">
                    字幕时间从成片开头算起，按时间排列，不重叠。每条最多100字。
                  </p>
                  {draft.subtitles.map((s, i) => (
                    <div className="video-edit-row video-edit-subtitle" key={i}>
                      <label>
                        字幕 {i + 1}
                        <textarea
                          aria-label={`字幕${i + 1}文字`}
                          value={s.text}
                          required
                          maxLength={100}
                          rows={2}
                          onChange={(e) => subtitle(i, { text: e.target.value })}
                        />
                      </label>
                      <label>
                        出现（秒）
                        <input
                          aria-label={`字幕${i + 1}开始`}
                          type="number"
                          min="0"
                          max={Math.max(0, duration)}
                          step="any"
                          required
                          value={s.start}
                          onChange={(e) => subtitle(i, { start: Number(e.target.value) })}
                        />
                      </label>
                      <label>
                        消失（秒）
                        <input
                          aria-label={`字幕${i + 1}结束`}
                          type="number"
                          min={s.start + 0.01}
                          max={Math.max(0, duration)}
                          step="any"
                          required
                          value={s.end}
                          onChange={(e) => subtitle(i, { end: Number(e.target.value) })}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            subtitles: d.subtitles.filter((_, n) => n !== i),
                          }))
                        }
                        aria-label={`移除字幕${i + 1}`}
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={draft.subtitles.length >= 30}
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        subtitles: [
                          ...d.subtitles,
                          {
                            start: d.subtitles.at(-1)?.end || 0,
                            end: Math.max(0, duration),
                            text: '',
                          },
                        ],
                      }))
                    }
                  >
                    添加字幕
                  </button>
                  <VideoNarration root={root} taskId={taskId} duration={duration} onApply={(value, captions) => {
                    setNarration(value.narration); setSavedNarration(undefined)
                    setDraft(d => ({ ...d, narrationVolume: 1, duckMusic: true, narrationCues: value.subtitles.map(({start,end}) => ({start,end})), ...(captions ? { subtitles: value.subtitles } : {}) }))
                  }} />
                  {(narration || savedNarration) && <p>{narration?.name || savedNarration?.name}<button type="button" onClick={() => { setNarration(undefined); setSavedNarration(undefined); setDraft(d => ({...d,narrationCues: []})) }}>移除配音</button></p>}
                  <label>配乐淡入淡出（秒）<input type="number" min="0" max="5" step="0.1" value={draft.musicFade || 0} onChange={e => setDraft(d => ({...d,musicFade: Number(e.target.value)}))} /></label>
                  <label><input type="checkbox" checked={draft.duckMusic || false} onChange={e => setDraft(d => ({...d,duckMusic: e.target.checked}))} />配音期间降低配乐音量</label>
                  <h4>声音</h4>
                  <label>
                    原声 {Math.round(draft.originalVolume * 100)}%
                    <input
                      aria-label="原声音量"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={draft.originalVolume}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, originalVolume: Number(e.target.value) }))
                      }
                    />
                  </label>
                  <label>
                    上传配乐（MP3 / WAV / M4A，最多8MB）
                    <input
                      type="file"
                      ref={musicInput}
                      accept="audio/*"
                      onChange={(e) => void chooseMusic(e.target.files?.[0])}
                    />
                  </label>
                  {(music || savedMusic) && (
                    <p>
                      {music?.name || savedMusic?.name} {savedMusic && '（已保存，可直接复用）'}
                      <button
                        type="button"
                        onClick={() => {
                          setMusic(undefined)
                          setSavedMusic(undefined)
                          if (musicInput.current) musicInput.current.value = ''
                          fileSequence.current++
                        }}
                      >
                        移除配乐
                      </button>
                    </p>
                  )}
                  <label>
                    配乐音量 {Math.round(draft.musicVolume * 100)}%
                    <input
                      aria-label="配乐音量"
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      disabled={!music && !savedMusic}
                      value={draft.musicVolume}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, musicVolume: Number(e.target.value) }))
                      }
                    />
                  </label>
                  <p className="muted">短配乐会循环至片尾。请使用你有权使用的音频。</p>
                  <button type="button" onClick={() => void submit(false, true)}>
                    检查导出条件
                  </button>
                  {check && (
                    <div role="status" aria-label="导出检查结果">
                      {checkCurrent ? (
                        <>
                          <p>
                            素材检查通过 · {check.width} × {check.height} · {check.duration}秒
                          </p>
                          {check.warnings.length > 0 && (
                            <ul>
                              {check.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          )}
                          {check.warnings.length > 0 && <p>请核对预览，接受上述效果后再导出。</p>}
                        </>
                      ) : (
                        <p>设置已修改，导出时会重新检查。</p>
                      )}
                    </div>
                  )}
                  <button className="primary" disabled={duration <= 0 || duration > 180}>
                    {checkCurrent && check && check.warnings.length > 0
                      ? '确认提示并导出'
                      : '导出剪辑成片'}
                  </button>
                </fieldset>
                {sending && (
                  <p role="status">
                    {checking ? '正在检查素材、字幕和配乐，请稍候…' : '正在提交剪辑，请稍候…'}
                  </p>
                )}
                {fileBusy && <p role="status">正在读取配乐…</p>}
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                {uncertain && (
                  <button type="button" disabled={sending} onClick={() => void submit(true)}>
                    核对这次导出
                  </button>
                )}
              </form>
            </div>
          )}
          <div className="video-edit-history">
            <h4>成果版本</h4>
            <p className="muted">每次导出都是独立版本。载入历史设置不会覆盖成片；重新导出后形成新版本。</p>
            {result?.state === 'completed' && <>
              <button disabled={!canEdit || finalizing || result.isFinal} onClick={async () => {
                setFinalizing(true); setError('')
                try { await api(`${root}/video-edits/${result.id}/final`, {}); setEdits(v => v.map(e => ({...e,isFinal: e.id === result.id}))) }
                catch (e) { setError((e as Error).message) }
                finally { setFinalizing(false) }
              }}>{result.isFinal ? '当前定稿' : '将本版本标记为定稿'}</button>
              <label>对照版本<select aria-label="对照版本" value={compareId} onChange={e => setCompareId(e.target.value)}>
                <option value="">选择要对照的版本</option>
                {edits.filter(e => e.state === 'completed' && e.id !== result.id).map(e => <option key={e.id} value={e.id}>{e.spec.title} · {new Date(e.createdAt).toLocaleString()}</option>)}
              </select></label>
              {compareId && compareId !== result.id && <div className="video-version-compare" role="region" aria-label="版本对照">
                {[result, edits.find(e => e.id === compareId)].filter((e): e is Edit => !!e).map(e => <section key={e.id}>
                  <h5>{e.spec.title}{e.isFinal ? ' · 定稿' : ''}</h5>
                  <PrivateVideo controls preload="metadata" src={`${root}/video-edits/${e.id}/media`} aria-label={`对照版本${e.id}`} />
                  <p>{e.result?.width} × {e.result?.height} · {e.result?.duration.toFixed(2)} 秒 · {e.spec.segments.length} 段 · {e.spec.subtitles.length} 条字幕</p>
                  <PrivateVideoLink src={`${root}/video-edits/${e.id}/media`} download>下载此版本</PrivateVideoLink>
                </section>)}
              </div>}
            </>}
            {loading && <p role="status">正在读取剪辑记录…</p>}
            {loadError && (
              <p role="alert" className="error">
                {loadError}，正在重试读取。
              </p>
            )}
            {!loading && !edits.length && (
              <p className="muted">还没有导出记录。选择片段、核对设置后导出。</p>
            )}
            {edits.map((item) => (
              <button
                key={item.id}
                aria-pressed={result?.id === item.id}
                onClick={() => setSelected(item.id)}
              >
                {item.isFinal ? '定稿 · ' : ''}{item.spec.title} · {item.phase} · {new Date(item.createdAt).toLocaleString()}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
