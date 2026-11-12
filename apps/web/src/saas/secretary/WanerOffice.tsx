import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLanguage } from '@/i18n'
import type { Board } from '../../../../../packages/secretary/model.mjs'
import { roomSnapshot, taskLabels } from './waner-office-state'
import './waner-office.css'

type Props = {
  privateOrigin?: string | null
  board: Board
  loaded: boolean
  error: string
  lastSynced: number
  conversationOpen: boolean
  onConversationChange: (open: boolean) => void
  onTask: (id: string) => void
  onAllTasks: () => void
  children: ReactNode
}
export function WanerOffice({
  privateOrigin,
  board,
  loaded,
  error,
  lastSynced,
  conversationOpen,
  onConversationChange,
  onTask,
  onAllTasks,
  children,
}: Props) {
  const en = useLanguage() === 'en'
  const [visited, setVisited] = useState(false)
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [copied, setCopied] = useState('')
  const [assetError, setAssetError] = useState(false)
  const conversation = useRef<HTMLDialogElement>(null)
  const phone = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const snapshot = roomSnapshot(board)
  const shareOrigin = privateOrigin || (location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) ? location.origin : '')
  const canShare = !!shareOrigin
  const phoneUrl = `${shareOrigin}/${location.hash}`
  useEffect(() => {
    const dialog = conversation.current
    if (conversationOpen && !dialog?.open) {
      trigger.current = document.activeElement as HTMLElement
      setVisited(true)
      dialog?.showModal()
    } else if (!conversationOpen && dialog?.open) {
      dialog.close()
      if (trigger.current?.isConnected) trigger.current.focus()
    }
  }, [conversationOpen])
  useEffect(() => {
    if (phoneOpen && !phone.current?.open) phone.current?.showModal()
    else if (!phoneOpen && phone.current?.open) phone.current.close()
  }, [phoneOpen])
  const say = error
    ? en
      ? 'Sync interrupted. Showing the last saved records.'
      : '连接暂时中断，我会在恢复连接后核对工作。'
    : !loaded
      ? en
        ? 'Checking your office…'
        : '我正在核对办公室的工作…'
      : en
        ? `${snapshot.working.length} running · ${snapshot.attention.length} need attention`
        : snapshot.line
  return (
    <section className="waner-room" aria-label={en ? 'Personal secretary' : '私人秘书'}>
      <header className="waner-room-heading">
        <div>
          <p>WISHTADAY / PRIVATE OFFICE</p>
          <h1>{en ? 'Personal secretary' : '私人秘书'}</h1>
        </div>
        <button onClick={() => setPhoneOpen(true)} className="waner-device">
          <Icon type="phone" />
          {en ? 'Phone connection' : '手机连接'}
        </button>
      </header>
      <div className="waner-stage" data-mode={snapshot.mode}>
        <img
          className="waner-backdrop"
          src="/assets/waner-office/office.png"
          alt=""
          onError={() => setAssetError(true)}
        />
        <div className="waner-wall" aria-label={en ? 'Live tasks' : '真实任务状态'}>
          <div className="waner-wall-title">
            {en ? 'Office activity' : '办公室动态'}
            <span>
              {error
                ? en
                  ? 'Offline'
                  : '等待同步'
                : loaded
                  ? en
                    ? 'Task records'
                    : '任务记录'
                  : '…'}
            </span>
          </div>
          {snapshot.featured.map((task) => (
            <button key={task.id} onClick={() => onTask(task.id)}>
              <span>{task.title}</span>
              <small>{taskLabels[task.status]}</small>
            </button>
          ))}
          {!snapshot.featured.length && <p>{en ? 'No tasks yet' : '尚未安排任务'}</p>}
        </div>
        <div className="waner-inhabitant">
          <div className="waner-speech" role="status" aria-live="polite">
            {say}
          </div>
          <button
            className="waner-character"
            onClick={() => onConversationChange(true)}
            aria-label={en ? 'Talk to Waner' : '打开与婉儿的对话'}
          >
            <img
              src="/assets/waner-office/waner.png"
              alt={
                en
                  ? 'Waner, wearing a satin blouse and charcoal skirt'
                  : '盘发、缎面衬衫与深灰裙装的李婉儿'
              }
              draggable="false"
              onError={() => setAssetError(true)}
            />
          </button>
        </div>
        {assetError && (
          <p className="waner-asset-error" role="alert">
            {en
              ? 'Scene image unavailable. Tasks and messages remain available.'
              : '场景素材暂时无法加载，仍可使用工作和消息入口。'}
          </p>
        )}
        <div className="waner-scene-caption">
          <span>李婉儿</span>
          <span>{en ? 'Your private secretary' : '你的私人秘书'}</span>
        </div>
        <nav className="waner-actions" aria-label={en ? 'Office actions' : '办公室操作'}>
          <button onClick={onAllTasks}>
            <Icon type="work" />
            {en ? 'Tasks' : '待办工作'}
            {snapshot.attention.length > 0 && (
              <span className="waner-count" aria-label={`${snapshot.attention.length} 项待处理`}>
                {snapshot.attention.length}
              </span>
            )}
          </button>
          <button className="waner-messages-button" onClick={() => onConversationChange(true)}>
            <Icon type="message" />
            {en ? 'Messages' : '消息'}
            <span className="waner-action-hint">{en ? 'Talk to Waner' : '与婉儿对话'}</span>
          </button>
        </nav>
      </div>
      <footer className="waner-room-footer">
        <span role="status">
          {error
            ? en
              ? 'Sync interrupted · showing saved records'
              : error
            : loaded
              ? `${en ? 'Last synced' : '最近同步'} ${new Date(lastSynced).toLocaleTimeString(en ? 'en-GB' : 'zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
              : en
                ? 'Connecting…'
                : '正在连接…'}
        </span>
        <button onClick={onAllTasks}>{en ? 'Review tasks →' : '查看待处理工作 →'}</button>
      </footer>
      <dialog
        ref={conversation}
        className="waner-dialog waner-dialog-work"
        aria-labelledby="waner-conversation-title"
        onCancel={(event) => {
          event.preventDefault()
          onConversationChange(false)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onConversationChange(false)
        }}
      >
        <header>
          <h2 id="waner-conversation-title">
            {en ? 'Messages · Private secretary' : '消息 · 私人秘书'}
          </h2>
          <button
            autoFocus
            onClick={() => onConversationChange(false)}
            aria-label={en ? 'Return to personal secretary' : '返回私人秘书'}
          >
            ×
          </button>
        </header>
        <div className="waner-dialog-body">{(visited || conversationOpen) && children}</div>
      </dialog>
      <dialog
        ref={phone}
        className="waner-dialog waner-phone-dialog"
        aria-labelledby="waner-phone-title"
        onCancel={() => setPhoneOpen(false)}
      >
        <header>
          <h2 id="waner-phone-title">{en ? 'Connect from your phone' : '手机连接办公室'}</h2>
          <button
            autoFocus
            onClick={() => setPhoneOpen(false)}
            aria-label={en ? 'Close phone connection' : '关闭手机连接'}
          >
            ×
          </button>
        </header>
        <div className="waner-dialog-body waner-phone-info">
          {privateOrigin && <p className="waner-connection-notice">{en ? 'Keep Tailscale connected on your Mac and phone with the same personal account, then open this address. Sign in using your existing Wishtaday account.' : 'Mac 和手机上的 Tailscale 使用同一个个人账号并保持连接，再打开下面的地址，使用原来的 Wishtaday 账号登录。'}</p>}
          <h3>
            {canShare
              ? en
                ? 'Use the same office on your phone'
                : '在手机上进入同一个办公室'
              : en
                ? 'Remote entry is not configured yet'
                : '外出访问入口尚未配置'}
          </h3>
          <p>
            {en
              ? 'Sign in with the same account and select the same workspace. Sent messages, task progress and results use the same records.'
              : '手机与电脑使用同一个账号、同一个工作空间，已发送的消息、任务进度和成果共用一份记录。'}
          </p>
          {canShare ? (
            <>
              <label>
                {en ? 'Office address' : '办公室地址'}
                <input readOnly value={phoneUrl} onFocus={(event) => event.target.select()} />
              </label>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(phoneUrl)
                    setCopied(en ? 'Address copied' : '地址已复制')
                  } catch {
                    setCopied(en ? 'Select and copy the address above' : '请选中上方地址复制')
                  }
                }}
              >
                {en ? 'Copy phone address' : '复制手机入口'}
              </button>
              <p role="status">{copied}</p>
            </>
          ) : (
            <p className="waner-connection-notice">
              {en
                ? 'This computer currently uses a local address. An authenticated HTTPS entry must be configured before you can connect while away.'
                : '这台电脑目前使用本地地址。需要先配置带登录验证的 HTTPS 访问入口，外出时才能连回来。'}
            </p>
          )}
          <ul>
            <li>
              {en
                ? 'The computer must stay awake, online and running Wishtaday.'
                : '电脑保持开机、联网，Wishtaday 持续运行。'}
            </li>
            <li>
              {en
                ? 'Open pages check for updates every 5 seconds and refresh on reconnection.'
                : '页面打开时每 5 秒核对更新，恢复网络或返回页面时立即刷新。'}
            </li>
            <li>
              {en
                ? 'Lock-screen notifications are not enabled yet.'
                : '锁屏和关闭页面后的系统推送尚未启用。'}
            </li>
          </ul>
        </div>
      </dialog>
    </section>
  )
}
function Icon({ type }: { type: 'phone' | 'work' | 'message' }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          type === 'phone'
            ? 'M7 2h10v20H7V2Zm4 16h2'
            : type === 'work'
              ? 'M9 5V3h6v2M4 5h16v16H4V5Zm4 5h8M8 14h8M8 18h5'
              : 'M3 4h18v13H9l-6 4V4Zm4 6h0m5 0h0m5 0h0'
        }
      />
    </svg>
  )
}
