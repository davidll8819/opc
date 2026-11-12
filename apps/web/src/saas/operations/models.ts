export type OperationsBrief = {
  id: string
  title: string
  text: string
  sourceMessageId: string
  sourceRevision: number
  createdAt: string
  messages: { id: string; role: string; text: string }[]
}
export type OperationsHandoff = {
  id: string
  text: string
  secretaryTaskId?: string
  runtimeTaskId?: string
  brief?: OperationsBrief
}
export type OpenOperations = (
  text?: string,
  task?: import('../../../../../packages/secretary/model.mjs').Task,
  brief?: OperationsBrief,
) => void
export function readable(value: unknown, depth = 0): string {
  if (depth > 15) return ''
  if (typeof value === 'string') return value.slice(-30000)
  if (Array.isArray(value))
    return value
      .slice(-200)
      .map((v) => readable(v, depth + 1))
      .filter(Boolean)
      .join('\n')
      .slice(-150000)
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>
    for (const k of ['text', 'content', 'message', 'result', 'description', 'errors', 'tool_name'])
      if (r[k]) return readable(r[k], depth + 1)
  }
  return ''
}
export type VideoFormat = { ratio: '9:16' | '16:9' | '1:1'; resolution: '720p' | '1080p' }
export type ResultMedia = {
  type: string
  url: string
  specification?: {
    requested: VideoFormat
    actual: { width: number; height: number }
    matches: boolean
  }
}
export function mergeMedia(items: ResultMedia[]): ResultMedia[] {
  const merged = new Map<string, ResultMedia>()
  for (const item of items) {
    const previous = merged.get(item.url)
    merged.set(
      item.url,
      previous?.specification && !item.specification
        ? { ...item, specification: previous.specification }
        : item,
    )
  }
  return [...merged.values()].slice(0, 30)
}
export function resultMedia(value: unknown, depth = 0): ResultMedia[] {
  if (depth > 15) return []
  if (typeof value === 'string') {
    const links = [
      ...value.matchAll(
        /\[Resource link: (?:Generated image|Image \d+)\]\s+(https?:\/\/[^\s<>]+)/g,
      ),
    ]
      .slice(0, 30)
      .map((match) => ({ type: 'IMAGE', url: match[1] }))
    if (
      value.length < 1024 * 1024 &&
      (value.trim().startsWith('{') || value.trim().startsWith('['))
    ) {
      try {
        return [...links, ...resultMedia(JSON.parse(value), depth + 1)].slice(0, 30)
      } catch {
        return links
      }
    }
    return links
  }
  if (Array.isArray(value)) return value.flatMap((v) => resultMedia(v, depth + 1)).slice(0, 30)
  if (!value || typeof value !== 'object') return []
  const r = value as Record<string, unknown>
  if (
    typeof r.url === 'string' &&
    ['IMAGE', 'VIDEO'].includes(String(r.type)) &&
    /^https?:\/\//.test(r.url)
  )
    return [{ type: String(r.type), url: r.url }]
  if (
    ['SUCCESS', 'completed'].includes(String(r.status)) &&
    typeof r.videoUrl === 'string' &&
    /^https?:\/\//.test(r.videoUrl)
  ) {
    const s = r.specification as ResultMedia['specification']
    const resolution =
      typeof s?.requested?.resolution === 'string'
        ? s.requested.resolution.toLowerCase()
        : undefined
    const valid =
      s &&
      typeof s.matches === 'boolean' &&
      ['9:16', '16:9', '1:1'].includes(s.requested?.ratio) &&
      ['720p', '1080p'].includes(resolution || '') &&
      Number.isSafeInteger(s.actual?.width) &&
      s.actual.width > 0 &&
      Number.isSafeInteger(s.actual?.height) &&
      s.actual.height > 0
    return [
      {
        type: 'VIDEO',
        url: r.videoUrl,
        ...(valid
          ? {
              specification: {
                ...s,
                requested: { ...s.requested, resolution: resolution as VideoFormat['resolution'] },
              },
            }
          : {}),
      },
    ]
  }
  if (
    r.type === 'resource_link' &&
    /image/i.test(String(r.name)) &&
    typeof r.uri === 'string' &&
    /^https?:\/\//.test(r.uri)
  )
    return [{ type: 'IMAGE', url: r.uri }]
  return ['text', 'content', 'message', 'messages', 'result', 'medias', 'structured_output']
    .flatMap((k) => resultMedia(r[k], depth + 1))
    .slice(0, 30)
}

// Display authored replies only. Tool results and injected skill instructions are not conversation.
export function taskReply(value: unknown): string {
  const messages = Array.isArray(value) ? value : [value]
  const text = messages
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const m = item as Record<string, unknown>
      const role = m.role || m.type
      if (role && !['assistant', 'text', 'result'].includes(String(role))) return []
      const message = (m.message && typeof m.message === 'object' ? m.message : m) as Record<
        string,
        unknown
      >
      const content =
        message.content ?? message.text ?? (m.type === 'result' ? m.result : undefined)
      const blocks = Array.isArray(content) ? content : [content]
      return blocks.flatMap((b) =>
        typeof b === 'string'
          ? [b]
          : b && typeof b === 'object' && (b as { type?: string }).type === 'text'
            ? [String((b as { text?: string }).text || '')]
            : [],
      )
    })
    .filter((t) => t && !/^API Error:/i.test(t))
  return text
    .slice(-3)
    .map((t) =>
      t
        .replace(/(?:Bearer\s+)[^\s"']+/gi, 'Bearer [已隐藏]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已隐藏]')
        .slice(-1200),
    )
    .join('\n\n')
}
export function taskHeadline(phase: string, hasVideo: boolean): string {
  if (hasVideo && /中断|额度不足/.test(phase)) return '视频已生成，可继续剪辑和下载'
  if (phase === '制作已完成，请验收成果')
    return hasVideo ? '视频已生成，等待验收' : '制作已完成，请验收成果'
  if (phase === '正在制作，可查看实时记录') return '正在制作，可查看实时记录'
  return phase
}
