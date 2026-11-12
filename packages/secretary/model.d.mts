export type Task = {
  executionSettings?: { maxOutputTokens: 4096 | 8192 | 16384; deliveryNote: string }
  problem?: { code: string; limit?: number }
  partialResult?: { text: string; savedAt: string; limit: number }
  templateSource?: { id: string; version: number; title: string }
  knowledgeSnapshot?: { capturedAt: string; matched: number; records: { id: string; version: number; title: string; kind: string; project: string; source: string; content: string }[] }
  briefSnapshot?: import('./task-brief.mjs').BriefSnapshot
  quality?: import('./research-quality.mjs').ResearchQuality
  reportSections?: { summary: string; findings: string; analysis: string; recommendations: string; limitations: string }
  followUpOf?: string
  followUpRequestId?: string
  id: string
  batchId?: string
  title: string
  titleEn?: string
  titleZh?: string
  dept: string
  due: string
  status:
    | 'draft'
    | 'queued'
    | 'working'
    | 'approval'
    | 'review'
    | 'authorized'
    | 'revision'
    | 'completed'
    | 'blocked'
  publishRequired: boolean
  summary: string
  startedAt?: string
  finishedAt?: string
  updatedAt?: string
  executionNote?: string
  statusSyncError?: string
  lastStatusSyncAt?: string
  runtimeTaskId?: string
  runtimePending?: boolean
  engine?: 'research-v1' | 'department-v1'
  dependsOn?: string[]
  receivedInputs?: {
    taskId: string
    title: string
    dept: string
    receivedAt: string
    fileIds?: string[]
  }[]
  requiresConfirmation?: boolean
  steps?: { note: string; detail: string; time: string }[]
  researchOutline?: {
    id: string
    title: string
    questions: string[]
    query: string
    status: 'pending' | 'searching' | 'completed' | 'blocked' | 'partial'
    sourceIds?: string[]
    limitation?: string
  }[]
  sources?: { id: string; url: string; title: string; retrievedAt: string; read: boolean }[]
  videoEditId?: string
  archiveVideoFileId?: string
  archiveFileId?: string
  request?: string
  archivedAt?: string
  archiveNote?: string
  media?: { type: string; url: string }[]
  attachmentIds?: string[]
  archiveName?: string
  outputKind?: 'image' | 'text'
  images?: { fileId: string; name: string; mime: string; model: string }[]
  imagePrompt?: string
  previousTextResult?: string
  feedback?: string
}
export type Message = {
  briefSnapshot?: import('./task-brief.mjs').BriefSnapshot
  attachments?: { id: string; name: string; mime: string }[]
  id: string
  role: 'user' | 'assistant'
  text: string
  textEn?: string
  batchId?: string
  time?: string
}
export type Board = {
  lastReplyError?: { time: string; message: string; requestText: string }
  messages: Message[]
  tasks: Task[]
  batches: { id: string; status: 'draft' | 'queued' }[]
}
export type Action =
  | {
      type: 'send'
      text: string
      intent: 'plan' | 'remind' | 'report' | 'meeting'
      language: 'zh' | 'en'
    }
  | { type: 'edit'; batchId: string; tasks: Pick<Task, 'id' | 'title' | 'dept' | 'due'>[] }
  | { type: 'dispatch'; batchId: string }
  | { type: 'approve' | 'reject'; taskId: string; feedback?: string }
export const departments: { id: string; name: string; en: string; person: string }[]
export function emptyBoard(): Board
export function exampleBoard(today: string): Board
export function applyAction(
  board: Board,
  action: Action,
  context: { id: () => string; today: string; time: string },
): Board
