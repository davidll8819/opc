export type ResearchQuality = {
  version: number
  status: 'ready_review' | 'partial'
  checkedAt: string
  questions: { id: string; question: string; status: 'covered' | 'partial' | 'missing'; reason: string;
    evidence: { sourceId: string; quote: string; kind: string }[] }[]
  issues: string[]
  usage: { searches: number; reads: number; elapsedMs: number }
  limits: { searches: number; reads: number; milliseconds: number }
  acceptance?: { at: string; decision: 'accepted'; note: string }
}
export const RESEARCH_LIMITS: Readonly<{ searches: number; reads: number; milliseconds: number }>
export function researchQualityLabel(quality?: ResearchQuality): string
export function researchExecutionLabel(task: { status: string; engine?: string; quality?: ResearchQuality }): string | null
