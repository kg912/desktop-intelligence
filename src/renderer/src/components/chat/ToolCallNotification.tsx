import { useState, useEffect } from 'react'
import { FileText, FilePen, Search, FolderOpen, FolderLock } from 'lucide-react'
import { DiffView } from './DiffView'
import { fsToolLabel, isFsTool, type FsPillIcon } from '../../lib/fsToolLabel'
import { cn } from '../../lib/utils'
import { ChevronIcon } from './ChevronIcon'
import { isWebSearchToolName } from '../../../../shared/webSearch'
import type { WebSearchMeta, WebSearchProvider, ExaSearchType } from '../../../../shared/webSearch'

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
  /** Unified diff of a built-in file edit (fs_edit / fs_write) */
  toolDiff?: string
  /** Web search: provider chip, deep-mode synthesis, footer; absent on older blocks. */
  provider?: WebSearchMeta['provider']
  mode?: WebSearchMeta['mode']
  contentMode?: WebSearchMeta['contentMode']
  searchTimeMs?: number
  costDollars?: number
  synthesis?: WebSearchMeta['synthesis']
  /** Exact text the model got when it differs from formattedContent (provider truncation). */
  sentToModel?: string
  className?: string
  autoCollapse?: boolean
  expanded?: boolean
  onToggle?: () => void
}

// ── Web search provider chip (mockup tab 2) ──────────────────────
const PROVIDER_DOT: Record<WebSearchProvider, string> = { exa: '#7aa2f7', brave: '#fb923c' }

/** "Exa · auto" / "Exa · fast" / "Brave" (or `label`). Older blocks carry no provider: they were all Brave. */
export function ProviderChip({ provider = 'brave', mode, label: given }: { provider?: WebSearchProvider; mode?: ExaSearchType; label?: string }) {
  const label = given ?? (provider === 'exa' ? `Exa${mode ? ` · ${mode === 'lite' ? 'fast' : mode}` : ''}` : 'Brave')
  return (
    <span
      data-testid="provider-chip"
      data-provider={provider}
      className="inline-flex items-center gap-1.5 font-mono text-[11px] font-medium leading-none rounded-[5px] px-[7px] py-[3px]
                 border-[0.5px] border-white/[0.09] text-white/60 bg-white/[0.02]"
    >
      <i className="block w-1.5 h-1.5 rounded-full" style={{ background: PROVIDER_DOT[provider] }} />
      {label}
    </span>
  )
}

/** Live search: shimmer "Working", the provider chip and an elapsed timer. */
export function SearchingIndicator({ provider, mode }: { provider?: WebSearchProvider; mode?: ExaSearchType }) {
  const [started] = useState(() => Date.now())
  const [now, setNow] = useState(started)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(t)
  }, [])
  const deep = mode === 'deep' || mode === 'deep-lite'
  return (
    <div className="py-0.5">
      <div className="flex items-center gap-2">
        <span className="shimmer-text font-mono text-[13px] tracking-wide" style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}>
          Working
        </span>
        <ProviderChip provider={provider} mode={mode} />
        <span data-testid="search-elapsed" className="font-mono text-[11px] text-white/[0.22]">{((now - started) / 1000).toFixed(1)} s</span>
      </div>
      {deep && (
        <p className="font-mono text-[11px] text-white/40 mt-1">
          {mode === 'deep' ? 'Deep search usually takes 4–15 s.' : 'Deep-lite search usually takes 3–4 s.'}
        </p>
      )}
    </div>
  )
}

/** "[1]" markers in the brief as small citation chips. */
function withCitations(text: string) {
  return text.split(/(\[\d+\])/g).map((part, i) =>
    /^\[\d+\]$/.test(part)
      ? <span key={i} className="font-mono text-[10px] text-[#7aa2f7] border-[0.5px] border-[#7aa2f7]/40 rounded-[3px] px-1 ml-0.5">{part.slice(1, -1)}</span>
      : part,
  )
}

function SearchFooter({ provider, mode, contentMode, searchTimeMs, costDollars, count }: {
  provider: WebSearchProvider; mode?: ExaSearchType; contentMode?: string; searchTimeMs?: number; costDollars?: number; count: number
}) {
  const parts = provider === 'exa'
    ? ['exa', ...(mode ? [`type ${mode}`] : []), ...(searchTimeMs !== undefined ? [`${(searchTimeMs / 1000).toFixed(1)} s`] : []),
       ...(costDollars !== undefined ? [`$${costDollars.toFixed(3)}`] : []), ...(contentMode ? [contentMode === 'text' ? 'full text' : contentMode] : [])]
    : ['brave', `${count} ${count === 1 ? 'result' : 'results'}`, 'page fetch on']
  return <div data-testid="search-footer" className="font-mono text-[10.5px] text-white/[0.22] pl-1.5 mt-1.5">{parts.join(' · ')}</div>
}

