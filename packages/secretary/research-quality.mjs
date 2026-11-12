export const RESEARCH_LIMITS = Object.freeze({ searches: 6, reads: 12, milliseconds: 360000 })
export function researchQualityLabel(quality) {
  if (quality?.acceptance) return quality.status === 'partial' ? '已接受当前范围，仍有缺口' : '已验收（证据检查通过）'
  return quality?.status === 'ready_review' ? '证据检查通过，待验收'
    : quality?.status === 'partial' ? '部分交付，仍有缺口' : '历史成果，尚未核查'
}
export function researchExecutionLabel(task) {
  return task.status === 'completed' && (task.engine === 'research-v1' || task.quality)
    ? '执行已结束' : null
}
