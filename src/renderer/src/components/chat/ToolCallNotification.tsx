import { useState } from 'react'
import { Globe, Plug, ChevronRight } from 'lucide-react'

interface ToolCallNotificationProps {
  phase:    'searching' | 'done' | 'error'
  query:    string
  results?: Array<{ title: string; url: string }>
  error?:   string
  className?: string
}

// Format the query label for display.
// For MCP tools stored as "serverName__toolName", show "serverName: toolName".
// For search queries, show as-is.
function formatQueryLabel(query: string): string {
  if (query.includes('__')) {
    const [server, ...rest] = query.split('__')
    return `${server}: ${rest.join('__')}`
  }
  return query
}

// Detect whether this notification is for a web search (vs an MCP tool).
// Web search queries never contain "__"; MCP tool names always do.
function isWebSearch(query: string): boolean {
  return !query.includes('__')
}

export function ToolCallNotification({ phase, query, results = [], error: errorMsg, className = '' }: ToolCallNotificationProps) {
  const [expanded, setExpanded] = useState(false)
  const label = formatQueryLabel(query)
  const webSearch = isWebSearch(query)

  if (phase === 'searching') {
    return (
      <div
        className={`rounded-lg border border-surface-border/40 mb-3 px-3 py-2.5 flex items-center gap-2.5 ${className}`}
        style={{ background: '#141414' }}
      >
        <div className="w-3 h-3 rounded-full border border-surface-border border-t-content-muted animate-spin shrink-0" />
        <span className="text-xs text-content-muted">
          {webSearch ? 'Searching the web…' : 'Running tool…'}
        </span>
        <span className="text-xs font-mono text-content-tertiary truncate">"{label}"</span>
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
          {webSearch
            ? <Globe size={13} className="text-accent-700 shrink-0" />
            : <Plug  size={13} className="text-accent-700 shrink-0" />
          }
          <span className="text-xs text-accent-600 shrink-0">
            {webSearch ? 'Web search failed' : 'Tool failed'}
          </span>
        </div>
        <p className="text-xs font-mono text-content-tertiary mt-1 truncate">"{label}"</p>
        {errorMsg && (
          <p className="text-xs text-accent-500/70 mt-1 leading-relaxed">{errorMsg}</p>
        )}
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
        {webSearch
          ? <Globe size={13} className="text-content-muted shrink-0" />
          : <Plug  size={13} className="text-content-muted shrink-0" />
        }
        <span className="text-xs text-content-secondary font-medium flex-1 text-left">
          {webSearch ? 'Searched the web' : `Used tool: ${label}`}
        </span>
        <ChevronRight
          size={12}
          className={`text-content-muted transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-t border-surface-border/30 px-3 py-3 space-y-2.5">
          <p className="text-xs font-mono text-content-muted">"{label}"</p>
          {results.length > 0 && (
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
          )}
        </div>
      )}
    </div>
  )
}
