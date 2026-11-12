import { Assets, Rectangle, Texture } from 'pixi.js'

export type CharacterStyle = 'original' | 'illustrated'
const STORAGE_KEY = 'wishtaday.office.character-style.v1'
// Explicit IDs: rearranging desks or renaming an employee must not change their face.
const ATLAS_IDS = [
  'marvis', 'code-agent', 'file-agent',
  'app-agent', 'review-agent', 'data-agent',
  'new-agent-7', 'new-agent-8', 'new-agent-9',
] as const
const textures = new Map<string, Texture>()
let loading: Promise<boolean> | undefined

export function readCharacterStyle(): CharacterStyle {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'original' ? 'original' : 'illustrated'
  } catch { return 'illustrated' }
}

export function saveCharacterStyle(style: CharacterStyle) {
  try { localStorage.setItem(STORAGE_KEY, style) } catch { /* Session choice still works. */ }
}

export function illustratedTexture(id: string) { return textures.get(id) }

export function loadIllustratedCharacters(): Promise<boolean> {
  if (textures.size === ATLAS_IDS.length) return Promise.resolve(true)
  if (!loading) loading = (async () => {
    try {
      const atlas = await Assets.load<Texture>('/assets/characters/illustrated-v1/roster.png')
      const cellWidth = atlas.width / 3, cellHeight = atlas.height / 3
      for (const [index, id] of ATLAS_IDS.entries()) {
        textures.set(id, new Texture({ source: atlas.source, frame: new Rectangle(
          (index % 3) * cellWidth, Math.floor(index / 3) * cellHeight, cellWidth, cellHeight,
        ) }))
      }
      return true
    } catch {
      console.warn('[Office] 新版形象未加载，保留原版人物。')
      return false
    } finally { loading = undefined }
  })()
  return loading
}
