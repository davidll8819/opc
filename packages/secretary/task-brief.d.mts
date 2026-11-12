import type { Task } from './model.mjs'
export type TaskBrief = { project: string; goal: string; audience: string; format: string; acceptance: string; budget: string; materials: string }
export type BriefSnapshot = TaskBrief & { version: 1; capturedAt: string }
export const briefFields: [keyof TaskBrief, string, number][]
export function formatTaskBrief(brief?: Partial<TaskBrief>): string
export function taskAttention(task: Task): string

export const emptyBrief: TaskBrief
