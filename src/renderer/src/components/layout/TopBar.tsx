import { motion } from 'framer-motion'
import { Zap } from 'lucide-react'
import { useModelStore } from '../../store/ModelStore'

/**
 * TopBar reads `selectedModel` directly from ModelStore.
 * The model name is visible immediately on startup (no IPC round-trip needed)
 * because ModelStore defaults to DEFAULT_MODEL_ID.
 * The modelInfo prop has been removed — model display is now store-driven.
 */
export function TopBar() {
  const { selectedModel } = useModelStore()

  return (
    <div
      className="drag-region flex-shrink-0 flex items-center justify-center
                 px-4 h-[52px] border-b border-surface-border/50 relative"
    >
      {/* Center: current model name — always visible since store has a default */}
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
    </div>
  )
}
