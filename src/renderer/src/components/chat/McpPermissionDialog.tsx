import { useState } from 'react'
import { ShieldQuestion, Plug } from 'lucide-react'
import type { McpToolPermissionRequest } from '../../../../shared/types'

interface McpPermissionDialogProps {
  request: McpToolPermissionRequest
  onDismiss: () => void
}

export function McpPermissionDialog({ request, onDismiss }: McpPermissionDialogProps) {
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [responding,  setResponding]  = useState(false)

  const respond = async (approved: boolean) => {
    if (responding) return
    setResponding(true)
    try {
      await window.api.mcpRespondToPermission({
        requestId:   request.requestId,
        approved,
        alwaysAllow: approved && alwaysAllow,
      })
    } catch (err) {
      console.warn('[McpPermissionDialog] respond failed:', err)
    }
    onDismiss()
  }

  const argsJson = JSON.stringify(request.args, null, 2)

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 rounded-xl border border-surface-border bg-surface-elevated shadow-2xl p-6 space-y-5">
        {/* Icon + title */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent-950/60 border border-accent-900/40 flex items-center justify-center">
            <ShieldQuestion className="w-4 h-4 text-accent-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-content-primary">Tool permission required</h3>
            <p className="text-xs text-content-muted mt-0.5">
              The assistant wants to call an MCP tool.
            </p>
          </div>
        </div>

        {/* Tool info */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Plug className="w-3.5 h-3.5 text-accent-500 flex-shrink-0" />
            <span className="text-content-muted">Server:</span>
            <span className="text-content-primary font-mono">{request.serverName}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-3.5 flex-shrink-0" />
            <span className="text-content-muted">Tool:</span>
            <span className="text-content-primary font-mono">{request.toolName}</span>
          </div>
        </div>

        {/* Args */}
        {Object.keys(request.args).length > 0 && (
          <div>
            <p className="text-xs text-content-muted mb-1.5">Arguments</p>
            <pre className="text-xs font-mono text-content-secondary bg-black/40 rounded-lg px-3 py-2.5 overflow-x-auto max-h-40 border border-surface-border/50">
              {argsJson}
            </pre>
          </div>
        )}

        {/* Always-allow toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
            className="rounded border-surface-border bg-black/30 text-accent-600 focus:ring-accent-600 w-3.5 h-3.5"
          />
          <span className="text-xs text-content-secondary">
            Always allow <span className="font-mono text-content-primary">{request.serverName}</span> without asking
          </span>
        </label>

        {/* Buttons */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={() => respond(false)}
            disabled={responding}
            className="px-4 py-1.5 text-xs rounded border border-surface-border text-content-secondary hover:text-content-primary hover:border-surface-border/80 disabled:opacity-40 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => respond(true)}
            disabled={responding}
            className="px-4 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600 text-white disabled:opacity-40 transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
