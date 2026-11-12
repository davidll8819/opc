import { useEffect, useRef, useState } from 'react'
import { VideoShotGeneration } from './VideoShotGeneration'
import { PrivateVideo } from './PrivateVideo'

type Segment = { url: string; start: number; end: number }

// Stage a replacement without changing the saved draft or its timeline.
export function VideoShotReplacement({
  segment,
  index,
  videos,
  disabled,
  onApply,
  onCancel,
  generation,
}: {
  generation?: { root: string; taskId: string; ratio: string; resolution: string }
  segment: Segment
  index: number
  videos: { url: string }[]
  disabled: boolean
  onApply: (segment: Segment) => void
  onCancel: () => void
}) {
  const [generated, setGenerated] = useState<{ url: string }[]>([])
  const allVideos = [...videos, ...generated]
  const choices = allVideos.filter(
    (v, i) => v.url !== segment.url && allVideos.findIndex((x) => x.url === v.url) === i,
  )
  const [url, setUrl] = useState(choices[0]?.url || '')
  const [start, setStart] = useState(String(segment.start))
  const [info, setInfo] = useState<{ duration: number; width: number; height: number }>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const video = useRef<HTMLVideoElement>(null)
  const duration = Math.round((segment.end - segment.start) * 1000) / 1000
  const from = start.trim() ? Number(start) : NaN
  const end = Math.round((from + duration) * 1000) / 1000
  const invalid =
    !Number.isFinite(from) || from < 0 || duration <= 0 || end > 180
      ? '请输入有效的开始时间，替换后仍须保持原片段长度。'
      : info && (end > info.duration + 0.04 || from >= info.duration)
        ? `新素材时长${info.duration.toFixed(2)}秒，无法截取${from.toFixed(2)}–${end.toFixed(2)}秒。请选择更长素材或调整开始时间。`
        : ''
  const valid = !!info && !invalid && !error && choices.some((v) => v.url === url)
  useEffect(() => {
    if (!url || info || error) return
    const timer = setTimeout(() => setError('素材加载超时，请重试或选择其他素材。'), 15000)
    return () => clearTimeout(timer)
  }, [url, info, error, attempt])
  function choose(value: string) {
    setUrl(value)
    setInfo(undefined)
    setError('')
    setAttempt((n) => n + 1)
  }
  return (
    <section className="video-shot-replacement" aria-label={`替换片段${index + 1}`}>
      <h4>替换片段 {index + 1}</h4>
      <p>保留本段 {duration.toFixed(2)} 秒、其他片段、字幕和配乐。确认前草稿不会改变。</p>
      <fieldset disabled={disabled}>
        {generation && <VideoShotGeneration {...generation} duration={duration} onReady={next => {
          setGenerated(v => v.some(x => x.url === next) ? v : [...v, { url: next }]); choose(next); setStart('0')
        }} />}
        {choices.length ? (
          <>
            <label>
              替换素材
              <select
                aria-label="替换素材"
                autoFocus
                value={url}
                onChange={(e) => choose(e.target.value)}
              >
                {choices.map((v) => (
                  <option key={v.url} value={v.url}>
                    视频 {allVideos.findIndex((x) => x.url === v.url) + 1}
                  </option>
                ))}
              </select>
            </label>
            <PrivateVideo accessContext={generation}
              key={`${url}:${attempt}`}
              ref={video}
              src={url}
              muted
              controls
              playsInline
              preload="auto"
              aria-label="替换素材预览"
              onLoadedData={(e) => {
                const v = e.currentTarget
                if (Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0)
                  setInfo({ duration: v.duration, width: v.videoWidth, height: v.videoHeight })
                else setError('素材没有可用的视频画面，请选择其他素材。')
              }}
              onError={() => {
                setInfo(undefined)
                setError('素材无法播放，请重试或选择其他素材。')
              }}
              onPlay={(e) => {
                if (!valid) {
                  e.currentTarget.pause()
                  return
                }
                if (e.currentTarget.currentTime < from || e.currentTarget.currentTime >= end)
                  e.currentTarget.currentTime = from
              }}
              onTimeUpdate={(e) => {
                if (!e.currentTarget.paused && e.currentTarget.currentTime >= end)
                  e.currentTarget.pause()
              }}
            />
            <p className="muted">素材预览为静音。确认后可在完整预览中核对字幕与配乐。</p>
            <label>
              新素材开始（秒）
              <input
                type="number"
                min="0"
                max="180"
                step="0.01"
                value={start}
                onChange={(e) => {
                  video.current?.pause()
                  setStart(e.target.value)
                }}
              />
            </label>
            {info && (
              <p>
                素材 {info.width} × {info.height} · {info.duration.toFixed(2)} 秒；截取至{' '}
                {Number.isFinite(end) ? end.toFixed(2) : '—'} 秒
              </p>
            )}
            {!info && !error && <p role="status">正在检查替换素材…</p>}
            {(error || invalid) && (
              <p className="error" role="alert">
                {error || invalid}
              </p>
            )}
            {error && (
              <button type="button" onClick={() => choose(url)}>
                重试读取素材
              </button>
            )}
            <button
              type="button"
              disabled={!valid}
              onClick={() => {
                if (valid) onApply({ url, start: from, end })
              }}
            >
              确认替换片段 {index + 1}
            </button>
          </>
        ) : (
          <p role="status">本任务还没有其他素材。请在原任务中继续生成备用镜头，再返回剪辑。</p>
        )}
        <button type="button" onClick={onCancel}>
          取消替换
        </button>
      </fieldset>
    </section>
  )
}
