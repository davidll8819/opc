import { z } from 'zod'
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fail } from '../db.mjs'
import { assertRuntimeAccess } from './task-access.mjs'
import { mediaCommand, probeMedia } from './video-edit-render.mjs'

export async function generateNarration({ text, entry, duration, voice = 'Tingting', signal }) {
  if (process.platform !== 'darwin') throw fail(503, '本机中文配音需要 macOS 已安装的中文语音')
  const lines = text.split(/(?<=[。！？!?；;\n])/u).map(v => v.trim()).filter(Boolean)
  if (!lines.length || lines.length > 30 || lines.some(v => v.length > 100))
    throw fail(400, '请按句号分句，每句最多100字、总计最多30句')
  const dir = await mkdtemp(join(tmpdir(), 'office-narration-'))
  try {
    await chmod(dir, 0o700)
    let position = 0
    const subtitles = []
    for (const [i, line] of lines.entries()) {
      await writeFile(join(dir, `${i}.txt`), line, { mode: 0o600 })
      await mediaCommand('/usr/bin/say', ['-v', voice, '-r', '185', '-f', `${i}.txt`, '-o', `${i}.aiff`], { cwd: dir, signal, timeout: 30000 })
      const info = await probeMedia(join(dir, `${i}.aiff`), entry, signal)
      const end = Math.round((position + info.duration) * 1000) / 1000
      subtitles.push({ start: position, end, text: line }); position = end
      if (position > duration) throw fail(422, `配音超过成片 ${duration.toFixed(1)} 秒，请缩短文案后重试`)
    }
    await writeFile(join(dir, 'list.txt'), lines.map((_, i) => `file '${i}.aiff'`).join('\n'), { mode: 0o600 })
    await mediaCommand(join(entry.ffmpegBin || '', 'ffmpeg'), ['-v', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'list.txt', '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '128k', 'voice.mp3'], { cwd: dir, signal })
    const bytes = await readFile(join(dir, 'voice.mp3'))
    return { narration: { name: '中文配音.mp3', base64: bytes.toString('base64') }, subtitles, duration: position }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function registerNarration(app, { scoped, driver }) {
  const active = new Set()
  app.post('/api/tenants/:tenantId/operations/tasks/:taskId/narration', async req => {
    const task = z.string().regex(/^[a-f0-9]{24}$/).parse(req.params.taskId)
    const input = z.object({ text: z.string().trim().min(1).max(1500), duration: z.number().min(1).max(180) }).strict().parse(req.body)
    const ctx = await scoped(req, async (db, tenant, ctx) => { await assertRuntimeAccess(db, ctx, task); return ctx }, ['owner', 'admin'])
    const key = `${ctx.tenantId}:${ctx.userId}`
    if (active.has(key)) throw fail(429, '配音正在生成，请稍候')
    active.add(key)
    try {
      const entry = await driver.binding(ctx.tenantId,ctx.userId)
      if (!entry) throw fail(503, '本机视频服务尚未连接')
      return await generateNarration({ ...input, entry, signal: AbortSignal.timeout(120000) })
    } finally { active.delete(key) }
  })
}
