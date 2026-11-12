import { mkdtemp, chmod, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fail } from '../db.mjs'
import { openVideoDownload } from './video-download.mjs'
import { probeMedia, saveInput, subtitleFont, mediaCommand } from './video-edit-render.mjs'
import { editDimensions } from './video-edit-schema.mjs'

// Read-only preflight: no job, model call or persistent media is created.
export async function checkVideoEdit({ entry, task, spec, music, narration, env = {} }) {
  const dir = await mkdtemp(join(env.VIDEO_EDIT_TMP || tmpdir(), 'office-video-check-'))
  const signal = AbortSignal.timeout(120000)
  try {
    await chmod(dir, 0o700)
    await mediaCommand(join(entry.ffmpegBin || '', 'ffmpeg'), ['-version'], {
      signal,
      timeout: 10000,
    })
    if (spec.subtitles.length) await subtitleFont(env)
    const inputs = new Map(),
      warnings = new Set()
    const [width, height] = editDimensions(spec)
    let originalAudio = false
    for (const [i, segment] of spec.segments.entries()) {
      let info = inputs.get(segment.url)
      if (!info) {
        const file = join(dir, `input-${inputs.size}.mp4`)
        await saveInput(await openVideoDownload({ entry, task, url: segment.url }), file, signal)
        info = await probeMedia(file, entry, signal)
        inputs.set(segment.url, info)
      }
      if (!info.width) throw fail(422, `片段${i + 1}没有可用的视频画面`)
      if (segment.end > info.duration + 0.04 || segment.start >= info.duration)
        throw fail(
          422,
          `片段${i + 1}超出原视频时长（${info.duration.toFixed(2)}秒），请调整截取时间`,
        )
      originalAudio ||= info.audio
      if (Math.abs(info.width / info.height - width / height) > 0.02)
        warnings.add(
          spec.fit === 'cover'
            ? `片段${i + 1}与成片比例不同，会裁掉部分画面，请先核对预览`
            : `片段${i + 1}与成片比例不同，会保留完整画面并添加黑边`,
        )
      const scale = (spec.fit === 'cover' ? Math.max : Math.min)(
        width / info.width,
        height / info.height,
      )
      if (scale > 1.01) warnings.add(`片段${i + 1}会放大，导出更高分辨率不会增加原片细节`)
    }
    if (music) {
      const file = join(dir, 'music')
      await writeFile(file, music, { mode: 0o600 })
      let info
      try {
        info = await probeMedia(file, entry, signal)
      } catch {
        throw fail(422, '配乐无法读取，请换成可播放的音频文件')
      }
      if (!info.audio) throw fail(422, '配乐文件没有音轨，请重新选择音频')
      if (info.duration < spec.duration) warnings.add('配乐短于成片，将循环播放到片尾')
    }
    if (narration) {
      const file = join(dir, 'narration')
      await writeFile(file, narration, { mode: 0o600 })
      const info = await probeMedia(file, entry, signal)
      if (!info.audio || info.duration > spec.duration + 0.15) throw fail(422, '配音缺少音轨或超过成片时长，请缩短文案重新生成')
    }
    if (!narration && !(originalAudio && spec.originalVolume > 0) && !(music && spec.musicVolume > 0))
      warnings.add('当前设置会导出无声视频')
    return { ok: true, width, height, duration: spec.duration, warnings: [...warnings] }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
