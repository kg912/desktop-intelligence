import { motion } from 'framer-motion'
import { ShieldAlert } from 'lucide-react'
import type { SandboxViolationTraceEvent } from '../../../../shared/types'

function describeSource(source: string): string {
  if (source.startsWith('mcp:')) return `MCP server "${source.slice(4)}"`
  if (source === 'python-worker') return 'The Python worker'
  if (source === 'unknown') return 'A sandboxed process'
  return source
}

interface Props {
  violation: SandboxViolationTraceEvent
}

/** Credential-path denial alert — pushed via SANDBOX_VIOLATION_ALERT, see Layout.tsx. */
export function SandboxViolationToast({ violation }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="fixed top-4 right-4 z-50
                 flex items-start gap-2.5 px-4 py-3 rounded-2xl max-w-sm
                 bg-surface-elevated border border-red-900/50 shadow-xl"
    >
      <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
      <div className="text-[12px] text-content-secondary leading-relaxed">
        <p className="text-content-primary font-medium mb-0.5">
          Sandbox blocked a credential access attempt
        </p>
        <p>
          {describeSource(violation.source)} was denied access to{' '}
          <span className="font-mono text-content-primary break-all">{violation.target}</span>
        </p>
      </div>
    </motion.div>
  )
}
