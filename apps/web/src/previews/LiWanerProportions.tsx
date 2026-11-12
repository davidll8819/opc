import { useEffect, useRef, useState } from 'react'
import 'pixi.js/unsafe-eval'
import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { SpineCharacter } from '@/scene/characters/SpineCharacter'
import { LiWanerCharacter, loadLiWanerCharacter } from '@/scene/characters/LiWanerCharacter'
import { loadSpineAssets } from '@/scene/assets/loadSpineAssets'
import { loadOfficeAssets } from '@/scene/assets/loadOfficeAssets'
import { DeskEntity } from '@/scene/entities/DeskEntity'
import './li-waner-proportions.css'

async function newProportionTexture() {
  const image = new Image()
  image.src = '/previews/li-waner-proportions/seated-back.png'
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, image.width, image.height).data
  let minX = image.width, minY = image.height, maxX = 0, maxY = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (data[(y * image.width + x) * 4 + 3] < 220) continue
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  }
  const atlas = Texture.from(image)
  return new Texture({ source: atlas.source, frame: new Rectangle(minX, minY, maxX-minX+1, maxY-minY+1) })
}

export default function LiWanerProportions() {
  const host = useRef<HTMLDivElement>(null)
  const groups = useRef<Container[]>([])
  const [zoom, setZoom] = useState(2)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    for (const group of groups.current) group.scale.set(zoom)
  }, [zoom, ready])
  useEffect(() => {
    let disposed = false
    let initialized = false
    const app = new Application()
    const mount = host.current!
    async function start() {
      await app.init({ width: 960, height: 300, backgroundColor: 0xf4f0e9, antialias: true, resolution: Math.min(devicePixelRatio || 1, 2), autoDensity: true, preference: 'webgl' })
      initialized = true
      if (disposed) { app.destroy(true, { children: true }); return }
      mount.appendChild(app.canvas)
      const [spineReady, furnitureReady, currentReady, texture] = await Promise.all([
        loadSpineAssets(), loadOfficeAssets(), loadLiWanerCharacter('classic'), newProportionTexture(),
      ])
      if (disposed) return
      if (!spineReady || !furnitureReady || !currentReady) throw new Error('人物或工位素材未加载，请刷新重试。')
      const original = new SpineCharacter('marvis', 0xe85d4a)
      original.setViewFacing('back'); original.playState('working')
      for (let i = 0; i < 30; i++) original.update(1/60)
      const current = new LiWanerCharacter(true, 'classic')
      const compact = new Sprite(texture)
      compact.anchor.set(.5, 1)
      // Compact legs need a lower foot baseline to keep the hips on the same seat.
      compact.scale.set(58 / texture.height)
      compact.y = 6
      const actors = [original, current, compact]
      groups.current = actors.map((actor, index) => {
        const group = new Container()
        group.sortableChildren = true
        group.position.set(160 + index * 320, 205)
        const desk = new DeskEntity({ id: `comparison-${index}`, x: 0, y: -45, seatX: 0, seatY: 0 })
        desk.updateDepthZ([{ x: 0, y: 0 }])
        actor.zIndex = 0
        group.addChild(desk.shadowGfx, desk.deskLayer, actor, desk.chairLayer)
        app.stage.addChild(group)
        return group
      })
      setReady(true)
    }
    void start().catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '预览加载失败，请刷新重试。') })
    return () => {
      disposed = true; groups.current = []
      if (initialized) app.destroy(true, { children: true })
    }
  }, [])
  return <main className="proportion-review">
    <header><a href="/">◈ Wishtaday</a><span>李婉儿 · 静态比例样板</span></header>
    <section className="proportion-intro"><h1>让人物更适合这个办公室</h1><p>同一套桌椅、相同场景缩放。先比较背面坐姿与头身比例，再制作动作。</p></section>
    <div className="proportion-controls"><span>查看尺寸</span>
      <button onClick={() => setZoom(1)} aria-pressed={zoom === 1}>场景尺寸</button>
      <button onClick={() => setZoom(2)} aria-pressed={zoom === 2}>放大 2 倍</button>
      <span className="proportion-scope">独立比例对比 · 不改变设置</span>
    </div>
    {error && <p role="alert">{error}</p>}
    <section className="proportion-comparison" aria-label="三个版本的同工位对比">
      <div ref={host} className="proportion-canvas" aria-label="原版、当前插画与新比例坐姿画面" />
      {!ready && !error && <p role="status">正在加载人物和现有工位…</p>}
      <div className="proportion-labels">
        <div><h2>原版动画角色</h2><p>现有角色与原动作姿势</p></div>
        <div><h2>上一版插画</h2><p>比例修长，细节偏多</p></div>
        <div><h2>新比例样板</h2><p>放大头部，缩短身体与腿</p></div>
      </div>
    </section>
    <section className="proportion-notes"><h2>这次只确认三件事</h2><ul><li>缩小后能否看清发型和人物轮廓。</li><li>头、身体与椅背的大小是否协调。</li><li>珊瑚色西装是否能让李婉儿容易辨认。</li></ul><p>本页仅展示静态比例；办公室已另接入新比例动作试用。这页不读取企业数据、不调用模型，也不会保存或替换员工配置。</p></section>
  </main>
}
