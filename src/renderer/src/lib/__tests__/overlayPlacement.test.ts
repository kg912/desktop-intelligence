import { describe, it, expect } from 'vitest'
import { placeOverlay, placeTooltip } from '../overlayPlacement'

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

// Rectification R1: the Gantt tooltip sits next to its segment, inside the Gantt container.
describe('placeTooltip', () => {
  const box = { width: 800, height: 500 }
  const tip = { width: 300, height: 100 }
  it('above the segment when it fits, left-aligned with it', () => {
    expect(placeTooltip({ left: 100, top: 300, width: 40, height: 18 }, tip, box)).toEqual({ left: 100, top: 194, below: false })
  })
  it('flips below when it would clip at the top', () => {
    expect(placeTooltip({ left: 100, top: 50, width: 40, height: 18 }, tip, box)).toEqual({ left: 100, top: 74, below: true })
  })
  it('clamps inside the right edge (right half: right-aligned with the segment, then shifted in)', () => {
    const p = placeTooltip({ left: 760, top: 300, width: 40, height: 18 }, tip, box)
    expect(p.left + tip.width).toBeLessThanOrEqual(box.width - 8)
  })
  it('never clips at the bottom', () => {
    const p = placeTooltip({ left: 100, top: 20, width: 40, height: 18 }, tip, { width: 800, height: 120 })
    expect(p.top + tip.height).toBeLessThanOrEqual(120)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })
  it('never overlaps its segment when there is room above or below', () => {
    for (const top of [0, 40, 120, 250, 380, 482]) {
      const a = { left: 200, top, width: 60, height: 18 }
      const p = placeTooltip(a, tip, box)
      const overlaps = p.top < a.top + a.height && p.top + tip.height > a.top
      expect(overlaps).toBe(false)
    }
  })
})
