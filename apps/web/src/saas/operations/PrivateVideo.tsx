import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type VideoHTMLAttributes,
  type ReactNode,
} from 'react'
import { api } from '../api'

type Context = { root: string; taskId: string }
function target(src: string, context?: Context) {
  const edit = /^(\/api\/tenants\/[^/]+\/operations)\/video-edits\/([^/?]+)\/media(?:\?.*)?$/.exec(
    src,
  )
  if (edit) return { root: edit[1], body: { kind: 'edit', id: edit[2] } }
  const archive = /^(\/api\/tenants\/[^/]+)\/files\/([^/?]+)\/video$/.exec(src)
  if (archive)
    return { root: `${archive[1]}/operations`, body: { kind: 'archive', id: archive[2] } }
  if (context && /^https?:\/\//.test(src))
    return { root: context.root, body: { kind: 'source', taskId: context.taskId, url: src } }
  return null
}
async function access(src: string, context?: Context) {
  const selected = target(src, context)
  if (!selected) return src
  return (await api<{ url: string }>(`${selected.root}/video-access`, selected.body)).url
}

// The saved source URL remains stable in drafts; only the playback address expires.
export const PrivateVideo = forwardRef<
  HTMLVideoElement,
  VideoHTMLAttributes<HTMLVideoElement> & { accessContext?: Context }
>(function PrivateVideo(
  { src = '', accessContext, onError, onLoadedMetadata, ...props },
  forwarded,
) {
  const version = useRef(0),
    retried = useRef(false)
  const restore = useRef<{ time: number; playing: boolean } | null>(null)
  const [url, setUrl] = useState<string>(),
    [error, setError] = useState('')
  const root = accessContext?.root,
    taskId = accessContext?.taskId
  const attach = useCallback(
    (node: HTMLVideoElement | null) => {
      if (typeof forwarded === 'function') forwarded(node)
      else if (forwarded) forwarded.current = node
    },
    [forwarded],
  )
  const renew = useCallback(async () => {
    const generation = ++version.current
    setError('')
    try {
      const next = await access(src, root && taskId ? { root, taskId } : undefined)
      if (generation === version.current) setUrl(next)
    } catch (e) {
      if (generation === version.current) setError((e as Error).message)
    }
  }, [src, root, taskId])
  useEffect(() => {
    const requestVersion = version
    setUrl(undefined)
    restore.current = null
    retried.current = false
    void renew()
    return () => {
      requestVersion.current++
    }
  }, [renew])
  return (
    <>
      <video
        {...props}
        src={url}
        ref={attach}
        onLoadedMetadata={(event) => {
          onLoadedMetadata?.(event)
          if (restore.current) {
            const saved = restore.current
            restore.current = null
            event.currentTarget.currentTime = Math.min(
              saved.time,
              event.currentTarget.duration || 0,
            )
            if (saved.playing) void event.currentTarget.play().catch(() => {})
          }
        }}
        onError={(event) => {
          if (!retried.current && target(src, root && taskId ? { root, taskId } : undefined)) {
            retried.current = true
            restore.current = {
              time: event.currentTarget.currentTime,
              playing: !event.currentTarget.paused,
            }
            void renew()
          } else {
            setError('视频暂时无法播放，请更新访问后重试')
            onError?.(event)
          }
        }}
      />
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            onClick={() => {
              retried.current = false
              void renew()
            }}
          >
            更新视频访问
          </button>
        </p>
      )}
    </>
  )
})

export function PrivateVideoLink({
  src,
  accessContext,
  download = false,
  children,
}: {
  src: string
  accessContext?: Context
  download?: boolean
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          const popup = download ? null : window.open('about:blank', '_blank')
          if (popup) popup.opener = null
          try {
            const url = await access(src, accessContext)
            if (download) {
              const a = document.createElement('a')
              a.href = `${url}${url.includes('?') ? '&' : '?'}download=1`
              a.download = 'video.mp4'
              a.click()
            } else if (popup) popup.location.href = url
            else throw Error('浏览器阻止了新窗口，请允许本站打开视频')
          } catch (e) {
            popup?.close()
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '正在获取访问…' : children}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  )
}
