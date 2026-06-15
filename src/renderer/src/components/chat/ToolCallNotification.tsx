import { useState, useEffect } from 'react'
import { Globe, Plug } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ChevronIcon } from './ChevronIcon'

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
  autoCollapse?: boolean
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

/** Splits "server__toolName" into { server, tool }.
 *  Falls back to { server: '', tool: query } for non-MCP queries. */
function parseMcpLabel(query: string): { server: string; tool: string } {
  if (query.includes('__')) {
    const idx = query.indexOf('__')
    return {
      server: query.slice(0, idx),
      tool:   query.slice(idx + 2),
    }
  }
  return { server: '', tool: query }
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
    <div className={cn(isFirst ? '' : 'mt-2')}>
      {/* Query line */}
      <div className="flex items-center gap-1.5 mb-1">
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
              className="flex items-baseline gap-3 px-1.5 py-0.5 rounded-[4px] text-left
                         hover:bg-white/[0.03] transition-colors duration-100 group w-full"
            >
              <span className="font-mono text-[11px] text-white/20 flex-shrink-0 leading-none w-4">
                {i + 1}.
              </span>
              <span className="text-[12px] text-white/75 leading-snug flex-shrink truncate max-w-[65%]
                               group-hover:text-accent-500 transition-colors duration-100">
                {r.title}
              </span>
              <span className="font-mono text-[10px] text-white/30 min-w-0 truncate flex-1 text-right
                               group-hover:text-white/45 transition-colors duration-100">
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
  autoCollapse,
}: ToolCallNotificationProps) {
  const label = formatQueryLabel(query)
  const webSearch = resolveIsWebSearch(toolName, query)
  // Web search: expanded by default so results are immediately visible.
  // MCP tools: collapsed by default — header shows server·tool summary.
  const [expanded, setExpanded] = useState(webSearch)

  useEffect(() => {
    if (autoCollapse && webSearch && phase === 'done') setExpanded(false)
  }, [autoCollapse, webSearch, phase])

  // ── Searching: shimmer "Working" ──────────────────────────────
  if (phase === 'searching') {
    return (
      <div className={`mb-2 py-0.5 ${className}`}>
        <span
          className="shimmer-text font-mono text-[13px] tracking-wide"
          style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}
        >
          Working
        </span>
      </div>
    )
  }

  // ── Error: title at full width, detail indented under rail ──────
  if (phase === 'error') {
    return (
      <div className={cn('mb-2', className)}>
        <div className="flex items-center gap-2">
          <Globe size={12} className="text-accent-700 shrink-0" />
          <span className="text-[13px] text-accent-700 font-medium font-mono">
            {webSearch ? 'Search failed' : 'Tool failed'}
          </span>
          <span className="font-mono text-[13px] text-white/20">
            {label}
          </span>
        </div>
        {errorMsg && (
          <p className="font-mono text-[11px] text-accent-700/50 leading-relaxed">
            {errorMsg}
          </p>
        )}
      </div>
    )
  }

  const hasArgs   = toolArgs   && Object.keys(toolArgs).length > 0
  const hasImages = toolImages && toolImages.length > 0
  const hasText   = !!formattedContent

  // ── Done — web search: title at full width, results indented ────
  if (webSearch) {
    return (
      <div className={cn('mb-2', className)}>
        {/* Header row: "Searched the web  ›  N results" — toggles results */}
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 mb-0 group/sh select-none"
        >
          <Globe size={12} className="text-white/25 shrink-0" />
          <span className="font-mono text-[13px] text-white/40 font-medium
                           group-hover/sh:text-white/60 transition-colors duration-100">
            Searched the web
          </span>
          <ChevronIcon open={expanded} className="text-white/20 group-hover/sh:text-white/35 transition-colors duration-150" />
          <span className="font-mono text-[13px] text-white/20">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        </button>

        <div className={cn('accordion-body', expanded && 'open')}>
          <div style={{ overflow: 'hidden' }}>
            <SearchResult query={label} results={results} isFirst />
          </div>
        </div>
      </div>
    )
  }

  // ── Done — MCP tool: title at full width, body indented ─────────
  const { server, tool } = parseMcpLabel(query)
  // Built-in tools have no server prefix (no __ in query, not web search)
  // Show "built-in" as the server label instead
  const serverLabel = server || 'built-in'

  return (
    <div className={cn('mb-2', className)}>

      {/* Header: server · tool_name › */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-1.5 group/tc select-none"
      >
        <Plug size={12} className="shrink-0 transition-colors duration-100" style={{ color: 'rgb(255,77,77)' }} />
        <span className="font-mono text-[13px] leading-none
                         transition-colors duration-100"
             style={{ color: 'rgb(255,77,77)' }}>
          {serverLabel}
        </span>
        <span className="text-[13px] leading-none" style={{ color: 'rgba(255,77,77,0.4)' }}>·</span>
        <span className="font-mono text-[13px] font-medium leading-none
                         group-hover/tc:text-white/55 transition-colors duration-100"
             style={{ color: 'rgb(255,77,77)' }}>
          {tool || label}
        </span>
        <ChevronIcon open={expanded} className="text-white/20 group-hover/tc:text-white/35 transition-colors duration-150" />
      </button>

      {/* Expanded body */}
      <div className={cn('accordion-body', expanded && 'open')}>
        <div style={{ overflow: 'hidden' }}>
          <div className="mt-1 flex flex-col gap-0">

            {/* Arguments */}
            {hasArgs && (
              <div className="mb-2">
                <p className="font-mono text-[9.5px] text-white/20 mb-1 tracking-[0.04em]">
                  arguments
                </p>
                <pre className="font-mono text-[11px] text-white/30 leading-relaxed
                                whitespace-pre-wrap break-all overflow-x-auto">
                  {JSON.stringify(toolArgs, null, 2)}
                </pre>
              </div>
            )}

            {/* Divider between args and output — only when both exist */}
            {hasArgs && (hasImages || hasText) && (
              <div className="h-px bg-white/[0.06] my-1" />
            )}

            {/* Output */}
            {(hasImages || hasText) && (
              <div>
                <p className="font-mono text-[9.5px] text-white/20 mb-1 tracking-[0.04em]">
                  output
                </p>

                {/* Images */}
                {hasImages && toolImages!.map((img, i) => (
                  <div key={i} className="mt-1">
                    <img
                      src={`data:${img.mimeType};base64,${img.data}`}
                      className="rounded-[4px] w-full border border-white/[0.08]"
                      alt="Tool output"
                    />
                  </div>
                ))}

                {/* Text */}
                {hasText && (
                  <pre className="font-mono text-[11px] text-white/30 leading-relaxed
                                  whitespace-pre-wrap break-all overflow-x-auto
                                  max-h-48 overflow-y-auto">
                    {formattedContent}
                  </pre>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}
