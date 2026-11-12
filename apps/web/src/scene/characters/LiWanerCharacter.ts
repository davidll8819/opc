import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { LiWanerMotionState } from './liWanerMotionState'
import { officeMotionSource, type LibraryVariant } from './officeCharacterLibrary'

const KEY = 'wishtaday.li-waner.motion-preview.v1'
export function readLiWanerPreview() {
  try { return localStorage.getItem(KEY) !== 'original' } catch { return true }
}
export function saveLiWanerPreview(enabled: boolean) {
  try { localStorage.setItem(KEY, enabled ? 'preview' : 'original') } catch { /* Keep session choice. */ }
}
type Frame = { texture: Texture; bottom: number; top: number; width: number }
type Variant = 'classic' | 'compact' | LibraryVariant
type FrameSet = Partial<Record<'sit-back' | 'walk' | 'turn', Frame[]>>
const frameSets: Partial<Record<Variant, FrameSet>> = {}
const loading: Partial<Record<Variant, Promise<boolean>>> = {}
export function liWanerReady(variant: Variant = 'library') {
  const frames = frameSets[variant]
  return Boolean(frames?.['sit-back'] && frames.walk && frames.turn)
}

export function loadLiWanerCharacter(variant: Variant = 'library'): Promise<boolean> {
  if (liWanerReady(variant)) return Promise.resolve(true)
  if (loading[variant]) return loading[variant]!
  loading[variant] = (async () => {
    try {
      const images = new Map<string, Promise<HTMLImageElement>>()
      const loaded = await Promise.all((['sit-back', 'walk', 'turn'] as const).map(async name => {
        const source = officeMotionSource(variant, name)
        if (!images.has(source.url)) images.set(source.url, (async () => {
          const image = new Image()
          image.src = source.url
          await image.decode()
          return image
        })())
        const image = await images.get(source.url)!
        const atlas = Texture.from(image)
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, image.width, image.height).data
        const result = Array.from({ length: 8 }, (_, index) => {
          const x = Math.round(index % 4 * image.width / 4)
          const row = source.firstRow + Math.floor(index / 4)
          const y = Math.round(row * image.height / source.rows)
          const w = Math.round((index % 4 + 1) * image.width / 4) - x
          const h = Math.round((row + 1) * image.height / source.rows) - y
          const visible = (row: number) => {
            let count = 0
            for (let col = x; col < x + w; col++) if (pixels[((y + row) * image.width + col) * 4 + 3] > 220) count++
            return count > 8
          }
          let top = 0, bottom = h - 1
          while (top < h - 1 && !visible(top)) top++
          while (bottom > 0 && !visible(bottom)) bottom--
          return { texture: new Texture({ source: atlas.source, frame: new Rectangle(x, y, w, h) }), top, bottom, width: w }
        })
        return [name, result] as const
      }))
      // Publish a pack only after all three sheets have decoded successfully.
      frameSets[variant] = Object.fromEntries(loaded)
      return true
    } catch {
      console.warn(`[Office] ${variant} 动作素材未加载，保留该员工原版人物。`)
      return false
    } finally { delete loading[variant] }
  })()
  return loading[variant]!
}

export class LiWanerCharacter extends Container {
  readonly motion: LiWanerMotionState
  private sprite: Sprite
  private headY = -55
  private variant: Variant
  constructor(seated: boolean, variant: Variant = 'library') {
    super()
    if (!liWanerReady(variant)) throw new Error('Office character pack is not ready')
    this.variant = variant
    this.motion = new LiWanerMotionState(seated)
    this.sprite = new Sprite(frameSets[variant]!['sit-back']![7].texture)
    this.addChild(this.sprite)
    this.draw()
  }
  update(dt: number, distance: number) { this.motion.update(dt, distance); this.draw() }
  getHeadOffsetY() { return this.headY - 5 }
  private draw() {
    const frames = frameSets[this.variant]!
    const pose = this.motion.pose, frame = frames[pose.sheet]![pose.frame]
    const seated = frames['sit-back']![7]
    // One scale for the entire pack: never enlarge each shorter seated frame.
    const scale = this.variant !== 'classic' ? 58 / (seated.bottom - seated.top) : .2
    const floor = this.variant !== 'classic' ? 6 : 2
    this.sprite.texture = frame.texture
    this.sprite.scale.set(pose.flip ? -scale : scale, scale)
    this.sprite.position.set((pose.flip ? 1 : -1) * frame.width * scale / 2, floor - frame.bottom * scale)
    this.headY = floor - (frame.bottom - frame.top) * scale
  }
}
