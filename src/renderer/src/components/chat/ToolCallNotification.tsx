import { useState } from 'react'
import { Globe, Plug } from 'lucide-react'
import { cn } from '../../lib/utils'

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
  if (toolName !== undefined) return toolName === 'brave_web_search'
  // Legacy fallback: Brave search queries never contain '__'
  return !(query ?? '').includes('__')
}

// ── SearchResult ─────────────────────────────────────────────────
// Exported separately so MessageBubble can use it in the merged-group renderer.
export interface SearchResultData {
  query:    string
  results:  Array<{ title: string; url: string }>
  phase:    'done' | 'error' | 'searching'
  error?:   string
}

export function SearchResult({
  query,
  results = [],
  isFirst = false,
  showDot = false,
}: {
  query:    string
  results:  Array<{ title: string; url: string }>
  isFirst?: boolean
  showDot?: boolean
}) {
  return (
    <div className={cn(isFirst ? '' : 'mt-3')}>
      {/* Query line */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {showDot && (
          <span className="w-1 h-1 rounded-full bg-white/[0.12] flex-shrink-0 inline-block" />
        )}
        <span className="font-mono text-[10.5px] text-white/30 leading-none">
          "{query}"
        </span>
      </div>
      {/* Results */}
      {results.length > 0 && (
        <div className="flex flex-col gap-0">
          {results.slice(0, 5).map((r, i) => (
            <button
              key={i}
              onClick={() => window.api.openExternal(r.url).catch(console.error)}
              className="flex items-baseline gap-2 px-1.5 py-1 rounded-[4px] text-left
                         hover:bg-white/[0.03] transition-colors duration-100 group"
            >
              <span className="font-mono text-[10px] text-white/20 w-3.5 flex-shrink-0 leading-none">
                {i + 1}.
              </span>
              <span className="text-[12px] text-white/50 leading-snug flex-1 min-w-0
                               group-hover:text-accent-500 transition-colors duration-100 truncate">
                {r.title}
              </span>
              <span className="font-mono text-[10px] text-white/15 flex-shrink-0 max-w-[200px] truncate
                               group-hover:text-white/30 transition-colors duration-100 hidden sm:block">
                {r.url}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── ToolCallNotification ─────────────────────────────────────────
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
  // Default expanded=true so results are visible immediately on 'done'
  const [expanded, setExpanded] = useState(true)
  const label = formatQueryLabel(query)
  const webSearch = resolveIsWebSearch(toolName, query)

  // ── Searching: shimmer "Working" ──────────────────────────────
  if (phase === 'searching') {
    return (
      <div className={`mb-3 py-0.5 ${className}`}>
        <span
          className="shimmer-text font-mono text-[13px] tracking-wide"
          style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}
        >
          Working
        </span>
      </div>
    )
  }

  // ── Error: left-rail, no card ─────────────────────────────────
  if (phase === 'error') {
    return (
      <div className={cn('border-l border-white/[0.10] pl-3 mb-3', className)}>
        <div className="flex items-center gap-2">
          <Globe size={12} className="text-accent-700 shrink-0" />
          <span className="text-[12px] text-accent-700 font-medium">
            {webSearch ? 'Search failed' : 'Tool failed'}
          </span>
          <span className="font-mono text-[10.5px] text-white/20">
            "{label}"
          </span>
        </div>
        {errorMsg && (
          <p className="font-mono text-[10px] text-accent-700/50 mt-0.5 leading-relaxed pl-[20px]">
            {errorMsg}
          </p>
        )}
      </div>
    )
  }

  const hasArgs   = toolArgs   && Object.keys(toolArgs).length > 0
  const hasImages = toolImages && toolImages.length > 0
  const hasText   = !!formattedContent

  // ── Done — web search: left-rail, no card ────────────────────
  if (webSearch) {
    return (
      <div className={cn('border-l border-white/[0.10] pl-3 mb-3', className)}>
        {/* Header row: "Searched the web  ›  N results" — toggles results */}
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 mb-0 group/sh select-none"
        >
          <Globe size={12} className="text-white/25 shrink-0" />
          <span className="text-[12px] text-white/40 font-medium
                           group-hover/sh:text-white/60 transition-colors duration-100">
            Searched the web
          </span>
          <span
            className={cn(
              'text-[10px] text-white/20 transition-all duration-150',
              'group-hover/sh:text-white/35',
              expanded ? 'rotate-90 inline-block' : ''
            )}
          >
            ›
          </span>
          <span className="font-mono text-[10px] text-white/20">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        </button>

        {expanded && (
          <div className="mt-1">
            <SearchResult query={label} results={results} isFirst />
          </div>
        )}
      </div>
    )
  }

  // ── Done — MCP tool: keep existing card design ───────────────
  return (
    <div
      className={`rounded-lg border border-surface-border/40 mb-3 overflow-hidden ${className}`}
      style={{ background: '#141414' }}
    >
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/[0.03] transition-colors"
      >
        <Plug size={13} className="text-content-muted shrink-0" />
        <span className="text-xs text-content-secondary font-medium flex-1 text-left">
          Used tool: {label}
        </span>
        <span
          className={cn(
            'text-content-muted text-[10px] transition-transform duration-150',
            expanded ? 'rotate-90 inline-block' : ''
          )}
        >
          ›
        </span>
      </button>

      {expanded && (
        <div className="border-t border-surface-border/30 px-3 py-3 space-y-2.5">
          <p className="text-xs font-mono text-content-muted">"{label}"</p>

          {/* MCP: Arguments */}
          {hasArgs && (
            <div className="mt-2.5">
              <p className="text-[10px] uppercase tracking-wider text-content-tertiary mb-1.5 font-medium">Arguments</p>
              <pre className="text-xs font-mono text-content-secondary bg-black/30 rounded-md px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed border border-surface-border/20">
                {JSON.stringify(toolArgs, null, 2)}
              </pre>
            </div>
          )}

          {/* MCP: Output (images + text) */}
          {(hasImages || hasText) && (
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
                  {formattedContent}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
