import { archiveTask } from '../task-assets.mjs'
import { transaction, fail } from '../db.mjs'
// Only authenticated server responses can advance execution state. Browser text cannot mark a task complete.
export async function updateLinkedTask(pool, ctx, id, change) {
  return transaction(
    pool,
    async (db) => {
      const row = (
        await db.query(
          'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
          [ctx.tenantId, ctx.userId],
        )
      ).rows[0]
      const task = row?.board.tasks.find((t) => t.id === id && t.dept === 'app-agent')
      if (!task) throw fail(404, '任务不存在')
      change(task)
      await archiveTask(db, ctx, task)
      await db.query(
        'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
        [ctx.tenantId, ctx.userId, JSON.stringify(row.board)],
      )
    },
    ctx,
  )
}
export function runtimeOutput(value) {
  const texts = [],
    media = []
  function walk(v, depth = 0) {
    if (depth > 15 || !v) return
    if (typeof v === 'string') {
      texts.push(v)
      for (const match of v.matchAll(
        /\[Resource link: (?:Generated image|Image \d+)\]\s+(https?:\/\/[^\s<>]+)/g,
      ))
        media.push({ type: 'IMAGE', url: match[1] })
      if (v.length < 1024 * 1024 && (v.trim().startsWith('{') || v.trim().startsWith('['))) {
        try {
          walk(JSON.parse(v), depth + 1)
        } catch {
          /* Tool output may be plain text. */
        }
      }
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1))
      return
    }
    if (typeof v !== 'object') return
    if (['IMAGE', 'VIDEO'].includes(v.type) && /^https?:\/\//.test(v.url || ''))
      media.push({ type: v.type, url: v.url })
    if (['SUCCESS', 'completed'].includes(v.status) && /^https?:\/\//.test(v.videoUrl || ''))
      media.push({ type: 'VIDEO', url: v.videoUrl })
    if (
      v.type === 'resource_link' &&
      /image/i.test(v.name || '') &&
      /^https?:\/\//.test(v.uri || '')
    )
      media.push({ type: 'IMAGE', url: v.uri })
    if (v.text) walk(v.text, depth + 1)
    else if (v.content) walk(v.content, depth + 1)
    for (const k of ['message', 'messages', 'result', 'medias', 'structured_output'])
      if (v[k]) walk(v[k], depth + 1)
  }
  walk(value)
  return {
    text: [...new Set(texts)].join('\n').slice(0, 150000),
    media: [...new Map(media.map((m) => [m.url, m])).values()].slice(0, 30),
  }
}
// A runtime may label the agent loop completed even when its final reply is an API error.
// Keep confirmed media usable, but do not present unfinished post-processing as success.
export function runtimeCompletionWarning(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : []
  const last = messages.findLast((m) => m.type === 'assistant')
  const blocks = Array.isArray(last?.message?.content) ? last.message.content : []
  const terminal = messages.findLast((m) => ['assistant', 'result', 'error'].includes(m.type))
  const structuredFailure = !!last?.error || terminal?.type === 'error' || (terminal?.type === 'result' && terminal.is_error === true)
  const error = blocks.find((c) => c.type === 'text' && /^API Error:|^There's an issue with the selected model/i.test(c.text || '')) || (structuredFailure ? { text: '' } : null)
  if (!error) return ''
  const hasVideo = result.savedVideos?.some(
    (video) => video.status === 'SUCCESS' && /^https?:\/\//.test(video.videoUrl || ''),
  )
  // Saved errors can contain router stack traces and provider content. Surface
  // only known categories, including historical errors previously wrapped as 502.
  const parameterFailure = [
    '模型服务拒绝请求参数', '模型输出额度参数不兼容',
    '当前模型通道不兼容此工具调用', '模型思考参数或历史思考内容不兼容',
    '模型上下文超出限制', '模型请求内容过大',
  ].find(message => error.text.includes(message))
  if (parameterFailure)
    return `${parameterFailure}，制作已暂停。${hasVideo ? '已保存的视频仍可使用。' : '尚未确认可用视频。'}请先检查模型兼容性或任务上下文，再手动继续原任务；不要重复提交。`
  if (!hasVideo)
    return /今日模型额度不足/.test(error.text)
      ? '企业今日模型额度不足，本次制作未完成，尚未确认可用视频。请等待次日或由管理员确认额度后，再手动继续原任务。'
      : '本次模型执行中断，尚未确认可用视频。请核对原任务记录后再继续，不要重复提交。'
  return /今日模型额度不足/.test(error.text)
    ? '企业今日模型额度不足，后续文字整理中断；已保存的视频可继续剪辑、下载和归档。请等待次日或由管理员确认额度。'
    : '后续模型对话中断；已保存的素材可继续使用，请核对记录，不要重复生成。'
}
export function applyRuntimeStatus(task, result) {
  const status = result?.status
  if (!['running', 'completed', 'requires_action', 'error', 'aborted'].includes(status)) return
  task.status = status === 'running' ? 'working' : status === 'completed' ? 'completed' : 'blocked'
  task.executionNote = {
    running: '运营服务正在执行',
    completed: '运营制作流程已结束，请查看产物与平台回执',
    requires_action: '运营流程需要补充信息或账号授权',
    error: '运营服务执行失败，请查看任务记录',
    aborted: '运营任务已停止',
  }[status]
  if (status === 'completed') {
    const output = runtimeOutput(result.messages || result.result)
    const replies = Array.isArray(result.messages)
      ? result.messages
          .filter((message) => (message.type || message.role) === 'assistant')
          .flatMap((item) => {
            const message = item.message || item
            const content = message.content ?? message.text
            return (Array.isArray(content) ? content : [content]).flatMap((block) =>
              typeof block === 'string'
                ? [block]
                : block?.type === 'text'
                  ? [block.text || '']
                  : [],
            )
          })
          .filter((text) => text && !/^API Error:/i.test(text))
      : [output.text]
    task.summary =
      replies
        .slice(-3)
        .map((text) => text.slice(0, 4000))
        .join('\n\n') || '运营任务已结束，暂无可读取的文字成果，请查看运营工作台。'
    task.media = output.media
  }
  const warning = runtimeCompletionWarning(result)
  if (warning) {
    task.executionNote = warning
    const hasVideo = result.savedVideos?.some(
      (video) => video.status === 'SUCCESS' && /^https?:\/\//.test(video.videoUrl || ''),
    )
    if (!hasVideo && status === 'completed') {
      task.status = 'blocked'
      task.summary = warning
    }
  }
  task.runtimePending = false
  task.updatedAt = new Date().toISOString()
  if (status !== 'running') task.finishedAt = task.updatedAt
}
export async function* trackOperationsStream(stream, { pool, ctx, id, submissionId }) {
  const reader = stream.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    runtimeId
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const payload = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        if (!runtimeId && /^[a-f0-9]{24}$/.test(event.taskId || '')) {
          runtimeId = event.taskId
          await updateLinkedTask(pool, ctx, id, (t) => {
            if (submissionId && t.runtimeSubmissionId !== submissionId) return
            t.runtimeTaskId = runtimeId
            t.runtimePending = false
            t.status = 'working'
            t.executionNote = '运营服务正在执行'
            t.updatedAt = new Date().toISOString()
          })
        }
      }
      if (buffer.length > 1024 * 1024) buffer = ''
      yield value
    }
  } finally {
    reader.releaseLock()
    // SSE ending is not evidence that generation or publishing succeeded.
    await updateLinkedTask(pool, ctx, id, (t) => {
      if (submissionId && t.runtimeSubmissionId !== submissionId) return
      if (t.status === 'completed') return
      if (!runtimeId) {
        t.status = 'blocked'
        t.executionNote = '运营任务结果待核对，请勿重复提交'
      } else t.executionNote = '正在核对运营服务任务状态'
    })
  }
}

// Workbench submissions appear in the same task list as secretary dispatches.
// Only the server-observed runtime ID establishes this link.
export async function linkWorkbenchTask(db, ctx, input, runtimeId) {
  await db.query(
    `INSERT INTO secretary_workspaces(tenant_id,user_id,board,revision) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, ctx.userId, JSON.stringify({ tasks: [], messages: [], batches: [] })],
  )
  const { board } = (
    await db.query(
      'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (board.tasks.some((t) => t.runtimeTaskId === runtimeId && !t.videoEditId)) return
  const now = new Date().toISOString()
  board.tasks.push({
    id: input.requestId,
    title: (input.prompt || '叶凡交接制作任务').slice(0, 80),
    request: input.prompt || '',
    summary: '',
    dept: 'app-agent',
    due: now.slice(0, 10),
    status: 'working',
    publishRequired: false,
    runtimeTaskId: runtimeId,
    runtimePending: false,
    startedAt: now,
    executionNote: '运营服务正在执行；成片需另行确认归档',
  })
  await db.query(
    'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
    [ctx.tenantId, ctx.userId, JSON.stringify(board)],
  )
}
