import { useEffect, useState } from 'react'
import { ShieldQuestion, Plug, ChevronDown, ChevronUp, Bot } from 'lucide-react'
import type { McpToolPermissionRequest, McpToolPermissionResponse } from '../../../../shared/types'

interface McpPermissionDialogProps {
  request:   McpToolPermissionRequest
  onRespond: (r: McpToolPermissionResponse) => void
  inline?: boolean
}

export function McpPermissionDialog({ request, onRespond, inline = false }: McpPermissionDialogProps) {
  const [note,        setNote]        = useState('')
  const [argsOpen,    setArgsOpen]    = useState(false)
  const [responding,  setResponding]  = useState(false)

  // Strip "serverName__" prefix from toolName for display
  const displayToolName = request.toolName.includes('__')
    ? request.toolName.split('__').slice(1).join('__')
    : request.toolName

  const argsJson    = JSON.stringify(request.args, null, 2)
  const hasArgs     = Object.keys(request.args).length > 0
  const agent       = request.agent
  const remaining   = useCountdown(request.timeoutMs)

  const respond = async (
    approved: boolean,
    alwaysAllow: McpToolPermissionResponse['alwaysAllow'],
    agentTrust?: McpToolPermissionResponse['agentTrust'],
  ) => {
    if (responding) return
    setResponding(true)
    try {
      onRespond({
        requestId: request.requestId, approved, alwaysAllow, userNote: note.trim(),
        ...(agentTrust ? { agentTrust } : {}),
      })
    } catch (err) {
      console.warn('[McpPermissionDialog] respond failed:', err)
      setResponding(false)
    }
  }

  return (
    <div className={inline ? 'w-full max-w-md' : 'absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm'}>
      <div className="w-full max-w-md mx-4 rounded-xl border border-surface-border bg-surface-elevated shadow-2xl p-6 space-y-4">

        {/* Icon + title */}
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-accent-950/60 border border-accent-900/40 flex items-center justify-center">
            <ShieldQuestion className="w-4 h-4 text-accent-400" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-content-primary">
              {agent ? `${agent.role} Agent needs approval` : 'Tool permission required'}
            </h3>
            <p className="text-xs text-content-muted mt-0.5" data-testid="permission-subtitle">
              {agent
                ? `${agent.role} Agent (${agent.model || 'default model'}) is requesting access to ${displayToolName}.`
                : 'The assistant wants to call an MCP tool.'}
            </p>
            {remaining !== null && (
              <p className="text-[10px] text-content-muted mt-1">Auto-denies in {remaining}</p>
            )}
          </div>
        </div>

        {/* Tool info */}
        <div className="space-y-1.5">
          {agent && (
            <div className="flex items-center gap-2 text-xs">
              <Bot className="w-3.5 h-3.5 text-accent-500 flex-shrink-0" />
              <span className="text-content-muted">Agent:</span>
              <span className="text-content-primary font-mono">{agent.agentId} · {agent.role}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <Plug className="w-3.5 h-3.5 text-accent-500 flex-shrink-0" />
            <span className="text-content-muted">Server:</span>
            <span className="text-content-primary font-mono">{request.serverName}</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-3.5 flex-shrink-0" />
            <span className="text-content-muted">Tool:</span>
            <span className="text-content-primary font-mono">{displayToolName}</span>
          </div>
        </div>

        {/* Args (collapsible) */}
        {hasArgs && (
          <div>
            <button
              data-testid="args-toggle"
              onClick={() => setArgsOpen((o) => !o)}
              className="flex items-center gap-1 text-xs text-content-muted hover:text-content-secondary transition-colors"
            >
              {argsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {argsOpen ? 'Hide arguments' : 'Show arguments'}
            </button>
            {argsOpen && (
              <pre className="mt-1.5 text-xs font-mono text-content-secondary bg-black/40 rounded-lg px-3 py-2.5 overflow-x-auto max-h-40 border border-surface-border/50">
                {argsJson}
              </pre>
            )}
          </div>
        )}

        {/* Note for model */}
        <div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional: add context or reason..."
            rows={2}
            className="w-full text-xs font-mono bg-black/30 border border-surface-border rounded-lg px-3 py-2
                       text-content-primary placeholder:text-content-muted resize-none
                       focus:outline-none focus:ring-1 focus:ring-accent-800/60
                       transition-colors"
          />
        </div>

        {/* Per-agent trust within this run (spec §07) */}
        {agent && (
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => respond(false, false, 'block')}
              disabled={responding}
              className="px-3 py-1.5 text-xs rounded border border-red-900/50 text-red-400
                         hover:bg-red-950/40 disabled:opacity-40 transition-colors"
            >
              Block this agent
            </button>
            <button
              onClick={() => respond(true, false, 'trust')}
              disabled={responding}
              className="px-3 py-1.5 text-xs rounded border border-surface-border text-content-secondary
                         hover:text-content-primary disabled:opacity-40 transition-colors"
            >
              Allow all from this agent
            </button>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 justify-end pt-1">
          <button
            onClick={() => respond(false, false)}
            disabled={responding}
            className="px-3 py-1.5 text-xs rounded border border-surface-border
                       text-content-secondary hover:text-red-400 hover:border-red-900/50
                       disabled:opacity-40 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => respond(true, 'session')}
            disabled={responding}
            className="px-3 py-1.5 text-xs rounded border border-surface-border
                       text-content-secondary hover:text-content-primary hover:border-surface-border/80
                       disabled:opacity-40 transition-colors"
          >
            Allow this session
          </button>
          <button
            onClick={() => respond(true, false)}
            disabled={responding}
            className="px-3 py-1.5 text-xs rounded bg-accent-700 hover:bg-accent-600
                       text-white disabled:opacity-40 transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}

/** "4:59" until the dialog's auto-deny deadline, or null when it has none. */
function useCountdown(timeoutMs: number | undefined): string | null {
  const [deadline] = useState(() => (timeoutMs ? Date.now() + timeoutMs : null))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!deadline) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [deadline])
  if (!deadline) return null
  const s = Math.max(0, Math.ceil((deadline - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
