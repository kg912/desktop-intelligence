import { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap } from 'lucide-react'
import { useModelStore } from '../../store/ModelStore'

/**
 * TopBar — centre model name + right-side context utilisation indicator.
 *
 * The context bar is invisible until the first completed response populates
 * contextUsage in ModelStore. After that it stays visible and updates on
 * every subsequent response. Cleared when the user starts a new chat.
 */
export function TopBar() {
  const { selectedModel, contextUsage } = useModelStore()
  const [showTooltip, setShowTooltip] = useState(false)

  const pct = contextUsage
    ? Math.min(100, Math.round((contextUsage.used / contextUsage.total) * 100))
    : 0

  // Colour shifts from muted → amber → red as context fills
  const barColour = pct >= 90
    ? 'bg-red-700/70'
    : pct >= 70
    ? 'bg-amber-700/60'
    : 'bg-accent-800/60'

  return (
    <div className="drag-region flex-shrink-0 flex items-center justify-between
                    px-4 h-[52px] border-b border-surface-border/50 relative">

      {/* Left spacer — mirrors right side width to keep model name centred */}
      <div className="w-32" />

      {/* Centre: model name */}
      <div className="no-drag flex items-center gap-2">
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-1.5"
        >
          <Zap className="w-3 h-3 text-accent-500" />
          <span className="text-[12px] font-mono text-content-tertiary tracking-wide truncate max-w-[360px]">
            {selectedModel}
          </span>
        </motion.div>
      </div>

      {/* Right: context utilisation bar (hidden until first response) */}
      <div className="no-drag w-32 flex items-center justify-end">
        {contextUsage && (
          <div
            className="relative"
            onMouseEnter={() => setShowTooltip(true)}
            onMouseLeave={() => setShowTooltip(false)}
          >
            {/* Progress bar track */}
            <div className="w-28 h-1.5 rounded-full bg-surface-border/40 overflow-hidden cursor-default">
              <div
                className={`h-full rounded-full transition-all duration-500 ${barColour}`}
                style={{ width: `${pct}%` }}
              />
            </div>

            {/* Tooltip */}
            {showTooltip && (
              <div className="absolute right-0 top-5 z-50 min-w-[180px]
                              rounded-xl border border-surface-border
                              bg-surface-elevated/95 backdrop-blur-sm
                              px-3.5 py-2.5 shadow-xl">
                <p className="text-[11px] font-medium text-content-primary mb-2">
                  Context Utilization
                </p>
                {/* Mini bar inside tooltip */}
                <div className="w-full h-1 rounded-full bg-surface-border/40 overflow-hidden mb-2">
                  <div
                    className={`h-full rounded-full ${barColour}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-[11px] text-content-secondary">
                  Used:{' '}
                  <span className="text-content-primary font-medium">
                    {contextUsage.used.toLocaleString()}
                  </span>{' '}
                  tokens ({pct}%)
                </p>
                <p className="text-[11px] text-content-secondary">
                  Length:{' '}
                  <span className="text-content-primary font-medium">
                    {contextUsage.total.toLocaleString()}
                  </span>{' '}
                  tokens (Max)
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
