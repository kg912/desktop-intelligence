import { useState } from 'react'
import { Globe, Plug, ChevronRight } from 'lucide-react'

interface ToolCallNotificationProps {
  phase:    'searching' | 'done' | 'error'
  query:    string
  /** Authoritative tool name e.g. "brave_web_search" or "memory__search_nodes".
   *  When absent (old persisted blocks) falls back to query-based heuristic. */
  toolName?: string
  results?: Array<{ title: string; url: string }>
  error?:   string
  /** Full augmented text returned by the tool */
  formattedContent?: string
  /** Arguments the model passed to the tool (MCP only) */
  toolArgs?: Record<string, unknown>
  /** Image outputs returned by the tool (e.g. Puppeteer screenshots) */
  toolImages?: Array<{ mimeType: string; data: string }>
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

// Returns true when this notification is for a Brave web search.
// Prefers the authoritative toolName field; falls back to the query-based
// heuristic for old persisted blocks that don't have toolName.
function resolveIsWebSearch(toolName?: string, query?: string): boolean {
  if (toolName !== undefined) return toolName === 'brave_web_search';
  // Legacy fallback: Brave search queries never contain '__'
  return !(query ?? '').includes('__')
}

export function ToolCallNotification({
  phase,
  query,
  toolName,
  results = [],
  error: errorMsg,
  formattedContent,
  toolArgs,
  toolImages,
  className = '',
}: ToolCallNotificationProps) {
  const [expanded, setExpanded] = useState(false)
  const label = formatQueryLabel(query)
  const webSearch = resolveIsWebSearch(toolName, query)

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

  const hasArgs   = toolArgs   && Object.keys(toolArgs).length > 0
  const hasImages = toolImages && toolImages.length > 0
  const hasText   = !!formattedContent

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

          {/* Web search results */}
          {webSearch && results.length > 0 && (
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

          {/* MCP: Arguments */}
          {!webSearch && hasArgs && (
            <div className="mt-2.5">
              <p className="text-[10px] uppercase tracking-wider text-content-tertiary mb-1.5 font-medium">Arguments</p>
              <pre className="text-xs font-mono text-content-secondary bg-black/30 rounded-md px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed border border-surface-border/20">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          )}

          {/* MCP: Output (images + text) */}
          {!webSearch && (hasImages || hasText) && (
            <div className="mt-2.5">
              <p className="text-[10px] uppercase tracking-wider text-content-tertiary mb-1.5 font-medium">Output</p>
              {hasImages && toolImages!.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  className="rounded-md w-full mt-2 border border-surface-border/30"
                  alt="Tool output"
                />
              ))}
              {hasText && (
                <pre className="text-xs font-mono text-content-secondary bg-black/30 rounded-md px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed border border-surface-border/20 max-h-48 overflow-y-auto mt-2">
                  {formattedContent!.length > 2000
                    ? formattedContent!.slice(0, 2000) + '\n…'
                    : formattedContent}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
