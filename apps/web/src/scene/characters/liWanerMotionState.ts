export class LiWanerMotionState {
  seated: number
  private wantsSeat: boolean
  private walking = false
  // Turn atlas: right=0, front=2, left=4, back=6. The desk faces back.
  private direction: number
  private targetDirection: number
  private turn = 0
  private distance = 0

  constructor(seated: boolean) {
    this.seated = seated ? 1 : 0
    this.wantsSeat = seated
    this.direction = this.targetDirection = seated ? 6 : 0
  }

  sync(seated: boolean, walking: boolean, left: boolean) {
    this.wantsSeat = seated
    this.walking = walking
    this.targetDirection = seated ? 6 : left ? 4 : 0
  }

  get holdsMovement() {
    return this.walking && (this.seated > 0 || this.direction !== this.targetDirection)
  }

  update(dt: number, distance: number) {
    const delta = Math.max(0, Math.min(dt, .05))
    if (!this.wantsSeat && this.seated > 0) {
      this.seated = Math.max(0, this.seated - delta / .8)
      return
    }
    if (this.direction !== this.targetDirection && this.seated === 0) {
      this.turn += delta
      if (this.turn >= .1) {
        const clockwise = (this.targetDirection - this.direction + 8) % 8
        this.direction = (this.direction + (clockwise <= 4 ? 1 : -1) + 8) % 8
        this.turn -= .1
        if (this.direction === this.targetDirection) this.turn = 0
      }
      return
    }
    if (this.wantsSeat) this.seated = Math.min(1, this.seated + delta / .8)
    if (this.walking) this.distance += Math.max(0, distance)
  }

  get pose(): { sheet: 'sit-back' | 'walk' | 'turn'; frame: number; flip: boolean } {
    if (this.seated > 0) return { sheet: 'sit-back', frame: Math.min(7, Math.floor(this.seated * 8)), flip: false }
    if (this.direction !== this.targetDirection) return { sheet: 'turn', frame: this.direction, flip: false }
    if (this.walking) return { sheet: 'walk', frame: Math.floor(this.distance / 9) % 8, flip: this.direction === 4 }
    return { sheet: 'turn', frame: this.direction, flip: false }
  }
}
