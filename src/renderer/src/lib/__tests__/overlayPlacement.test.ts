import { describe, it, expect } from 'vitest'
import { placeOverlay } from '../overlayPlacement'

const pill = (left: number) => ({ left, width: 180 })

describe('placeOverlay', () => {
  it('left half: anchors to the pill\'s left edge', () => {
    expect(placeOverlay(pill(300), 520, 1440)).toEqual({ left: 300, width: 520, arrowX: 90 })
  })
  it('right half: flips to right-align with the pill', () => {
    expect(placeOverlay(pill(1000), 520, 1440)).toEqual({ left: 660, width: 520, arrowX: 430 })
  })
  it('shifts left by the overflow, keeping a 12px gutter', () => {
    // Left half (centre 410 < 450), but anchored at 400 the card would end at 920 > 900 − 12: shifted left by 32.
    expect(placeOverlay({ left: 400, width: 20 }, 520, 900)).toEqual({ left: 368, width: 520, arrowX: 42 })
  })
  it('never starts before the left gutter', () => {
    expect(placeOverlay({ left: 0, width: 40 }, 520, 900).left).toBe(12)
  })
  it('narrow viewport: width is capped at 100vw − 24px and the card fills the gutters', () => {
    expect(placeOverlay(pill(100), 520, 400)).toEqual({ left: 12, width: 376, arrowX: 178 })
  })
  it('stays inside the viewport for every window width 900–2560 and every pill position', () => {
    for (let vw = 900; vw <= 2560; vw += 20) {
      for (let x = 0; x <= vw - 180; x += 37) {
        const p = placeOverlay(pill(x), 520, vw)
        expect(p.left).toBeGreaterThanOrEqual(12)
        expect(p.left + p.width).toBeLessThanOrEqual(vw - 12)
        expect(p.arrowX).toBeGreaterThanOrEqual(16)
        expect(p.arrowX).toBeLessThanOrEqual(p.width - 16)
      }
    }
  })
})
