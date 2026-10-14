// The Graph view's bottom dock (UI Goal 7, designs/08–10): a pure state machine over
// collapsed | auto | peek | pinned. GraphView only renders it and feeds it events.
//
// A "batch" of approvals starts when calls arrive into an empty queue. The dock auto-opens at
// most once per batch, so collapsing it while calls wait keeps it collapsed until the queue
// has emptied and a new batch arrives.

export type DockMode = 'collapsed' | 'auto' | 'peek' | 'pinned'
export type DockTab = 'needs' | 'node' | 'assess' | 'log'

export interface DockState {
  mode: DockMode
  tab: DockTab
  /** The user's own height (pinned), as a fraction of the pane. */
  pinnedFraction: number
  /** Calls waiting on the user, as last reported. */
  waiting: number
  batch: number
  /** The last batch that has had its one auto-open (or arrived while the dock was already open). */
  openedBatch: number
  /** The user interacted with the dock since it auto-opened: it no longer auto-closes. */
  touched: boolean
  /** When an untouched auto-opened dock closes (the queue emptied), else null. */
  closeAt: number | null
  /** Opened as a peek by selecting a node: Esc or a click on empty canvas closes it. */
  peekFromSelect: boolean
  /** Text for the aria-live region, set once per auto-open. */
  announce: string
}

export type DockAction =
  | { type: 'approvals'; count: number; now: number }
  | { type: 'tick'; now: number }
  /** Cmd+J, the expand button and the collapse chevron. */
  | { type: 'toggle' }
  /** Pin at the dock's current height (fraction of the pane), or unpin. */
  | { type: 'pin'; fraction: number }
  /** Drag or arrow keys on the handle: pins at that height. */
  | { type: 'resize'; fraction: number }
  | { type: 'select'; hasApprovals: boolean }
  /** Esc, or a click on empty canvas. */
  | { type: 'dismiss' }
  | { type: 'tab'; tab: DockTab }
  | { type: 'touch' }
  /** Another chat: its saved pin and height (the approvals already counted stay). */
  | { type: 'restore'; saved: SavedDock | null }

export const DOCK_COLLAPSED_PX = 44
export const DOCK_MIN_PX = 240
export const DOCK_MAX_FRACTION = 0.6
export const DOCK_AUTO_FRACTION = 0.38
export const DOCK_PEEK_FRACTION = 0.3
export const DOCK_DEFAULT_PIN_FRACTION = 0.4
export const DOCK_AUTO_CLOSE_MS = 2000

export interface SavedDock { pinned: boolean; fraction: number }

export function initialDock(saved: SavedDock | null = null): DockState {
  return {
    mode: saved?.pinned ? 'pinned' : 'collapsed', tab: 'needs', pinnedFraction: saved?.fraction ?? DOCK_DEFAULT_PIN_FRACTION,
    waiting: 0, batch: 0, openedBatch: 0, touched: false, closeAt: null, peekFromSelect: false, announce: '',
  }
}

const touch = (s: DockState): DockState => ({ ...s, touched: true, closeAt: null })

export function dockReducer(s: DockState, a: DockAction): DockState {
  switch (a.type) {
    case 'approvals': {
      if (a.count === s.waiting) return s
      if (a.count === 0) {
        const closeAt = s.mode === 'auto' && !s.touched ? a.now + DOCK_AUTO_CLOSE_MS : null
        return { ...s, waiting: 0, closeAt }
      }
      const batch = s.waiting === 0 ? s.batch + 1 : s.batch
      const next = { ...s, waiting: a.count, batch, closeAt: null }
      if (batch <= s.openedBatch) return next
      if (s.mode !== 'collapsed') return { ...next, openedBatch: batch }
      return {
        ...next, openedBatch: batch, mode: 'auto', tab: 'needs', touched: false, peekFromSelect: false,
        announce: `${a.count} approval${a.count === 1 ? '' : 's'} need${a.count === 1 ? 's' : ''} you`,
      }
    }
    case 'tick':
      if (s.closeAt === null || a.now < s.closeAt) return s
      return s.mode === 'auto' && !s.touched && s.waiting === 0 ? { ...s, mode: 'collapsed', closeAt: null } : { ...s, closeAt: null }
    case 'toggle':
      if (s.mode === 'collapsed') return { ...touch(s), mode: 'peek', peekFromSelect: false, tab: s.waiting > 0 ? 'needs' : s.tab }
      return { ...s, mode: 'collapsed', closeAt: null, peekFromSelect: false }
    case 'pin':
      return s.mode === 'pinned' ? { ...touch(s), mode: 'peek', peekFromSelect: false } : { ...touch(s), mode: 'pinned', pinnedFraction: a.fraction, peekFromSelect: false }
    case 'resize':
      return { ...touch(s), mode: 'pinned', pinnedFraction: a.fraction, peekFromSelect: false }
    case 'select':
      if (s.mode === 'collapsed') return { ...s, mode: 'peek', tab: 'node', peekFromSelect: true }
      return { ...touch(s), tab: a.hasApprovals ? 'needs' : 'node' }
    case 'dismiss':
      return s.mode === 'peek' && s.peekFromSelect ? { ...s, mode: 'collapsed', peekFromSelect: false } : s
    case 'tab':
      return { ...touch(s), tab: a.tab, ...(s.mode === 'collapsed' && { mode: 'peek' as const, peekFromSelect: false }) }
    case 'touch':
      return s.touched && s.closeAt === null ? s : touch(s)
    case 'restore': {
      const fresh = initialDock(a.saved)
      return { ...s, mode: fresh.mode, pinnedFraction: fresh.pinnedFraction, touched: false, closeAt: null, peekFromSelect: false }
    }
  }
}

/** Clamp an open dock's height: at least DOCK_MIN_PX, at most 60% of the pane (the cap wins on a short pane). */
export function clampDockHeight(px: number, paneH: number): number {
  return Math.round(Math.min(paneH * DOCK_MAX_FRACTION, Math.max(DOCK_MIN_PX, px)))
}

/** The dock's height in px for a pane of `paneH` px. */
export function dockHeight(s: DockState, paneH: number): number {
  if (s.mode === 'collapsed') return DOCK_COLLAPSED_PX
  const fraction = s.mode === 'auto' ? DOCK_AUTO_FRACTION : s.mode === 'peek' ? DOCK_PEEK_FRACTION : s.pinnedFraction
  return clampDockHeight(fraction * paneH, paneH)
}

// Per chat, next to the List | Graph choice (di.multiAgentView.<chatId>); a per-viewer convenience.
const dockKey = (chatId: string): string => `di.graphDock.${chatId}`

export function readSavedDock(chatId: string | null | undefined): SavedDock | null {
  if (!chatId) return null
  try {
    const v = JSON.parse(localStorage.getItem(dockKey(chatId)) ?? 'null')
    return v && typeof v.pinned === 'boolean' && typeof v.fraction === 'number' ? { pinned: v.pinned, fraction: v.fraction } : null
  } catch { return null }
}

export function writeSavedDock(chatId: string | null | undefined, saved: SavedDock): void {
  if (!chatId) return
  try { localStorage.setItem(dockKey(chatId), JSON.stringify(saved)) } catch { /* a per-viewer convenience only */ }
}
