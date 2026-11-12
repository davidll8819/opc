import { musicFilter } from '../../../../packages/video-edit/audio.mjs'
import { wrapSubtitle } from '../../../../packages/video-edit/presentation.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, copyFile, writeFile, stat, chmod } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fail } from '../db.mjs'
import { openVideoDownload } from './video-download.mjs'
import { editDimensions } from './video-edit-schema.mjs'
const execute = promisify(execFile)

export async function mediaCommand(executable, args, options = {}) {
  try {
    return await execute(executable, args, {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024,
      ...options,
      env: { ...process.env },
      windowsHide: true,
    })
  } catch (error) {
    // Never return subprocess stderr: media paths and user content may be private.
    if (error.name === 'AbortError') throw error
    throw fail(
      422,
      error.code === 'ENOENT'
        ? '本机缺少视频处理工具，请联系管理员安装FFmpeg'
        : '视频处理失败，请检查素材格式和截取时间后重试',
    )
  }
}

export async function probeMedia(file, entry, signal) {
  const { stdout } = await mediaCommand(
    join(entry.ffmpegBin || '', 'ffprobe'),
    [
      '-v',
      'error',
      '-protocol_whitelist',
      'file,pipe',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      file,
    ],
    { signal, timeout: 30000 },
  )
  const metadata = JSON.parse(stdout)
  const video = metadata.streams.find((s) => s.codec_type === 'video')
  const duration = Number(metadata.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600)
    throw fail(422, '素材时长无法识别或超过一小时')
  if (video && (!video.width || !video.height || video.width > 4096 || video.height > 4096))
    throw fail(422, '素材尺寸无效或超过4096像素')
  return {
    duration,
    width: video?.width,
    height: video?.height,
    codec: video?.codec_name,
    audio: metadata.streams.some((s) => s.codec_type === 'audio'),
  }
}

export async function saveInput(response, file, signal) {
  let bytes = 0
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({
      transform(chunk, _, done) {
        bytes += chunk.length
        done(bytes > 100 * 1024 * 1024 ? fail(413, '单个视频素材不能超过100MB') : null, chunk)
      },
    }),
    createWriteStream(file, { mode: 0o600, flags: 'wx' }),
    { signal },
  )
}

