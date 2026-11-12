import { z } from 'zod'
import { fail } from '../db.mjs'

const seconds = z.number().finite().min(0).max(180)
export const videoEditSchema = z
  .object({
    requestId: z.string().uuid(),
    title: z.string().trim().min(1).max(80),
    segments: z
      .array(
        z
          .object({
            url: z.string().url().max(4096),
            start: seconds,
            end: seconds,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    ratio: z.enum(['9:16', '16:9', '1:1']),
    resolution: z.enum(['720p', '1080p']),
    fit: z.enum(['contain', 'cover']).default('contain'),
    subtitles: z
      .array(
        z
          .object({
            start: seconds,
            end: seconds,
            text: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .refine((s) => !/[\x00-\x08\x0b-\x1f]/.test(s)),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    originalVolume: z.number().min(0).max(1).default(1),
    musicVolume: z.number().min(0).max(1).default(0.2),
    narration: z.object({ name: z.string().max(120), base64: z.string().max(12 * 1024 * 1024) }).strict().optional(),
    narrationFromEditId: z.uuid().optional(),
    narrationVolume: z.number().min(0).max(1).optional(),
    narrationCues: z.array(z.object({ start: seconds, end: seconds }).strict()).max(30).optional(),
    musicFade: z.number().min(0).max(5).optional(),
    duckMusic: z.boolean().optional(),
    musicFromEditId: z.string().uuid().optional(),
    music: z
      .object({ name: z.string().max(120), base64: z.string().max(12 * 1024 * 1024) })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !(value.music && value.musicFromEditId), '新配乐与已保存配乐不能同时选择')

export function parseVideoEdit(value) {
  const input = videoEditSchema.parse(value)
  const duration = Math.round(input.segments.reduce((total, s) => total + s.end - s.start, 0) * 1000) / 1000
  if (input.segments.some((s) => s.end - s.start < 0.1 - 1e-6) || duration > 180)
    throw fail(400, '每个片段至少0.1秒，成片总时长不能超过180秒')
  if (
    input.subtitles.some(
      (s, i) =>
        s.end <= s.start ||
        s.end > duration + 0.001 ||
        (i > 0 && s.start < input.subtitles[i - 1].end),
    )
  )
    throw fail(400, '字幕请按时间排列，不能重叠或超出成片时长')
  let music = null
  if (input.music) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.music.base64)) throw fail(400, '配乐文件格式无效')
    music = Buffer.from(input.music.base64, 'base64')
    if (!music.length || music.length > 8 * 1024 * 1024) throw fail(400, '配乐文件不能超过8MB')
  }
  if (input.narration && input.narrationFromEditId) throw fail(400, '不能同时选择两份配音')
  let narration = null
  if (input.narration) {
    narration = Buffer.from(input.narration.base64, 'base64')
    if (!narration.length || narration.length > 8 * 1024 * 1024 || narration.toString('base64') !== input.narration.base64) throw fail(400, '配音格式无效或超过8MB')
  }
  if (input.narrationCues?.some((s, i) => s.end <= s.start || s.end > duration + 0.001 || (i > 0 && s.start < input.narrationCues[i-1].end))) throw fail(400, '配音时间超出成片或相互重叠')
  const { requestId, music: upload, musicFromEditId, narration: voice, narrationFromEditId, ...spec } = input
  return {
    requestId,
    spec: { ...spec, duration, musicName: upload?.name || '', ...(voice ? { narrationName: voice.name } : {}) },
    music,
    musicFromEditId, narration, narrationFromEditId,
  }
}

export function editDimensions(spec) {
  const short = spec.resolution === '1080p' ? 1080 : 720
  const long = spec.resolution === '1080p' ? 1920 : 1280
  return spec.ratio === '9:16'
    ? [short, long]
    : spec.ratio === '16:9'
      ? [long, short]
      : [short, short]
}