/** Deep-mode synthesis box (renders nothing without synthesis text). */
export function SearchSynthesis({ synthesis }: { synthesis?: WebSearchMeta['synthesis'] }) {
  if (!synthesis?.text) return null
  return (
    <div data-testid="search-synthesis" className="border-l-2 border-[#7aa2f7] bg-[#7aa2f7]/[0.05] rounded-r-md px-3 py-2 mb-2 flex flex-col gap-1.5">
      <span className="font-mono text-[9.5px] font-medium tracking-[0.04em] text-[#7aa2f7]">EXA SYNTHESIS · VERIFY AGAINST SOURCES</span>
      <p className="m-0 text-[12px] leading-[1.55] text-white/60 whitespace-pre-wrap max-h-48 overflow-y-auto">{withCitations(synthesis.text)}</p>
    </div>
  )
}

/** Footer plus the "Sent to model" disclosure; nothing for blocks saved before provider metadata existed. */
export function SearchMetaRows({ provider, sent, ...footer }: {
  provider?: WebSearchProvider; mode?: ExaSearchType; contentMode?: string; searchTimeMs?: number; costDollars?: number; count: number; sent?: string
}) {
  if (!provider) return null
  return (
    <>
      <SearchFooter provider={provider} {...footer} />
      {sent && (
        <details data-testid="sent-to-model" className="ml-1.5 mt-1">
          <summary className="font-mono text-[10.5px] text-white/[0.22] hover:text-white/40 cursor-pointer py-0.5 select-none">Sent to model</summary>
          <pre className="mt-1.5 max-h-[190px] overflow-auto whitespace-pre-wrap break-words rounded-lg border-[0.5px] border-white/[0.09] bg-[#0c0c0c] p-3 font-mono text-[11px] leading-[1.55] text-white/60">
            {sent}
          </pre>
        </details>
      )}
    </>
  )
}

// Format the query label for display.
// MCP tools have double underscores e.g. "mcpServer__toolName".
// Show them as "mcpServer: toolName" in the UI.
function formatQueryLabel(query: string): string {
  if (query.includes('__')) {
    const parts = query.split('__')
    return `${parts[0]}: ${parts.slice(1).join('__')}`
  }
  return query
}

// Returns true when this notification is for a Brave web search.
// Prefers the authoritative toolName field; falls back to the query-based
// heuristic for old persisted blocks that don't have toolName.
function resolveIsWebSearch(toolName?: string, query?: string): boolean {
  if (toolName !== undefined) return isWebSearchToolName(toolName)
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
      <ResultRows results={results} />
    </div>
  )
}

/** Up to five result rows: number, title, url (opens externally). */
export function ResultRows({ results }: { results: Array<{ title: string; url: string }> }) {
  if (results.length === 0) return null
  return (
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
  )
}

/** "Synthesis · 214 words" / "Sent to model · 9,840 chars" toggle in a merged search group (mockup tab 1). */
export function SearchDetailToggle({ open, onToggle, synthesis = false, children, testId }: {
  open: boolean; onToggle: () => void; synthesis?: boolean; children: React.ReactNode; testId: string
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[5px] border-[0.5px] px-2 py-0.5 font-mono text-[10.5px] transition-colors duration-100',
        synthesis ? 'text-[#8fb0f8] border-[#7aa2f7]/[0.32]' : 'text-white/40 border-white/[0.09] hover:text-white/60 hover:border-white/[0.16]',
        open && 'bg-white/[0.04]',
      )}
    >
      <ChevronIcon open={open} size={9} />
      {children}
    </button>
  )
}

