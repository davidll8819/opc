export const FPS = 8
export const HOME = 235
export const FAR = 645
export const STEPS = [
  { id: 'work', label: '坐姿工作', duration: 2 },
  { id: 'rise', label: '起身', duration: 1.6 },
  { id: 'stand', label: '站立', duration: 0.4 },
  { id: 'out', label: '迈腿行走', duration: 3 },
  { id: 'turn', label: '转身', duration: 1 },
  { id: 'back', label: '走回工位', duration: 3 },
  { id: 'align', label: '转向座位', duration: 1 },
  { id: 'sit', label: '坐下', duration: 1.6 },
]
export const DURATION = STEPS.reduce((total, step) => total + step.duration, 0)
const frame = (progress, count) => Math.min(count - 1, Math.floor(progress * count))

export function sample(time, mode = 'cycle') {
  const nonnegative = Number.isFinite(time) ? Math.max(0, time) : 0
  if (mode === 'walk') return { sheet: 'walk', frame: Math.floor(nonnegative * FPS) % 8, x: 450, flip: false, label: '原地迈腿 · 检查步态', phase: 'walk' }
  if (mode === 'turn') return { sheet: 'turn', frame: Math.floor(nonnegative * FPS / 2) % 8, x: 450, flip: false, label: '八方向转身', phase: 'turn' }
  if (mode === 'sit') return { sheet: 'sit', frame: 7, x: HOME, flip: false, label: '坐姿 · 检查屈膝与座位', phase: 'work' }
  let elapsed = nonnegative % DURATION
  let step = STEPS[0]
  for (const candidate of STEPS) {
    step = candidate
    if (elapsed < candidate.duration) break
    elapsed -= candidate.duration
  }
  const p = elapsed / step.duration
  const pose = { sheet: 'sit', frame: 7, x: HOME, flip: false, label: step.label, phase: step.id }
  if (step.id === 'rise') pose.frame = 7 - frame(p, 8)
  if (step.id === 'stand') pose.frame = 0
  if (step.id === 'sit') pose.frame = frame(p, 8)
  if (step.id === 'out' || step.id === 'back') {
    pose.sheet = 'walk'
    pose.frame = Math.floor(elapsed * FPS) % 8
    pose.flip = step.id === 'back'
    pose.x = pose.flip ? FAR - (FAR - HOME) * p : HOME + (FAR - HOME) * p
  }
  if (step.id === 'turn' || step.id === 'align') {
    pose.sheet = 'turn'
    pose.frame = step.id === 'turn' ? frame(p, 5) : 4 - frame(p, 5)
    pose.x = step.id === 'turn' ? FAR : HOME
  }
  return pose
}

export function nextFrameTime(time, mode = 'cycle') {
  const current = sample(time, mode)
  // Frame durations differ between a walk, a turn and a transition. Advance to
  // the next distinct picture instead of skipping poses using a fixed interval.
  for (let tick = 1; tick <= Math.ceil(DURATION * 240); tick++) {
    const next = time + tick / 240
    const candidate = sample(next, mode)
    if (candidate.phase !== current.phase || candidate.frame !== current.frame) return next
  }
  return time // A deliberately static seated-pose inspection.
}
