import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Shield, ShieldAlert } from 'lucide-react'
import type { SandboxStatusInfo } from '../../../../shared/types'

// Sandbox health for Settings (SANDBOX_ARCHITECTURE_SPEC.html section 04/16):
// startup dependency check result, the baseline credential denylist, and the
// network policies currently enforced. Violations live in Debug → logs.
export function SandboxStatusPanel() {
  const [status, setStatus] = useState<SandboxStatusInfo | null>(null)
  const [showDenylist, setShowDenylist] = useState(false)

  useEffect(() => {
    window.api.getSandboxStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  if (!status) return null

  return (
    <div
      className={`rounded-lg border px-4 py-3 space-y-2 ${
        status.ready ? 'border-surface-border/60 bg-surface-DEFAULT' : 'border-red-900/70 bg-red-950/20'
      }`}
      data-testid="sandbox-status"
    >
      <div className="flex items-center gap-2">
        {status.ready ? (
          <Shield className="w-4 h-4 text-emerald-400" />
        ) : (
          <ShieldAlert className="w-4 h-4 text-red-400" />
        )}
        <span className="text-sm font-medium text-content-primary">
          {status.ready ? 'Tool sandbox active' : 'Tool sandbox unavailable'}
        </span>
      </div>

      {!status.ready && (
        <div className="text-xs text-red-300 space-y-1">
          {status.errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
          <p className="text-content-muted">
            Sandboxed tools (Python charts, MCP servers without a bypass) will not run until this is resolved.
          </p>
        </div>
      )}
      {status.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-400">
          {w}
        </p>
      ))}

      {status.activePolicies.length > 0 && (
        <div className="text-xs text-content-muted space-y-0.5">
          <p className="text-content-secondary">Active network policies</p>
          {status.activePolicies.map((p) => (
            <p key={p.allowedDomains.join(',')} className="font-mono">
              {p.allowedDomains.length ? p.allowedDomains.join(', ') : 'no network'}
              <span className="text-content-muted"> · {p.leases} process(es)</span>
            </p>
          ))}
        </div>
      )}

      <button
        onClick={() => setShowDenylist((v) => !v)}
        className="flex items-center gap-1 text-xs text-content-muted hover:text-content-secondary transition-colors"
      >
        {showDenylist ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        Always-blocked credential paths ({status.baselineDenyRead.length})
      </button>
      {showDenylist && (
        <ul className="text-xs font-mono text-content-muted space-y-0.5 pl-4">
          {status.baselineDenyRead.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