const FS_ICONS: Record<FsPillIcon, typeof FileText> = {
  read: FileText,
  edit: FilePen,
  search: Search,
  list: FolderOpen,
  access: FolderLock,
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
  toolDiff,
  provider,
  mode,
  contentMode,
  searchTimeMs,
  costDollars,
  synthesis,
  sentToModel,
  className = '',
  autoCollapse,
  expanded: propExpanded,
  onToggle,
}: ToolCallNotificationProps) {
  const label = formatQueryLabel(query)
  const webSearch = resolveIsWebSearch(toolName, query)
  // Web search: expanded by default so results are immediately visible.
  // MCP tools: collapsed by default — header shows server·tool summary.
  const [localExpanded, setLocalExpanded] = useState(webSearch)
  const expanded = propExpanded !== undefined ? propExpanded : localExpanded
  // File-pill body stays mounted ~300 ms after collapse so the .accordion-body
  // close transition (0.28s) animates real content instead of an empty box.
  const [bodyMounted, setBodyMounted] = useState(expanded)
  const showBody = expanded || bodyMounted
  useEffect(() => {
    if (expanded) { setBodyMounted(true); return }
    if (!bodyMounted) return
    const t = setTimeout(() => setBodyMounted(false), 300)
    return () => clearTimeout(t)
  }, [expanded, bodyMounted])

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setLocalExpanded(v => !v)
    }
  }

  useEffect(() => {
    if (autoCollapse && webSearch && phase === 'done' && !onToggle) {
      setLocalExpanded(false)
    }
  }, [autoCollapse, webSearch, phase, onToggle])

  // ── Searching: shimmer "Working" (web search: plus provider chip and timer) ──
  if (phase === 'searching') {
    if (webSearch && provider) return <div className={`mb-2 ${className}`}><SearchingIndicator provider={provider} mode={mode} /></div>
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

  const fs = isFsTool(toolName) ? fsToolLabel(toolName!, toolArgs ?? {}, { formattedContent, toolDiff }) : null

  // ── Error: title at full width, detail indented under rail ──────
  if (phase === 'error') {
    return (
      <div className={cn('mb-2', className)}>
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-accent-700 font-medium font-mono">
            {webSearch ? 'Search failed' : 'Tool failed'}
          </span>
          {webSearch && provider && <ProviderChip provider={provider} mode={mode} />}
          <span className="font-mono text-[13px] text-white/20">
            {fs ? fs.text : label}
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
          onClick={handleToggle}
          className="flex items-center gap-1.5 mb-0 py-0 group/sh select-none"
        >
          <span className="font-mono text-[13px] leading-none text-white/40 font-medium
                           group-hover/sh:text-white/60 transition-colors duration-100">
            Searched the web
          </span>
          <span className="font-mono text-[13px] leading-none text-white/[0.22]">via</span>
          <ProviderChip provider={provider} mode={mode} />
          <ChevronIcon open={expanded} className="text-white/20 group-hover/sh:text-white/35 transition-colors duration-150" />
          <span className="font-mono text-[13px] leading-none text-white/20">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        </button>

        <div className={cn('accordion-body', expanded && 'open')}>
          <div style={{ overflow: 'hidden', paddingTop: 6 }}>
            <SearchSynthesis synthesis={synthesis} />
            <SearchResult query={label} results={results} isFirst />
            <SearchMetaRows provider={provider} mode={mode} contentMode={contentMode} searchTimeMs={searchTimeMs}
              costDollars={costDollars} count={results.length} sent={sentToModel ?? formattedContent} />
          </div>
        </div>
      </div>
    )
  }

  // ── Done — built-in file tool (spec 2.10, mockup 15 panel D) ────
  if (fs) {
    const Icon = FS_ICONS[fs.icon]
    const isEdit = fs.icon === 'edit'
    return (
      <div className={cn('mb-2', className)}>
        <button
          onClick={handleToggle}
          data-testid="fs-pill"
          data-icon={fs.icon}
          className="flex items-center gap-1.5 group/fs select-none text-left"
        >
          <Icon className="w-[13px] h-[13px] text-white/30 flex-shrink-0" />
          <span className="font-mono text-[13px] leading-none text-white/55 group-hover/fs:text-white/75 transition-colors duration-100">
            {isEdit && fs.added !== undefined ? fs.text.slice(0, fs.text.lastIndexOf(' · ')) : fs.text}
          </span>
          {isEdit && fs.added !== undefined && (
            <span data-testid="fs-pill-counts" className="font-mono text-[11px] leading-none">
              <span className="text-green-400">+{fs.added}</span> <span className="text-red-400">−{fs.removed}</span>
            </span>
          )}
          {fs.status && (
            <span className={cn('font-mono text-[11px] leading-none', fs.status === 'granted' ? 'text-green-400' : 'text-white/30')}>{fs.status}</span>
          )}
          <ChevronIcon open={expanded} className="text-white/20 group-hover/fs:text-white/35 transition-colors duration-150" />
        </button>
        <div className={cn('accordion-body', expanded && 'open')}>
          <div style={{ overflow: 'hidden', paddingTop: 6 }}>
            {showBody && isEdit && toolDiff && <DiffView diff={toolDiff} maxHeight={320} />}
            {showBody && !isEdit && hasText && (
              <pre className="font-mono text-[11px] text-white/30 leading-relaxed whitespace-pre-wrap break-all overflow-x-auto max-h-48 overflow-y-auto">
                {formattedContent}
              </pre>
            )}
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
        onClick={handleToggle}
        className="flex items-center gap-1.5 group/tc select-none"
      >
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
        <div style={{ overflow: 'hidden', paddingTop: 6 }}>
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
