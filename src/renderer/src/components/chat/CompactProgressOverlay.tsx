import { motion } from 'framer-motion'

interface Props {
  label?: string
}

export function CompactProgressOverlay({ label = 'Compacting context\u2026' }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center
                 bg-black/60 backdrop-blur-sm rounded-none"
    >
      <p className="text-content-secondary text-sm font-medium mb-6 tracking-wide">
        {label}
      </p>
      {/* Indeterminate progress bar — same red as accent */}
      <div className="w-64 h-1 bg-surface-border/40 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-accent-600 rounded-full"
          animate={{ x: ['-100%', '200%'] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          style={{ width: '40%' }}
        />
      </div>
    </motion.div>
  )
}
