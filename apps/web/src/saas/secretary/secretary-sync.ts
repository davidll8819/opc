import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyBoard, type Board } from '../../../../../packages/secretary/model.mjs'
import { api } from '../api'
import type { Preferences } from './preferences'

export type SecretarySnapshot = { revision: number; board: Board; preferences?: Preferences }
// A slow request must never roll back a newer reply from either device.
export function mergeSecretarySnapshot(
  previous: SecretarySnapshot,
  next: SecretarySnapshot,
): SecretarySnapshot {
  if (next.revision < previous.revision) return previous
  const merged = { ...previous, ...next }
  if (!next.preferences && previous.preferences) merged.preferences = previous.preferences
  return merged
}
export function useSecretarySync(base: string) {
  const [snapshot, setSnapshot] = useState<SecretarySnapshot>({ revision: 0, board: emptyBoard() })
  const [lastSynced, setLastSynced] = useState(0)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const accept = useCallback((next: SecretarySnapshot) => {
    setSnapshot((previous) => mergeSecretarySnapshot(previous, next))
    setLastSynced(Date.now())
    setError('')
  }, [])
  const refresh = useCallback(async () => {
    const version = generation.current
    const next = await api<SecretarySnapshot>(`${base}/secretary`)
    if (version === generation.current) accept(next)
    return next
  }, [base, accept])
  const replaceBoard = useCallback(
    (board: Board) => {
      // Some older task APIs return just the board. Discard any read begun before it.
      generation.current += 1
      setSnapshot((previous) => ({ ...previous, board }))
      void refresh().catch(() => setError('同步暂时中断，显示上次记录'))
    },
    [refresh],
  )
  useEffect(() => {
    let live = true,
      pending = false
    const update = async () => {
      if (document.hidden || pending) return
      if (!navigator.onLine) {
        setError('网络已断开，恢复连接后自动同步')
        return
      }
      pending = true
      const version = generation.current
      try {
        const next = await api<SecretarySnapshot>(`${base}/secretary`)
        if (live && version === generation.current) accept(next)
      } catch {
        if (live) setError('同步暂时中断，显示上次记录')
      } finally {
        pending = false
      }
    }
    const offline = () => setError('网络已断开，恢复连接后自动同步')
    void update()
    const timer = window.setInterval(() => void update(), 5000)
    window.addEventListener('focus', update)
    window.addEventListener('online', update)
    window.addEventListener('offline', offline)
    document.addEventListener('visibilitychange', update)
    return () => {
      live = false
      generation.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', update)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', offline)
      document.removeEventListener('visibilitychange', update)
    }
  }, [base, accept])
  return { snapshot, lastSynced, error, accept, refresh, replaceBoard }
}
export type SecretarySync = ReturnType<typeof useSecretarySync>
