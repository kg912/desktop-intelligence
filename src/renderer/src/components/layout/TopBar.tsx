import { useState } from 'react'
import { motion } from 'framer-motion'
import { Zap } from 'lucide-react'
import { useModelStore } from '../../store/ModelStore'

/**
 * TopBar — centre model name + right-side context utilisation indicator + Compact button.
 *
 * The context bar is invisible until the first completed response populates
 * contextUsage in ModelStore. After that it stays visible and updates on
 * every subsequent response. Cleared when the user starts a new chat.
 *
 * The Compact button appears alongside the context bar and is disabled
 * until contextUsage.used >= 5000 tokens.
 */

interface TopBarProps {
  activeChatId:      string | null
  onCompactComplete: () => void
}

export function TopBar({ activeChatId, onCompactComplete }: TopBarProps) {
  const {
    selectedModel,
    contextUsage,
    isCompacting,
    setIsCompacting,
    setCompactToast,
  } = useModelStore()
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

  const canCompact = !!contextUsage && contextUsage.used >= 5000 && !isCompacting

  async function handleCompact() {
    if (!activeChatId || !contextUsage || contextUsage.used < 5000 || isCompacting) return
    setIsCompacting(true)
    try {
      const result = await window.api.compactChat({ chatId: activeChatId, model: selectedModel })
      setCompactToast({ tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter })
      onCompactComplete()
      setTimeout(() => setCompactToast(null), 5000)
    } catch (err) {
      console.error('[Compact] failed:', err)
    } finally {
      setIsCompacting(false)
    }
  }

  return (
    <div className="drag-region flex-shrink-0 flex items-center justify-between
                    px-8 h-[52px] border-b border-surface-border/50 relative">

      {/* Left: model name — left-aligned */}
      <div className="no-drag flex items-center gap-1.5">
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

      {/* Right: context bar then Compact button */}
      <div className="no-drag flex items-center gap-3">
        {contextUsage && (
          <>
            {/* Progress bar with tooltip — bar comes first */}
            <div
              className="relative cursor-default"
              style={{ padding: '12px 4px', margin: '-12px -4px' }}
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
            >
              <div className="w-32 h-1.5 rounded-full bg-surface-border/40 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${barColour}`}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {showTooltip && (
                <div className="absolute right-0 top-5 z-50 min-w-[210px]
                                rounded-xl border border-surface-border
                                bg-surface-elevated/95 backdrop-blur-sm
                                px-3.5 py-2.5 shadow-xl">
                  <p className="text-[11px] font-medium text-content-primary mb-2 whitespace-nowrap">
                    Context Utilization
                  </p>
                  <div className="w-full h-1 rounded-full bg-surface-border/40 overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full ${barColour}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-content-secondary whitespace-nowrap">
                    Used:{' '}
                    <span className="text-content-primary font-medium">
                      {contextUsage.used.toLocaleString()}
                    </span>{' '}
                    tokens ({pct}%)
                  </p>
                  <p className="text-[11px] text-content-secondary whitespace-nowrap">
                    Length:{' '}
                    <span className="text-content-primary font-medium">
                      {contextUsage.total.toLocaleString()}
                    </span>{' '}
                    tokens (Max)
                  </p>
                </div>
              )}
            </div>

            {/* Compact button — no-drag applied directly so Electron pointer events work */}
            <button
              onClick={handleCompact}
              disabled={!canCompact}
              className={
                canCompact
                  ? 'no-drag cursor-pointer bg-accent-900 hover:bg-accent-800 text-white text-xs font-medium px-3 py-1 rounded-md border border-accent-700 transition-all'
                  : 'no-drag cursor-not-allowed bg-accent-900/30 text-white/40 text-xs font-medium px-3 py-1 rounded-md border border-accent-700/30 opacity-50'
              }
              title={canCompact ? 'Summarise conversation to free context' : 'Need ≥ 5,000 tokens used to compact'}
            >
              Compact
            </button>
          </>
        )}
      </div>
    </div>
  )
}
