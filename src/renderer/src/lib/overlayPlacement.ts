// Viewport collision handling for popovers anchored to a trigger (designs/02-overlay-clamp.png).

export const OVERLAY_GUTTER = 12

export interface OverlayPlacement {
  /** Viewport x of the overlay's left edge. */
  left: number
  width: number
  /** x of the arrow inside the overlay, kept off the rounded corners. */
  arrowX: number
}

/**
 * Anchor to the trigger's left edge, or its right edge when the trigger sits in the right half of the
 * viewport; then shift by any overflow so a `gutter` stays free on both sides. Width never exceeds
 * `viewportWidth - 2 * gutter`.
 */
export function placeOverlay(
  anchor: { left: number; width: number },
  preferredWidth: number,
  viewportWidth: number,
  gutter = OVERLAY_GUTTER,
): OverlayPlacement {
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - 2 * gutter))
  const center = anchor.left + anchor.width / 2
  const start = center > viewportWidth / 2 ? anchor.left + anchor.width - width : anchor.left
  const left = Math.max(gutter, Math.min(start, viewportWidth - gutter - width))
  const arrowX = Math.max(16, Math.min(center - left, width - 16))
  return { left, width, arrowX }
}
