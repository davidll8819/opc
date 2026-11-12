import { useAudioSource } from './useAudioSource'
import { PrivateVideo } from './PrivateVideo'
import { musicGain } from '../../../../../packages/video-edit/audio.mjs'
import { useCallback, useEffect, useRef, useState } from 'react'
import { wrapSubtitle } from '../../../../../packages/video-edit/presentation.mjs'

type Segment = { url: string; start: number; end: number }
type Subtitle = { start: number; end: number; text: string }
type Props = {
  accessContext?: { root: string; taskId: string }
  segments: Segment[]
  subtitles: Subtitle[]
  aspect: number
  fit: 'contain' | 'cover'
  resolution: '720p' | '1080p'
  originalVolume: number
  musicVolume: number
  music?: { name: string; base64: string }
  narration?: { name: string; base64: string }
  savedNarrationUrl?: string
  narrationVolume?: number
  narrationCues?: { start: number; end: number }[]
  musicFade?: number
  duckMusic?: boolean
  savedMusicUrl?: string
  onMetadata: (url: string, duration: number, width: number, height: number) => void
  onSegment: (index: number) => void
}

export function VideoDraftPreview(props: Props) {
  const {
    segments,
    subtitles,
    aspect,
    fit,
    resolution,
    originalVolume,
    musicVolume,
    music,
    savedMusicUrl, narration, savedNarrationUrl, narrationVolume = 1, narrationCues = [], musicFade = 0, duckMusic = false,
    onMetadata,
    onSegment,
  } = props
  const [cursor, setCursor] = useState({ index: 0, offset: 0 }),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(''),
    [waiting, setWaiting] = useState(false),
    [expanded, setExpanded] = useState(false)
  const [musicUrl, setMusicUrl] = useState(''),
    [width, setWidth] = useState(0)
  const video = useRef<HTMLVideoElement>(null),
    audio = useRef<HTMLAudioElement>(null),
    voice = useRef<HTMLAudioElement>(null),
    frame = useRef<HTMLDivElement>(null)
  const voiceUrl = useAudioSource(narration, savedNarrationUrl)
  const wanted = useRef(false),
    epoch = useRef(0)
  const duration = segments.reduce((n, s) => n + Math.max(0, s.end - s.start), 0)
  const index = Math.min(cursor.index, segments.length - 1),
    segment = segments[index]
  const base = segments.slice(0, index).reduce((n, s) => n + s.end - s.start, 0)
  const invalid =
    segments.some(
      (s) => !Number.isFinite(s.start + s.end) || s.start < 0 || s.end - s.start < 0.1 - 1e-6,
    ) ||
    duration > 180 ||
    subtitles.some(
      (s, i) =>
        s.start < 0 ||
        s.end <= s.start ||
        s.end > duration + 0.001 ||
        (i > 0 && s.start < subtitles[i - 1].end),
    )
  const timeline = JSON.stringify(segments)
  const pause = useCallback(() => {
    wanted.current = false
    epoch.current++
    video.current?.pause()
    audio.current?.pause()
    voice.current?.pause()
    setPlaying(false)
  }, [])
  const fail = useCallback(
    (message: string) => {
      pause()
      setError(message)
    },
    [pause],
  )
  useEffect(() => {
    if (!music) {
      setMusicUrl(savedMusicUrl || '')
      return
    }
    const extension = music.name.split('.').at(-1)?.toLowerCase()
    const mime =
      extension === 'mp3' ? 'audio/mpeg' : extension === 'm4a' ? 'audio/mp4' : 'audio/wav'
    const bytes = Uint8Array.from(atob(music.base64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    setMusicUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [music, savedMusicUrl])
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (video.current) video.current.volume = originalVolume
    if (voice.current) voice.current.volume = narrationVolume
    if (audio.current) audio.current.volume = musicGain({ time, duration, volume: musicVolume, fade: Math.min(musicFade,duration/2), duck: !!voiceUrl && duckMusic, cues: narrationCues })
  }, [originalVolume, musicVolume, cursor, musicUrl, voiceUrl, narrationVolume, time, duration, musicFade, duckMusic, narrationCues])
  const syncMusic = useCallback((position: number, force = false) => {
    const v = voice.current
    if (v && Number.isFinite(v.duration)) {
      const target = Math.min(position, v.duration)
      if (Math.abs(v.currentTime-target) > (force ? 0.015 : 0.12)) v.currentTime = target
    }
    const a = audio.current
    if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return
    const target = position % a.duration
    if (Math.abs(a.currentTime - target) > (force ? 0.015 : 0.12)) a.currentTime = target
  }, [])
  const startMedia = useCallback(() => {
    const v = video.current,
      a = audio.current
    if (
      !wanted.current ||
      !v ||
      v.readyState < 2 ||
      v.seeking ||
      (musicUrl && (!a || a.readyState < 2)) ||
      (voiceUrl && (!voice.current || voice.current.readyState < 2))
    )
      return
    const generation = epoch.current
    syncMusic(base + v.currentTime - segment.start, true)
    void Promise.all([v.play(), ...(musicUrl && a ? [a.play()] : []), ...(voiceUrl && voice.current && voice.current.currentTime < voice.current.duration ? [voice.current.play()] : [])])
      .then(() => {
        if (epoch.current === generation) setWaiting(false)
      })
      .catch((e) => {
        if (e?.name === 'AbortError') return
        if (wanted.current && epoch.current === generation)
          fail('预览播放失败，请检查素材或配乐格式，然后重试。')
      })
  }, [musicUrl, voiceUrl, base, segment.start, syncMusic, fail])
  const seek = useCallback(
    (position: number) => {
      epoch.current++
      video.current?.pause()
      audio.current?.pause()
    voice.current?.pause()
      const target = Math.max(0, Math.min(duration, position))
      let offset = target,
        next = 0
      while (next < segments.length - 1 && offset >= segments[next].end - segments[next].start) {
        offset -= segments[next].end - segments[next].start
        next++
      }
      setTime(target)
      setCursor({ index: next, offset })
      onSegment(next)
      setError('')
      syncMusic(target, true)
    },
    [duration, segments, onSegment, syncMusic],
  )
  useEffect(() => {
    pause()
    setTime(0)
    setCursor({ index: 0, offset: 0 })
    setError('')
    onSegment(0)
    // A changed cut order is a new timeline. Subtitle and volume edits stay live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline, musicUrl, voiceUrl, pause])
  useEffect(() => {
    if (invalid) pause()
  }, [invalid, pause])
  useEffect(() => {
    const v = video.current
    if (v && v.readyState >= 1) {
      v.currentTime = segment.start + cursor.offset
      syncMusic(base + cursor.offset, true)
      if (!v.seeking) startMedia()
    }
  }, [cursor, segment.start, base, syncMusic, startMedia])
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    if (!node) video.current?.pause()
    video.current = node
  }, [])
  const attachVoice = useCallback((node: HTMLAudioElement | null) => {
    if (!node) voice.current?.pause()
    voice.current = node
  }, [])
  const attachAudio = useCallback((node: HTMLAudioElement | null) => {
    if (!node) audio.current?.pause()
    audio.current = node
  }, [])
  useEffect(() => {
    const control = { wanted, epoch }
    return () => {
      control.wanted.current = false
      control.epoch.current++
    }
  }, [])
  const tick = useCallback(() => {
    const v = video.current
    if (!v || !wanted.current || v.seeking || v.paused) return
    if (v.currentTime >= segment.end - 0.012) {
      if (index + 1 < segments.length) seek(base + segment.end - segment.start)
      else {
        pause()
        setTime(duration)
      }
      return
    }
    const current = Math.max(base, Math.min(duration, base + v.currentTime - segment.start))
    setTime(current)
    syncMusic(current)
  }, [segment.end, segment.start, index, segments.length, base, duration, seek, pause, syncMusic])
  useEffect(() => {
    if (!playing) return
    let id: number
    const update = () => {
      tick()
      id = requestAnimationFrame(update)
    }
    id = requestAnimationFrame(update)
    return () => cancelAnimationFrame(id)
  }, [playing, tick])
  function toggle() {
    if (wanted.current) {
      pause()
      return
    }
    setError('')
    wanted.current = true
    setPlaying(true)
    setWaiting(true)
    if (time >= duration - 0.02) {
      seek(0)
      return
    }
    startMedia()
  }
  const short = resolution === '1080p' ? 1080 : 720,
    canvasWidth = aspect >= 1 ? Math.round(short * aspect) : short
  const fontSize = Math.round(short / 24),
    scale = width / canvasWidth
  const captions = subtitles.filter((s) => s.start <= time && time < s.end && s.text)
  return (
    <div className="video-draft-preview" data-expanded={expanded}>
      <label>
        预览片段
        <select
          value={index}
          onChange={(e) =>
            seek(segments.slice(0, Number(e.target.value)).reduce((n, s) => n + s.end - s.start, 0))
          }
        >
          {segments.map((_, i) => (
            <option key={i} value={i}>
              片段 {i + 1}
            </option>
          ))}
        </select>
      </label>
      <div
        className="video-draft-stage"
        ref={frame}
        style={{
          aspectRatio: String(aspect),
          maxWidth: expanded ? `calc(65vh * ${aspect})` : undefined,
        }}
        aria-label="草稿合成预览"
      >
        <PrivateVideo accessContext={props.accessContext}
          key={`${index}:${segment.url}`}
          ref={attachVideo}
          src={segment.url}
          preload="auto"
          playsInline
          aria-label="剪辑原素材预览"
          style={{ aspectRatio: String(aspect), objectFit: fit, maxHeight: 'none' }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            onMetadata(segment.url, v.duration, v.videoWidth, v.videoHeight)
            v.volume = originalVolume
            if (segment.start >= v.duration || segment.end > v.duration + 0.04) {
              fail('片段超出原素材时长，请调整开始和结束时间。')
              return
            }
            v.currentTime = segment.start + cursor.offset
          }}
          onCanPlay={startMedia}
          onSeeked={startMedia}
          onTimeUpdate={tick}
          onWaiting={() => {
            setWaiting(true)
            audio.current?.pause()
    voice.current?.pause()
          }}
          onEnded={() => {
            if (!wanted.current) return
            if (index + 1 < segments.length) seek(base + segment.end - segment.start)
            else {
              pause()
              setTime(duration)
            }
          }}
          onError={() => fail('原视频暂时无法播放，请检查素材连接，然后重试。')}
        />
        {captions.map((s, i) => (
          <div
            key={i}
            className="video-draft-caption"
            data-testid="preview-caption"
            style={{
              fontSize: fontSize * scale,
              padding: 10 * scale,
              WebkitTextStroke: `${4 * scale}px black`,
            }}
          >
            {wrapSubtitle(s.text.trim(), Math.floor((canvasWidth / fontSize) * 0.84))}
          </div>
        ))}
      </div>
      {musicUrl && (
        <audio
          ref={attachAudio}
          src={musicUrl}
          preload="auto"
          loop
          aria-label="草稿配乐"
          onCanPlay={startMedia}
          onWaiting={() => {
            setWaiting(true)
            video.current?.pause()
            voice.current?.pause()
          }}
          onError={() => fail('配乐无法播放，请重新选择MP3、WAV或M4A文件。')}
        />
      )}
      {voiceUrl && <audio ref={attachVoice} src={voiceUrl} preload="auto" aria-label="草稿配音" onCanPlay={startMedia} onWaiting={() => { setWaiting(true); video.current?.pause(); audio.current?.pause() }} onError={() => fail('配音无法播放，请重新生成或移除配音')} />}
      <div className="video-draft-controls">
        <button type="button" disabled={invalid} onClick={toggle}>
          {playing ? '暂停预览' : '播放完整预览'}
        </button>
        <button
          type="button"
          disabled={invalid}
          onClick={() => {
            pause()
            seek(0)
            video.current?.load()
            audio.current?.load()
            voice.current?.load()
          }}
        >
          从头预览
        </button>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起放大预览' : '放大预览'}
        </button>
        <span aria-label="预览时间">
          {time.toFixed(2)} / {duration.toFixed(2)} 秒
        </span>
      </div>
      <label>
        成片预览进度
        <input
          aria-label="成片预览进度"
          type="range"
          min="0"
          max={duration || 0.1}
          step="0.01"
          value={time}
          disabled={invalid}
          onChange={(e) => seek(Number(e.target.value))}
        />
      </label>
      {playing && waiting && <p role="status">正在缓冲预览，画面和配乐会一起继续…</p>}
      {invalid && (
        <p className="error" role="alert">
          请先修正片段或字幕时间（不能重叠或超出成片），再播放预览。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        按成片时间预览字幕、片段、原声与循环配乐。修改字幕和音量立即生效；修改片段或配乐后从头播放。导出时的字体和峰值音量可能略有差异。
      </p>
    </div>
  )
}
