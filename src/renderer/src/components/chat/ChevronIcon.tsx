/**
 * ChevronIcon
 *
 * Single source of truth for the collapse/expand chevron used throughout
 * the chat UI. Replaces the raw › character which renders inconsistently
 * across fonts and sizes.
 *
 * Usage:
 *   <ChevronIcon open={isExpanded} className="text-white/20" />
 *
 * open=false → points right (collapsed)
 * open=true  → points down (expanded) via 90deg rotation
 */
export function ChevronIcon({
  open = false,
  size = 12,
  className = '',
}: {
  open?: boolean
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5L8 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
