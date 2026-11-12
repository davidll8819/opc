import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api'

// JSON object key order is not a draft change (PostgreSQL JSONB also reorders keys).
const serialize = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

export function useVideoDraft<T>(
  path: string,
  value: T,
  restore: (value: T) => void,
  enabled: boolean,
  canEdit: boolean,
) {
  const [ready, setReady] = useState(false),
    [message, setMessage] = useState('正在读取草稿…'),
    [failed, setFailed] = useState(false)
  const state = useRef({
    revision: 0,
    saved: '',
    latest: '',
    busy: false,
    blocked: false,
    live: true,
    ready: false,
  })
  const restoreRef = useRef(restore)
  useLayoutEffect(() => {
    restoreRef.current = restore
  }, [restore])
  const serialized = serialize(value)
  useLayoutEffect(() => {
    state.current.latest = serialized
  }, [serialized])
  const save = useCallback(async () => {
    const s = state.current
    if (!s.ready || s.busy || s.blocked || !canEdit || s.latest === s.saved) return
    s.busy = true
    if (s.live) {
      setMessage('正在保存草稿…')
      setFailed(false)
    }
    try {
      while (s.latest !== s.saved) {
        const snapshot = s.latest
        const result = await api<{ revision: number }>(
          path,
          { content: JSON.parse(snapshot), revision: s.revision },
          'PUT',
        )
        s.revision = result.revision
        s.saved = snapshot
      }
      if (s.live) setMessage('草稿已自动保存')
    } catch (e) {
      s.blocked = true
      if (s.live) {
        setFailed(true)
        setMessage(`草稿未保存：${(e as Error).message}`)
      }
    } finally {
      s.busy = false
    }
  }, [path, canEdit])
  const load = useCallback(async () => {
    const s = state.current
    if (s.busy) return
    setFailed(false)
    setMessage('正在读取草稿…')
    setReady(false)
    s.ready = false
    try {
      const result = await api<{ content: T | null; revision: number }>(path)
      if (!s.live) return
      s.revision = result.revision
      s.blocked = false
      if (result.content) {
        s.saved = serialize(result.content)
        s.latest = s.saved
        restoreRef.current(result.content)
      } else s.saved = s.latest
      s.ready = true
      setReady(true)
      setMessage(result.content ? '已恢复上次草稿' : '更改后自动保存草稿')
    } catch (e) {
      if (s.live) {
        setFailed(true)
        setMessage(`草稿读取失败：${(e as Error).message}`)
      }
    }
  }, [path])
  useEffect(() => {
    if (enabled && !state.current.ready) void load()
  }, [enabled, load])
  useEffect(() => {
    if (!ready || !canEdit || serialized === state.current.saved) return
    if (!state.current.blocked) setMessage('草稿有更改，等待保存…')
    const timer = setTimeout(() => void save(), 500)
    return () => clearTimeout(timer)
  }, [serialized, ready, save, canEdit])
  useEffect(() => {
    const s = state.current
    s.live = true
    const warn = (event: BeforeUnloadEvent) => {
      if (s.ready && s.latest !== s.saved) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      s.live = false
      window.removeEventListener('beforeunload', warn)
      void save()
    }
  }, [save])
  return {
    ready,
    message,
    failed,
    load,
    retry: () => {
      state.current.blocked = false
      void save()
    },
  }
}
