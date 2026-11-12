// Visual identity only. These IDs do not create employees or change skill/model bindings.
export const OFFICE_CHARACTER_LIBRARY = [
  { employeeId: 'marvis', name: '李婉儿', characterId: 'li-waner', variant: 'library' },
  { employeeId: 'code-agent', name: '龙傲天', characterId: 'long-aotian', variant: 'long-aotian' },
  { employeeId: 'file-agent', name: '赵雅梦', characterId: 'zhao-yameng', variant: 'zhao-yameng' },
  { employeeId: 'app-agent', name: '叶凡', characterId: 'ye-fan', variant: 'ye-fan' },
  { employeeId: 'review-agent', name: '刘市', characterId: 'liu-shi', variant: 'liu-shi' },
  { employeeId: 'data-agent', name: '派阿奇', characterId: 'pai-aqi', variant: 'pai-aqi' },
  { employeeId: 'new-agent-7', name: '林幼薇', characterId: 'lin-youwei', variant: 'lin-youwei' },
  { employeeId: 'new-agent-8', name: '西罗', characterId: 'xi-luo', variant: 'xi-luo' },
  { employeeId: 'xu-zhining', name: '许知宁', characterId: 'xu-zhining', variant: 'xu-zhining' },
  { employeeId: 'cheng-zhiyao', name: '程知遥', characterId: 'cheng-zhiyao', variant: 'cheng-zhiyao' },
  { employeeId: 'su-ying', name: '苏映', characterId: 'su-ying', variant: 'su-ying' },
  { employeeId: 'shen-qinglan', name: '沈清岚', characterId: 'shen-qinglan', variant: 'shen-qinglan' },
] as const

export type LibraryVariant = typeof OFFICE_CHARACTER_LIBRARY[number]['variant']
export function officeMotionSource(variant: LibraryVariant | 'classic' | 'compact', sheet: 'sit-back' | 'walk' | 'turn') {
  const combined = ['xu-zhining', 'cheng-zhiyao', 'su-ying', 'shen-qinglan'].includes(variant)
  const base = variant === 'library' ? '/assets/characters/li-waner-library-v3'
    : variant === 'compact' ? '/previews/li-waner-proportions/motion'
    : variant === 'classic' ? '/previews/li-waner-motion'
    : `/assets/characters/${variant}-library-v3`
  return { url: `${base}/${combined ? 'motion' : sheet}.png`, rows: combined ? 6 : 2,
    firstRow: combined ? { 'sit-back': 0, walk: 2, turn: 4 }[sheet] : 0 }
}
export function officeCharacterFor(employeeId: string) {
  return OFFICE_CHARACTER_LIBRARY.find(entry => entry.employeeId === employeeId)
}

const KEY = 'wishtaday.office.character-library.v3'
export function readOfficeLibrary() {
  try { return localStorage.getItem(KEY) !== 'original' } catch { return true }
}
export function saveOfficeLibrary(enabled: boolean) {
  try { localStorage.setItem(KEY, enabled ? 'library' : 'original') } catch { /* Session still works. */ }
}
