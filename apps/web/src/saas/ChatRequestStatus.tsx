import './chat-request-status.css'
import { useEffect, useState } from 'react'
import { t } from '@/i18n'

export function ChatRequestStatus({
  text,
  received = false,
}: {
  text?: string
  received?: boolean
}) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [])
  return (
    <div className="chat-request-status" role="status" aria-live="polite">
      {text && (
        <p>
          <strong>{t('本次提交')}：</strong>
          {text.slice(0, 1000)}
          {text.length > 1000 ? '…' : ''}
        </p>
      )}
      <p>
        {t(received ? '服务已接收，正在等待模型或工具返回…' : '正在提交消息，等待服务响应…')}{' '}
        {seconds}
        {t('秒')}
      </p>
      {seconds >= 30 && (
        <p>{t('本次处理耗时较长，请勿重复发送；如连接中断，请先核对对话或任务记录。')}</p>
      )}
    </div>
  )
}