export async function renderVideoEdit({
  entry,
  task,
  spec,
  music,
  narration,
  dir,
  signal,
  phase = async () => {},
  env = {},
}) {
  const ffmpeg = join(entry.ffmpegBin || '', 'ffmpeg')
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  const encoding = [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
  ]
  const [width, height] = editDimensions(spec)
  const inputs = new Map()
  await phase('读取原视频')
  for (const { url } of spec.segments) {
    if (inputs.has(url)) continue
    const file = join(dir, `input-${inputs.size}.mp4`)
    const response = await openVideoDownload({ entry, task, url })
    await saveInput(response, file, signal)
    const info = await probeMedia(file, entry, signal)
    if (!info.width) throw fail(422, '所选素材没有可用的视频画面')
    inputs.set(url, { file, info })
  }
  const scaled =
    spec.fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`
  for (const [i, segment] of spec.segments.entries()) {
    await phase(`处理片段 ${i + 1}/${spec.segments.length}`)
    const { file, info } = inputs.get(segment.url)
    if (segment.end > info.duration + 0.04 || segment.start >= info.duration)
      throw fail(422, `片段${i + 1}超出原视频时长（${info.duration.toFixed(2)}秒）`)
    const duration = segment.end - segment.start
    const args = [
      ...base,
      '-protocol_whitelist',
      'file,pipe',
      '-ss',
      String(segment.start),
      '-i',
      file,
    ]
    if (!info.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
    args.push(
      '-t',
      String(duration),
      '-map',
      '0:v:0',
      '-map',
      info.audio ? '0:a:0' : '1:a:0',
      '-vf',
      `${scaled},setsar=1,fps=30`,
      '-af',
      'aresample=48000,apad',
      '-ac',
      '2',
      '-map_metadata',
      '-1',
      ...encoding,
      '-movflags',
      '+faststart',
      `clip-${i}.mp4`,
    )
    await mediaCommand(ffmpeg, args, { cwd: dir, signal })
  }
  await writeFile(
    join(dir, 'concat.txt'),
    spec.segments.map((_, i) => `file 'clip-${i}.mp4'`).join('\n'),
    { mode: 0o600 },
  )
  await phase('合成字幕与声音')
  const args = [
    ...base,
    '-protocol_whitelist',
    'file,pipe',
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    'concat.txt',
  ]
  if (music) {
    await writeFile(join(dir, 'music'), music, { mode: 0o600 })
    if (!(await probeMedia(join(dir, 'music'), entry, signal)).audio)
      throw fail(422, '配乐文件没有可用的音轨')
    args.push('-stream_loop', '-1', '-protocol_whitelist', 'file,pipe', '-i', 'music')
  }
  if (narration) {
    await writeFile(join(dir, 'narration'), narration, { mode: 0o600 })
    const voiceInfo = await probeMedia(join(dir, 'narration'), entry, signal)
    if (!voiceInfo.audio || voiceInfo.duration > spec.duration + 0.15) throw fail(422, '配音缺少音轨或超过成片时长')
    args.push('-protocol_whitelist', 'file,pipe', '-i', 'narration')
  }
  const filters = []
  if (spec.subtitles.length) {
    const font = await subtitleFont(env)
    await copyFile(font, join(dir, 'font.ttf'))
    await chmod(join(dir, 'font.ttf'), 0o600)
    const fontSize = Math.round(Math.min(width, height) / 24)
    for (const [i, subtitle] of spec.subtitles.entries()) {
      await writeFile(
        join(dir, `subtitle-${i}.txt`),
        wrapSubtitle(subtitle.text, Math.floor((width / fontSize) * 0.84)),
        { mode: 0o600 },
      )
      filters.push(
        `drawtext=fontfile=font.ttf:textfile=subtitle-${i}.txt:expansion=none:fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black:box=1:boxcolor=black@0.5:boxborderw=10:x=(w-text_w)/2:y=h-text_h-h*0.08:enable='gte(t,${subtitle.start})*lt(t,${subtitle.end})'`,
      )
    }
  }
  const graph = [
    `[0:v]${filters.length ? filters.join(',') : 'null'}[v]`,
    `[0:a]volume=${spec.originalVolume}[original]`,
  ]
  const channels = ['original']
  if (music) { graph.push(`[1:a]${musicFilter({...spec, duckMusic: !!narration && spec.duckMusic})}[music]`); channels.push('music') }
  if (narration) { graph.push(`[${music ? 2 : 1}:a]aresample=48000,apad,volume=${spec.narrationVolume ?? 1}[voice]`); channels.push('voice') }
  graph.push(`${channels.map(c => `[${c}]`).join('')}amix=inputs=${channels.length}:duration=first:normalize=0,alimiter=limit=0.95:level=0[a]`)
  args.push(
    '-filter_complex_threads',
    '1',
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-t',
    String(spec.duration),
    '-map_metadata',
    '-1',
    ...encoding,
    '-movflags',
    '+faststart',
    'result.mp4',
  )
  await mediaCommand(ffmpeg, args, { cwd: dir, signal })
  const file = join(dir, 'result.mp4')
  await chmod(file, 0o600)
  const result = await probeMedia(file, entry, signal)
  if (
    result.width !== width ||
    result.height !== height ||
    Math.abs(result.duration - spec.duration) > 0.15
  )
    throw fail(422, '导出文件的尺寸或时长未通过检查，请重试')
  return { file, ...result, bytes: (await stat(file)).size }
}

export async function subtitleFont(env = {}) {
  const candidates = [
    env.VIDEO_EDIT_FONT,
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  ].filter(Boolean)
  let font
  for (const path of candidates)
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      font = path
      break
    }
  if (!font) throw fail(503, '缺少中文字幕字体，请配置VIDEO_EDIT_FONT后重试')
  return font
}
