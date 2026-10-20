// Rectification R4: the multi-agent overlay layers in one place, lowest first. Each overlay takes its z-index from here
// and marks its root with data-layer, so keyboard handling (Escape, the focus view's Tab trap) and outside clicks act
// on the topmost open layer only.
export const Z_LAYERS = {
  /** The agents dock when it overlays the chat (Sidebar). */
  dock: 45,
  /** The agent focus view (AgentFocusView), a modal over the app. */
  agentFocus: 70,
  /** The claims and evidence drawer; opened from the focus view, so above it. */
  claimsDrawer: 80,
  /** Tool approvals shown as a modal (Layout), which must never be hidden. */
  approvals: 90,
  /** Hover cards (the top bar's mode pill card). */
  popover: 100,
} as const

export type Layer = keyof typeof Z_LAYERS

/** Root-element props for an overlay on `layer`. */
export function layerProps(layer: Layer): { 'data-layer': Layer; style: { zIndex: number } } {
  return { 'data-layer': layer, style: { zIndex: Z_LAYERS[layer] } }
}

/** Whether an open overlay sits above `layer` (it then owns Escape and outside clicks). Hover cards are transient and
 *  close themselves, so they do not count. */
export function coveredAbove(layer: Layer): boolean {
  return [...document.querySelectorAll<HTMLElement>('[data-layer]')]
    .some((el) => el.dataset.layer !== 'popover' && (Z_LAYERS[el.dataset.layer as Layer] ?? 0) > Z_LAYERS[layer])
}
