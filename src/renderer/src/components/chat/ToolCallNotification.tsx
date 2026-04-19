import { useState } from 'react'
import { Globe, ChevronRight } from 'lucide-react'

interface ToolCallNotificationProps {
  phase:    'searching' | 'done' | 'error'
  query:    string
  results?: Array<{ title: string; url: string }>
  error?:   string
  className?: string
}

export function ToolCallNotification({ phase, query, results = [], error: errorMsg, className = '' }: ToolCallNotificationProps) {
  const [expanded, setExpanded] = useState(false)

  if (phase === 'searching') {
    return (
      <div
        className={`rounded-lg border border-surface-border/40 mb-3 px-3 py-2.5 flex items-center gap-2.5 ${className}`}
        style={{ background: '#141414' }}
      >
        <div className="w-3 h-3 rounded-full border border-surface-border border-t-content-muted animate-spin shrink-0" />
        <span className="text-xs text-content-muted">Searching the web…</span>
        <span className="text-xs font-mono text-content-tertiary truncate">"{query}"</span>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div
        className={`rounded-lg border border-accent-900/30 mb-3 px-3 py-2 ${className}`}
        style={{ background: '#141414' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Globe size={13} className="text-accent-700 shrink-0" />
          <span className="text-xs text-accent-600 shrink-0">Web search failed</span>
        </div>
        <p className="text-xs font-mono text-content-tertiary mt-1 truncate">"{query}"</p>
      </div>
    )
  }

  return (
    <div
      className={`rounded-lg border border-surface-border/40 mb-3 overflow-hidden ${className}`}
      style={{ background: '#141414' }}
    >
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.03] transition-colors"
      >
        <Globe size={13} className="text-content-muted shrink-0" />
        <span className="text-xs text-content-secondary font-medium flex-1 text-left">
          Searched the web
        </span>
        <ChevronRight
          size={12}
          className={`text-content-muted transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-surface-border/30 px-3 py-3 space-y-2.5">
          <p className="text-xs font-mono text-content-muted">"{query}"</p>
          <div className="space-y-2 mt-1">
            {results.slice(0, 5).map((r, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-xs text-content-tertiary shrink-0 w-4 mt-px">{i + 1}.</span>
                <button
                  className="min-w-0 text-left group"
                  onClick={() => window.api.openExternal(r.url).catch(console.error)}
                >
                  <p className="text-xs text-content-secondary truncate leading-relaxed group-hover:text-accent-400 transition-colors">{r.title}</p>
                  <p className="text-xs text-content-tertiary truncate group-hover:text-accent-600 transition-colors">{r.url}</p>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
