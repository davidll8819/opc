import { sample, nextFrameTime, STEPS, DURATION } from './motion.mjs'

const $ = id => document.getElementById(id)
const canvas = $('stage'), ctx = canvas.getContext('2d')
const sheets = {}, metadata = {}
let time = 0, last = 0, playing = !matchMedia('(prefers-reduced-motion: reduce)').matches
let mode = 'cycle', speed = 1, ready = false, previousLabel = ''
const ground = 270, scale = 0.58
canvas.width=1920;canvas.height=640;ctx.scale(2,2)
const duration = () => mode === 'walk' ? 1 : mode === 'turn' ? 2 : DURATION
$('seek').max = String(DURATION - .01)
for (const [index, step] of STEPS.entries()) {
  const item = document.createElement('li')
  item.textContent = `${index + 1} ${step.label}`
  item.dataset.phase = step.id
  $('steps').append(item)
}

async function load(name) {
  const image = new Image()
  image.src = `./${name}.png`
  await image.decode()
  sheets[name] = image
  // Only measure alpha bounds; original generated PNGs are retained unmodified.
  // A shared floor eliminates sheet layout margins causing vertical jumps.
  const temp = document.createElement('canvas')
  temp.width = image.width; temp.height = image.height
  const context = temp.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, temp.width, temp.height).data
  metadata[name] = Array.from({length: 8}, (_, i) => {
    const x = Math.round((i % 4) * image.width / 4)
    const y = Math.round(Math.floor(i / 4) * image.height / 2)
    const w = Math.round((i % 4 + 1) * image.width / 4) - x
    const h = Math.round((Math.floor(i / 4) + 1) * image.height / 2) - y
    let bottom = h - 1
    for (; bottom > 0; bottom--) {
      let count = 0
      for (let xx = x; xx < x + w; xx++) if (pixels[((y + bottom) * image.width + xx) * 4 + 3] > 220) count++
      if (count > 8) break
    }
    return { x, y, w, h, bottom }
  })
}

function character(context, sheet, frame, x, y, ratio, flip = false) {
  const item = metadata[sheet][frame]
  context.save(); context.translate(x, y); if (flip) context.scale(-1, 1)
  context.drawImage(sheets[sheet], item.x, item.y, item.w, item.h,
    -item.w * ratio / 2, -item.bottom * ratio, item.w * ratio, item.h * ratio)
  context.restore()
}

function chair(context, x, floor, size = 1) {
  context.save(); context.translate(x, floor); context.scale(size, size)
  context.fillStyle = '#8c9287'
  context.beginPath(); context.roundRect(-46, -132, 14, 72, 7); context.fill()
  context.fillStyle = '#a4aa9d'; context.beginPath(); context.roundRect(-43, -62, 65, 12, 5); context.fill()
  context.strokeStyle = '#777e74'; context.lineWidth = 5
  context.beginPath(); context.moveTo(-12,-50); context.lineTo(-12,-9); context.moveTo(-40,-4); context.lineTo(-12,-10); context.lineTo(18,-4); context.stroke()
  context.fillStyle = '#535a54'
  for (const wheelX of [-40,18]) { context.beginPath(); context.arc(wheelX,-3,4,0,Math.PI*2); context.fill() }
  context.restore()
}

function render() {
  if (!ready) return
  const pose = sample(time, mode)
  ctx.clearRect(0,0,960,320)
  ctx.fillStyle='#fffdf9';ctx.fillRect(0,0,960,320)
  ctx.fillStyle='#efebe4';ctx.fillRect(0,ground+1,960,320-ground)
  ctx.strokeStyle='#ddd6ce';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(40,ground+1);ctx.lineTo(920,ground+1);ctx.stroke()
  if (mode === 'cycle' || mode === 'sit') chair(ctx,235,ground,scale/.52)
  ctx.fillStyle='#77716b';ctx.font='13px system-ui';ctx.fillText('工位',215,ground+32)
  ctx.fillText('交流区',620,ground+32)
  // Actual pose frames drive knees/ankles; translation alone is never used as walking.
  character(ctx,pose.sheet,pose.frame,pose.x,ground,scale,pose.flip)
  if (previousLabel !== pose.label) {
    $('phase').textContent=pose.label; previousLabel=pose.label
    for (const item of $('steps').children) {
      if (item.dataset.phase === pose.phase) item.setAttribute('aria-current','step')
      else item.removeAttribute('aria-current')
    }
  }
  $('frame').textContent=`${pose.sheet === 'walk' ? '行走' : pose.sheet === 'turn' ? '转身' : '落座'}画面 ${pose.frame + 1} / 8`
  $('seek').value=String(time % duration())
  $('time').textContent=`${(time % duration()).toFixed(1)} 秒`
}

function syncPlay() { $('play').textContent=playing?'暂停':'播放'; $('play').setAttribute('aria-pressed',String(playing)) }
function tick(stamp) {
  if (last && playing && !document.hidden) time += Math.min((stamp-last)/1000, .1)*speed
  last=stamp;render();requestAnimationFrame(tick)
}
document.addEventListener('visibilitychange',()=>{last=0})
$('play').addEventListener('click',()=>{playing=!playing;syncPlay()})
$('restart').addEventListener('click',()=>{time=0;playing=true;syncPlay();render()})
$('next').addEventListener('click',()=>{playing=false;time=nextFrameTime(time,mode);syncPlay();render()})
$('mode').addEventListener('change',event=>{
  mode=event.target.value;time=0
  $('seek').max=String(duration()-.01)
  $('seek').disabled=mode==='sit';$('next').disabled=mode==='sit'
  render()
})
$('speed').addEventListener('change',event=>{speed=Number(event.target.value)})
$('seek').addEventListener('input',event=>{playing=false;time=Number(event.target.value);syncPlay();render()})

try {
  await Promise.all(['walk','sit','turn'].map(load));ready=true
  for (const id of ['play','restart','next']) $(id).disabled=false
  for (const [id,sheet,frame] of [['pose-standing','sit',0],['pose-seated','sit',7],['pose-walking','walk',3]]) {
    const small=$(id).getContext('2d')
    if (id==='pose-seated') chair(small,150,220,.46/.52)
    character(small,sheet,frame,150,220,.46)
  }
  syncPlay();render();requestAnimationFrame(tick)
} catch {
  $('phase').textContent='动作素材未能加载'
  $('error').hidden=false
  $('error').textContent='图片加载失败，请刷新本页重试。原办公室不受影响。'
}
