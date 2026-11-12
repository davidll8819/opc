export function musicGain({ time, duration, volume, fade = 0, duck = false, cues = [] }) {
  const edge = fade > 0 ? Math.max(0, Math.min(1, time / fade, (duration - time) / fade)) : 1
  return volume * edge * (duck && cues.some(c => time >= c.start && time < c.end) ? 0.25 : 1)
}
export function musicFilter(spec) {
  const fade = Math.min(spec.musicFade || 0, spec.duration / 2)
  const filters = ['aresample=48000']
  if (fade) filters.push(`afade=t=in:st=0:d=${fade}`, `afade=t=out:st=${spec.duration-fade}:d=${fade}`)
  const cues = spec.narrationCues || []
  const speech = cues.map(c => `gte(t,${c.start})*lt(t,${c.end})`).join('+')
  filters.push(spec.duckMusic && speech ? `volume='${spec.musicVolume}*if(gt(${speech},0),0.25,1)':eval=frame` : `volume=${spec.musicVolume}`)
  return filters.join(',')
}
