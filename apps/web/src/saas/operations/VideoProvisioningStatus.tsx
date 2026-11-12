import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { t } from '@/i18n'

type Provisioning = {
  state: string
  stage: string
  message: string
  canRetry: boolean
}
export function VideoProvisioningStatus({ root, canEdit, onReady }: {
  root: string
  canEdit: boolean
  onReady?: () => void
}) {
  const [status, setStatus] = useState<Provisioning | null>(null)
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const retryLock = useRef(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout>
    let wasPending = false
    async function refresh() {
      try {
        const next = await api<Provisioning>(`${root}/provisioning`)
        if (!active) return
        setStatus(next); setError('')
        const pending = ['queued', 'provisioning'].includes(next.state)
        if (wasPending && next.state === 'ready') onReady?.()
        wasPending = pending
        if (pending) timer = setTimeout(() => void refresh(), 3000)
      } catch (e) {
        if (active) setError((e as Error).message)
      }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [root, revision, onReady])
  async function retry() {
    if (retryLock.current) return
    retryLock.current = true
    setRetrying(true); setError('')
    try {
      setStatus(await api<Provisioning>(`${root}/provisioning/retry`, {}))
      setRevision(n => n + 1)
    } catch (e) { setError((e as Error).message) }
    finally { retryLock.current = false; setRetrying(false) }
  }
  if (!status && !error) return null
  return <section className="ops-readiness" aria-label={t('视频服务开通状态')}>
    <div role="status" aria-live="polite">
      <strong>{t(status?.message || '视频服务状态暂时无法读取')}</strong>
      {status?.state === 'ready'
        ? <p>{t('使用你在本工作空间保存的个人 Key。开通服务不生成视频、不调用付费模型。')}</p>
        : ['queued', 'provisioning'].includes(status?.state || '') && <p>{t('可以先设置员工和个人 Key，离开页面不会中断开通。')}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    {status?.canRetry && canEdit && <button onClick={() => void retry()} disabled={retrying}>
      {t(retrying ? '正在排队…' : status.state === 'not_requested' ? '开通视频服务' : '重试开通')}
    </button>}
    {status?.canRetry && !canEdit && <p>{t('请联系工作空间管理员开通。')}</p>}
    {error && <button onClick={() => setRevision(n => n + 1)}>{t('重新读取状态')}</button>}
  </section>
}
