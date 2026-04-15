import { motion } from 'framer-motion'
import { CheckCircle } from 'lucide-react'

interface Props {
  tokensBefore: number
  tokensAfter:  number
  hasDocuments: boolean
}

export function CompactToast({ tokensBefore, tokensAfter, hasDocuments }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50
                 flex flex-col items-center gap-1 px-4 py-2 rounded-2xl
                 bg-surface-elevated border border-surface-border shadow-xl
                 text-[12px] text-content-secondary"
    >
      <div className="flex items-center gap-2">
        <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
        <span>
          Compacted{' '}
          <span className="text-content-primary font-medium">{tokensBefore.toLocaleString()}</span>
          {' → '}
          <span className="text-content-primary font-medium">{tokensAfter.toLocaleString()}</span>
          {' tokens'}
        </span>
      </div>
      {hasDocuments && (
        <span className="block text-center text-[11px] text-content-tertiary">
          Document context re-injects on each query
        </span>
      )}
    </motion.div>
  )
}
