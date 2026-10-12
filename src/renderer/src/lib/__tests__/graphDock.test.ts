import { describe, it, expect } from 'vitest'
import type { DockAction, DockState } from '../graphDock'
import {
  DOCK_AUTO_CLOSE_MS, DOCK_COLLAPSED_PX, DOCK_MIN_PX, clampDockHeight, dockHeight, dockReducer, initialDock,
} from '../graphDock'

const run = (...actions: DockAction[]): DockState => actions.reduce(dockReducer, initialDock())
const approvals = (count: number, now = 0): DockAction => ({ type: 'approvals', count, now })

describe('graphDock', () => {
  it('starts collapsed; the first approvals auto-open it once, on Needs you, and announce it', () => {
    expect(initialDock().mode).toBe('collapsed')
    const auto = run(approvals(3))
    expect(auto).toMatchObject({ mode: 'auto', tab: 'needs', touched: false, announce: '3 approvals need you' })
    expect(run(approvals(1)).announce).toBe('1 approval needs you')
    const open = run({ type: 'tab', tab: 'log' }, approvals(3)) // already open: approvals change neither mode nor tab
    expect(open).toMatchObject({ mode: 'peek', tab: 'log' })
  })

  it('opens once per batch: more calls in the same batch do not re-open it after the user collapses it', () => {
    let s = run(approvals(2), { type: 'toggle' })
    expect(s.mode).toBe('collapsed')
    s = [approvals(5), approvals(1), approvals(4)].reduce(dockReducer, s)
    expect(s.mode).toBe('collapsed') // still the same batch (the queue never emptied): stays collapsed, the bar shows the count
    expect(s.waiting).toBe(4)
    s = [approvals(0, 100), approvals(2, 200)].reduce(dockReducer, s)
    expect(s.mode).toBe('auto') // a new batch re-opens it
  })

  it('auto-closes DOCK_AUTO_CLOSE_MS after the queue empties, only if untouched', () => {
    let s = run(approvals(2, 0), approvals(0, 1000))
    expect(s.closeAt).toBe(1000 + DOCK_AUTO_CLOSE_MS)
    expect(dockReducer(s, { type: 'tick', now: 2999 }).mode).toBe('auto')
    expect(dockReducer(s, { type: 'tick', now: 3000 }).mode).toBe('collapsed')
    // a call arriving before the deadline cancels it
    expect(dockReducer(s, approvals(1, 2000)).closeAt).toBeNull()
    // touched: never auto-closes
    s = run(approvals(2, 0), { type: 'touch' }, approvals(0, 1000))
    expect(s.closeAt).toBeNull()
    expect(dockReducer(s, { type: 'tick', now: 99_999 }).mode).toBe('auto')
    s = run(approvals(2, 0), approvals(0, 1000), { type: 'tab', tab: 'log' })
    expect(dockReducer(s, { type: 'tick', now: 99_999 }).mode).toBe('auto')
  })

  it('a pinned dock never auto-closes and approvals never change it', () => {
    let s = run({ type: 'toggle' }, { type: 'pin', fraction: 0.45 })
    expect(s).toMatchObject({ mode: 'pinned', pinnedFraction: 0.45 })
    s = [approvals(3, 0), approvals(0, 10), { type: 'tick', now: 1e9 } as DockAction].reduce(dockReducer, s)
    expect(s.mode).toBe('pinned')
    expect(run(approvals(1), { type: 'resize', fraction: 0.5 })).toMatchObject({ mode: 'pinned', pinnedFraction: 0.5 })
    expect(dockReducer(s, { type: 'pin', fraction: 0.45 }).mode).toBe('peek') // unpin keeps it open
  })

  it('selecting a node opens a peek on the Node tab; Esc / empty canvas close only a peek opened that way', () => {
    const s = run({ type: 'select', hasApprovals: true })
    expect(s).toMatchObject({ mode: 'peek', tab: 'node', peekFromSelect: true })
    expect(dockReducer(s, { type: 'dismiss' }).mode).toBe('collapsed')
    const user = run({ type: 'toggle' })
    expect(user.peekFromSelect).toBe(false)
    expect(dockReducer(user, { type: 'dismiss' }).mode).toBe('peek')
    const auto = run(approvals(2), { type: 'select', hasApprovals: false })
    expect(auto).toMatchObject({ mode: 'auto', tab: 'node' })
    expect(dockReducer(auto, { type: 'dismiss' }).mode).toBe('auto')
    expect(run(approvals(2), { type: 'select', hasApprovals: true }).tab).toBe('needs')
  })

  it('the Run log never opens by itself; Cmd+J toggles; a chip opens straight to its tab', () => {
    const s = run(approvals(1), { type: 'toggle' }, approvals(0, 0), { type: 'tick', now: 1e9 })
    expect(s.mode).toBe('collapsed')
    expect(run({ type: 'toggle' }).mode).toBe('peek')
    expect(run({ type: 'toggle' }, { type: 'toggle' }).mode).toBe('collapsed')
    expect(run({ type: 'tab', tab: 'log' })).toMatchObject({ mode: 'peek', tab: 'log' })
  })

  it('heights: 44px bar, ~38% auto, ~30% peek, the user height pinned; clamped to 240px .. 60% of the pane', () => {
    expect(dockHeight(initialDock(), 900)).toBe(DOCK_COLLAPSED_PX)
    expect(dockHeight(run(approvals(1)), 1000)).toBe(380)
    expect(dockHeight(run({ type: 'toggle' }), 1000)).toBe(300)
    expect(dockHeight(run({ type: 'resize', fraction: 0.45 }), 1000)).toBe(450)
    expect(dockHeight(run({ type: 'resize', fraction: 0.9 }), 1000)).toBe(600)
    expect(dockHeight(run({ type: 'resize', fraction: 0.05 }), 1000)).toBe(DOCK_MIN_PX)
    expect(dockHeight(run({ type: 'toggle' }), 600)).toBe(DOCK_MIN_PX) // 30% of 600 = 180 → the 240 floor
    expect(clampDockHeight(500, 300)).toBe(180) // a very short pane: the 60% cap wins
  })

  it('restores a chat\'s pin and height, keeps the approvals already counted', () => {
    const s = dockReducer(run(approvals(2)), { type: 'restore', saved: { pinned: true, fraction: 0.33 } })
    expect(s).toMatchObject({ mode: 'pinned', pinnedFraction: 0.33, waiting: 2 })
    expect(dockReducer(s, { type: 'restore', saved: null }).mode).toBe('collapsed')
  })

})
