import { z } from 'zod'
import { briefFields, formatTaskBrief } from '../../../packages/secretary/task-brief.mjs'
export const taskBriefSchema = z.object(Object.fromEntries(briefFields.map(([key, , limit]) => [key, z.string().trim().max(limit).default('')]))).strict().refine(b => !!b.goal, '请填写任务目标')
export function captureTaskBrief(brief, at = new Date().toISOString()) {
  return brief ? { ...taskBriefSchema.parse(Object.fromEntries(briefFields.map(([key]) => [key, brief[key]]))), version: 1, capturedAt: at } : undefined
}
export function attachTaskBrief(task, brief) {
  if (!brief) return task
  const requirement = formatTaskBrief(brief)
  return { ...task, briefSnapshot: structuredClone(brief), request: `${task.request || task.summary || ''}\n\n${requirement}` }
}
