/**
 * MessageBubble
 *
 * User  → right-aligned, subtle dark red/burgundy tint
 * AI    → left-aligned, transparent bg, full markdown + LaTeX + stats bar
 */

// Electron-specific <webview> JSX element
declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?:                string
          nodeintegration?:    string
          disablewebsecurity?: string
          partition?:          string
        },
        HTMLElement
      >
    }
  }
}

import { useState, useEffect, useRef, memo } from 'react'
import { Paperclip, Plug } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { StatsBar } from './StatsBar'
import { ToolCallNotification, SearchResult } from './ToolCallNotification'
import { ChevronIcon } from './ChevronIcon'
import { cn } from '../../lib/utils'
import type { GenerationStats, MessageBlock } from '../../../../shared/types'

// ── Attachment display metadata (subset of ProcessedAttachment) ──
export interface MessageAttachment {
  name: string
  type: 'image' | 'document'
}

// ── Message shape used by useChat ────────────────────────────────
export interface Message {
  id:          string
  /**
   * 'user' | 'assistant' — normal chat turns.
   * 'divider' — not a real message; renders a mode-switch label bar.
   *             Filtered out before building the LM Studio wire payload.
   */
  role:        'user' | 'assistant' | 'divider'
  content:     string
  stats:       GenerationStats | null
  isThinking:  boolean   // true before first token
  isStreaming:  boolean   // true while tokens are flowing
  isSearching:  boolean  // true while web search is in-flight
  error:       string | null
  /** Files attached to this message — shown as pills above the bubble */
  attachments?: MessageAttachment[]
  toolCall?: { query: string; results: Array<{ title: string; url: string }>; formattedContent?: string } | null
  liveToolCall?: { phase: 'searching' | 'done' | 'error'; query: string; results?: Array<{ title: string; url: string }>; formattedContent?: string; error?: string } | null
  /** v2.1 append-only block list — when present, blocks drive rendering instead of flat fields */
  blocks?: MessageBlock[]
}

// ── User bubble ──────────────────────────────────────────────────
function UserBubble({ content, attachments }: { content: string; attachments?: MessageAttachment[] }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[72%]">
        {/* Attachment pills — rendered above the text bubble */}
        {attachments && attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
            {attachments.map((a) => (
              <div
                key={a.name}
                className="bg-red-950/40 text-red-400 text-xs px-2 py-1 rounded-md flex items-center gap-1.5"
              >
                <Paperclip className="w-3 h-3 flex-shrink-0" />
                <span className="truncate max-w-[160px]">{a.name}</span>
              </div>
            ))}
          </div>
        )}
        {content.trim() && (
          <div
            className="px-4 py-3 rounded-2xl rounded-tr-sm selectable
                       text-[0.9375rem] leading-relaxed text-content-primary"
            style={{
              background: 'rgb(71 71 71 / 22%)',
            }}
          >
            <MarkdownRenderer content={content} variant="user" />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * WorkingIndicator
 *
 * Shown when the model is active but hasn't emitted the first visible
 * token yet — covers: initial thinking wait, post-tool-call processing.
 *
 * Uses a CSS text shimmer (background-clip: text on a moving gradient).
 * No Framer Motion — pure CSS animation, zero rAF overhead.
 * No cursor or trailing element — just the word "Working" with the shimmer.
 */
function WorkingIndicator() {
  return (
    <div className="py-0.5">
      <span
        className="shimmer-text font-mono text-[13px] tracking-wide"
        style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}
      >
        Working
      </span>
    </div>
  )
}

/**
 * ThinkingAccordion
 *
 * isStreaming=true  → inline shimmer "Reasoning" header + scrolling thought content
 * isStreaming=false → collapses to "Thought process › Xs" pill, toggleable
 */
function ThinkingAccordion({
  content,
  isStreaming,
  className,
  expanded,
  onToggle,
  onScrollableChange,
}: {
  content: string
  isStreaming?: boolean
  className?: string
  expanded?: boolean
  onToggle?: () => void
  onScrollableChange?: (scrollable: boolean) => void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = expanded !== undefined ? expanded : localOpen
  const [duration, setDuration] = useState<number | null>(null)
  const startedAtRef            = useRef<number>(Date.now())
  const scrollRef               = useRef<HTMLDivElement>(null)
  const contentRef              = useRef<HTMLDivElement>(null)
  const [measuredHeight, setMeasuredHeight] = useState<number>(20)
  const [showTopShadow, setShowTopShadow] = useState(false)
  const [showBottomShadow, setShowBottomShadow] = useState(false)
  const [isScrollable, setIsScrollable] = useState(false)
  const hasThoughtDuration = duration !== null && duration > 0;
  const label = hasThoughtDuration ? `Thought for ${duration}s` : 'Thought Process'

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setLocalOpen(v => !v)
    }
  }

  // Record elapsed seconds when streaming ends
  useEffect(() => {
    if (!isStreaming && duration === null) {
      setDuration(Math.round((Date.now() - startedAtRef.current) / 1000))
    }
  }, [isStreaming, duration])

  // Propagate scrollability to parent
  useEffect(() => {
    onScrollableChange?.(isScrollable)
  }, [isScrollable, onScrollableChange])

  // Measure height dynamically using ResizeObserver
  useEffect(() => {
    if ((!isStreaming && !open) || !contentRef.current) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rectHeight = Math.ceil(entry.target.getBoundingClientRect().height)
        if (isStreaming) {
          setMeasuredHeight(Math.max(20, Math.min(96, rectHeight)))
          setIsScrollable(false)
        } else {
          const naturalHeight = isScrollable ? (rectHeight - 12) : rectHeight
          const scrollable = naturalHeight > 318
          setIsScrollable(scrollable)
          if (scrollable) {
            setMeasuredHeight(330)
          } else {
            setMeasuredHeight(Math.max(20, naturalHeight))
          }
        }
      }
    })
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [isStreaming, open, isScrollable])

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [content, isStreaming])

  const updateScrollShadows = (target: HTMLDivElement) => {
    const { scrollTop, scrollHeight, clientHeight } = target
    const hasMore = scrollHeight > clientHeight
    if (!hasMore) {
      setShowTopShadow(false)
      setShowBottomShadow(false)
    } else {
      setShowTopShadow(scrollTop > 2)
      setShowBottomShadow(scrollTop + clientHeight < scrollHeight - 2)
    }
  }

  // Update scroll shadows when state or size changes
  useEffect(() => {
    if (!scrollRef.current) return
    updateScrollShadows(scrollRef.current)
  }, [open, isStreaming, measuredHeight])

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    updateScrollShadows(e.currentTarget)
  }

  const containerHeight = isStreaming ? `${measuredHeight}px` : (open ? `${measuredHeight}px` : '0px')
  const containerOpacity = (isStreaming || open) ? 1 : 0

  return (
    <div className={cn('mb-2', className)}>
      <button
        disabled={isStreaming}
        onClick={handleToggle}
        className={cn(
          "flex items-center gap-2 mb-0 py-0 text-left select-none transition-colors duration-100",
          isStreaming ? "cursor-default" : "cursor-pointer group/tp"
        )}
      >
        {isStreaming ? (
          <span
            className="shimmer-text font-mono text-[13px] leading-none font-medium text-white/45 tracking-[0.03em] select-none"
            style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}
          >
            Reasoning
          </span>
        ) : (
          <>
            <span className={`font-mono text-[13px] tracking-[0.03em] ${!hasThoughtDuration ? 'capitalize' : ''} text-white/40 group-hover/tp:text-white/60 transition-colors duration-100 leading-none`}>
              {label}
            </span>
            <ChevronIcon open={open} className="text-white/35 group-hover/tp:text-white/55 transition-colors duration-150" />
          </>
        )}
      </button>

      <div className="relative mt-1">
        {isStreaming && measuredHeight >= 96 && (
          <div
            className="pointer-events-none absolute top-0 left-0 right-0 h-6 z-10"
            style={{ background: 'linear-gradient(to bottom, #0f0f0f, transparent)' }}
          />
        )}
        {!isStreaming && open && isScrollable && (
          <>
            {/* Top scroll shadow */}
            <div
              className="pointer-events-none absolute top-0 left-0 right-0 h-12 z-10 transition-opacity duration-150"
              style={{
                background: 'linear-gradient(to bottom, #0f0f0f, transparent)',
                opacity: showTopShadow ? 1 : 0
              }}
            />
            {/* Bottom scroll shadow */}
            <div
              className="pointer-events-none absolute left-0 right-0 h-8 z-10 transition-opacity duration-150"
              style={{
                bottom: -2,
                background: 'linear-gradient(to top, #0f0f0f, transparent)',
                opacity: showBottomShadow ? 1 : 0
              }}
            />
          </>
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="font-mono text-[11px] text-white/30 leading-relaxed scrollbar-none"
          style={{
            height: containerHeight,
            opacity: containerOpacity,
            overflowY: isStreaming ? 'hidden' : (open ? 'auto' : 'hidden'),
            overflowX: 'hidden',
            transition: 'height 200ms ease-out, opacity 150ms ease-out'
          }}
        >
          <div
            ref={contentRef}
            className={cn(
              "whitespace-pre-wrap pt-[6px] selectable",
              (isStreaming || !isScrollable) ? "pb-0" : "pb-3"
            )}
          >
            {content}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── StockChartBlock ───────────────────────────────────────────────
function StockChartBlock({
  symbol,
  fileUri,
  phase,
  error,
}: {
  symbol:  string
  fileUri: string
  phase:   'loading' | 'ready' | 'error'
  error?:  string
}) {
  const wvRef = useRef<HTMLElement>(null)

  if (phase === 'error') {
    return (
      <div className="mb-2 text-[13px] text-red-400 font-mono">
        Chart unavailable for {symbol}{error ? `: ${error}` : ''}
      </div>
    )
  }
  return (
    <div
      className="mb-3 rounded-lg overflow-hidden border border-white/[0.07]"
      style={{ height: 380 }}
      onMouseLeave={() => wvRef.current?.blur()}
    >
      <webview
        ref={wvRef}
        src={fileUri}
        style={{ width: '100%', height: '100%' }}
        nodeintegration="false"
        disablewebsecurity="false"
        partition="persist:charts"
      />
    </div>
  )
}

// ── Block grouping ────────────────────────────────────────────────
// Groups consecutive done web-search blocks into merged runs.
// All other blocks pass through as single-item groups.
type SearchBlock = Extract<MessageBlock, { type: 'search' }>

type BlockGroup =
  | { kind: 'merged-search'; blocks: SearchBlock[] }
  | { kind: 'single'; block: MessageBlock; index: number }

function isWebSearchBlock(b: SearchBlock): boolean {
  if (b.toolName !== undefined) return b.toolName === 'brave_web_search'
  return !b.query.includes('__')
}

function groupBlocks(blocks: MessageBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]
    // Only merge done web-search blocks
    if (b.type === 'search' && b.phase === 'done' && isWebSearchBlock(b)) {
      const run: SearchBlock[] = []
      while (
        i < blocks.length &&
        blocks[i].type === 'search' &&
        (blocks[i] as SearchBlock).phase === 'done' &&
        isWebSearchBlock(blocks[i] as SearchBlock)
      ) {
        run.push(blocks[i] as SearchBlock)
        i++
      }
      if (run.length === 1) {
        groups.push({ kind: 'single', block: run[0], index: i - 1 })
      } else {
        groups.push({ kind: 'merged-search', blocks: run })
      }
    } else {
      groups.push({ kind: 'single', block: b, index: i })
      i++
    }
  }
  return groups
}

// ── MergedSearchGroup ─────────────────────────────────────────────
// Renders 2+ consecutive done web-search blocks as a single collapsed unit.
function MergedSearchGroup({
  blocks,
  className,
  autoCollapse,
  expanded: propExpanded,
  onToggle,
}: {
  blocks: SearchBlock[]
  className?: string
  autoCollapse?: boolean
  expanded?: boolean
  onToggle?: () => void
}) {
  const [localExpanded, setLocalExpanded] = useState(true)
  const expanded = propExpanded !== undefined ? propExpanded : localExpanded
  const totalResults = blocks.reduce((sum, b) => sum + (b.results?.length ?? 0), 0)

  const handleToggle = () => {
    if (onToggle) {
      onToggle()
    } else {
      setLocalExpanded(v => !v)
    }
  }

  useEffect(() => {
    if (autoCollapse && !onToggle) {
      setLocalExpanded(false)
    }
  }, [autoCollapse, onToggle])

  return (
    <div className={cn('mb-2', className)}>
      <button
        onClick={handleToggle}
        className="flex items-center gap-1.5 mb-0 py-0 group/sh select-none"
      >
        <span className="font-mono text-[13px] leading-none text-white/40 font-medium
                         group-hover/sh:text-white/60 transition-colors duration-100">
          Searched the web
        </span>
        <ChevronIcon open={expanded} className="text-white/20 group-hover/sh:text-white/35 transition-colors duration-150" />
        <span className="font-mono text-[13px] leading-none text-white/20">
          {totalResults} results · {blocks.length} searches
        </span>
      </button>

      <div className={cn('accordion-body', expanded && 'open')}>
        <div style={{ overflow: 'hidden', paddingTop: 6 }}>
          <div className="mt-0.5 flex flex-col gap-0">
            {blocks.map((b, idx) => (
              <div key={b.id} className={idx > 0 ? 'mt-1.5 pt-1.5 border-t border-white/[0.05]' : ''}>
                <SearchResult
                  query={b.query}
                  results={b.results ?? []}
                  isFirst={idx === 0}
                  showDot
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Rail layout helpers ───────────────────────────────────────────
function isBreakBlock(block: MessageBlock): boolean {
  return block.type === 'stock_chart' || block.type === 'answer'
}

type Segment =
  | { kind: 'rail'; blocks: MessageBlock[] }
  | { kind: 'pane'; block: MessageBlock }

function segmentBlocks(blocks: MessageBlock[]): Segment[] {
  const segments: Segment[] = []
  let railBuffer: MessageBlock[] = []

  function flushRail() {
    if (railBuffer.length > 0) {
      segments.push({ kind: 'rail', blocks: [...railBuffer] })
      railBuffer = []
    }
  }

  for (const block of blocks) {
    if (isBreakBlock(block)) {
      flushRail()
      segments.push({ kind: 'pane', block })
    } else {
      railBuffer.push(block)
    }
  }
  flushRail()
  return segments
}

function RailSegment({
  blocks,
  allBlocks,
  isStreaming,
}: {
  blocks: MessageBlock[]
  allBlocks: MessageBlock[]
  isStreaming: boolean
}) {
  // A trailing live-searching block is excluded from the gutter rail and rendered
  // as a plain WorkingIndicator below all done nodes.
  const lastBlock     = blocks[blocks.length - 1]
  const hasLiveSearch = lastBlock?.type === 'search' && (lastBlock as Extract<MessageBlock, { type: 'search' }>).phase === 'searching'
  const doneBlocks    = hasLiveSearch ? blocks.slice(0, -1) : blocks
  const groups        = groupBlocks(doneBlocks)

  const [expandedStates, setExpandedStates] = useState<Record<string, boolean>>({})
  const [scrollableStates, setScrollableStates] = useState<Record<string, boolean>>({})

  return (
    <div style={{ marginBottom: '0.5rem' }}>
      {groups.map((group, groupIdx) => {
        const isLastGroup = groupIdx === groups.length - 1

        // Determine icon type for the gutter node
        let iconType: 'thinking' | 'web-search' | 'mcp'
        if (group.kind === 'merged-search') {
          iconType = 'web-search'
        } else if (group.block.type === 'thinking') {
          iconType = 'thinking'
        } else {
          iconType = isWebSearchBlock(group.block as SearchBlock) ? 'web-search' : 'mcp'
        }

        // Node circle styles — type-default colours only
        const nodeBackground = iconType === 'mcp' ? 'rgba(229,57,53,0.08)' : 'rgba(255,255,255,0.06)'
        const nodeBorder     = iconType === 'mcp' ? '0.5px solid rgba(229,57,53,0.35)' : '0.5px solid rgba(255,255,255,0.15)'

        // Per-block props computed before render to avoid inline complexity
        const globalLastBlock = group.kind === 'merged-search'
          ? group.blocks[group.blocks.length - 1]
          : group.block
        const globalIdx    = allBlocks.indexOf(globalLastBlock)
        const hasNonSearch = allBlocks.slice(globalIdx + 1).some(b => b.type !== 'search')
        const isActiveThink = group.kind === 'single'
          && group.block.type === 'thinking'
          && isStreaming
          && group.block.id === allBlocks[allBlocks.length - 1].id

        const isThinkingBlock = group.kind === 'single' && group.block.type === 'thinking'
        const rowKey = group.kind === 'merged-search' ? group.blocks[0].id : group.block.id
        const isScrollable = scrollableStates[rowKey] ?? false

        // Compute default expanded state
        let defaultExpanded = false
        if (group.kind === 'merged-search') {
          defaultExpanded = !hasNonSearch
        } else if (group.block.type === 'thinking') {
          defaultExpanded = isActiveThink
        } else if (group.block.type === 'search') {
          const isWebSearch = isWebSearchBlock(group.block as SearchBlock)
          if (group.block.phase === 'done') {
            defaultExpanded = isWebSearch ? !hasNonSearch : false
          } else {
            defaultExpanded = false
          }
        }

        const isExpanded = expandedStates[rowKey] ?? defaultExpanded

        const handleToggle = () => {
          setExpandedStates(prev => ({
            ...prev,
            [rowKey]: !isExpanded
          }))
        }

        return (
          <div key={rowKey} className="flex" style={{ alignItems: 'stretch' }}>
            {/* Left gutter: 22px wide — icon node at top, connecting line fills height to next block */}
            <div style={{
              width: 22,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flexShrink: 0,
            }}>
              <div style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: nodeBackground,
                border: nodeBorder,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                marginTop: 0,
              }}>
                {iconType === 'thinking' && (
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'rgba(255,255,255,0.3)' }} />
                )}
                {iconType === 'web-search' && (
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                    <circle cx="3.5" cy="3.5" r="2.5" stroke="rgba(255,255,255,0.4)" strokeWidth="1"/>
                    <line x1="5.5" y1="5.5" x2="7.5" y2="7.5" stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeLinecap="round"/>
                  </svg>
                )}
                {iconType === 'mcp' && (
                  <Plug size={8} style={{ color: 'rgba(229,57,53,0.7)' }} />
                )}
              </div>
              {/* Connecting line from bottom of this icon to top of next block */}
              {!isLastGroup ? (
                <div style={{ width: 1, flex: 1, minHeight: 8, background: 'rgba(255,255,255,0.1)' }} />
              ) : isExpanded ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, width: '100%' }}>
                  <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.1)' }} />
                  <div style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: iconType === 'mcp' ? 'rgba(229,57,53,0.2)' : 'rgba(255,255,255,0.1)',
                    flexShrink: 0,
                    marginTop: 0,
                    marginBottom: 2
                  }} />
                </div>
              ) : null}
            </div>
            {/* Right body: block content sits flush with the icon */}
            <div
              style={{
                flex: 1,
                paddingLeft: 8,
                paddingTop: 2,
                minWidth: 0,
                paddingBottom: (isLastGroup && isExpanded && isThinkingBlock && isScrollable && !isStreaming)
                  ? 2
                  : ((isLastGroup && !isExpanded) ? 6 : 14)
              }}
            >
              {group.kind === 'merged-search' && (
                <MergedSearchGroup
                  blocks={group.blocks}
                  autoCollapse={hasNonSearch}
                  className="mb-0"
                  expanded={isExpanded}
                  onToggle={handleToggle}
                />
              )}
              {group.kind === 'single' && group.block.type === 'thinking' && (
                <ThinkingAccordion
                  content={group.block.content}
                  isStreaming={isActiveThink}
                  className="mb-0"
                  expanded={isExpanded}
                  onToggle={handleToggle}
                  onScrollableChange={(scrollable) => {
                    if (scrollableStates[rowKey] !== scrollable) {
                      setScrollableStates(prev => ({
                        ...prev,
                        [rowKey]: scrollable
                      }))
                    }
                  }}
                />
              )}
              {group.kind === 'single' && group.block.type === 'search' && (
                <ToolCallNotification
                  phase={group.block.phase}
                  query={group.block.query}
                  toolName={group.block.toolName}
                  results={group.block.results}
                  error={group.block.error}
                  formattedContent={group.block.formattedContent}
                  toolArgs={group.block.toolArgs}
                  toolImages={group.block.toolImages}
                  autoCollapse={hasNonSearch}
                  className="mb-0"
                  expanded={isExpanded}
                  onToggle={handleToggle}
                />
              )}
            </div>
          </div>
        )
      })}
      {/* Live search: no gutter node — plain WorkingIndicator aligned with the body column */}
      {hasLiveSearch && (
        <div style={{ paddingLeft: 30 }}>
          <WorkingIndicator />
        </div>
      )}
    </div>
  )
}

// ── Assistant bubble ─────────────────────────────────────────────
interface AssistantBubbleProps {
  content:     string
  isThinking:  boolean
  isStreaming:  boolean
  isSearching:  boolean
  stats:       GenerationStats | null
  error:       string | null
  toolCall?:     Message['toolCall']
  liveToolCall?: Message['liveToolCall']
  blocks?:       Message['blocks']
}

function AssistantBubble({
  content, isThinking, isStreaming, isSearching, stats, error, toolCall, liveToolCall, blocks
}: AssistantBubbleProps) {
  const hasBlocks = blocks && blocks.length > 0

  return (
    <div className="flex">
      {/* Content — pl-9 (2.25rem = 36px) matches the old avatar+gap width so
          message text stays left-aligned with the rest of the chat column.     */}
      <div className="flex-1 min-w-0 pb-1 pl-9">

        {hasBlocks ? (
          /* ── v2.1 block-based render path ─────────────────────── */
          <>
            {(() => {
              const segments = segmentBlocks(blocks)
              return segments.map((seg, si) => {
                if (seg.kind === 'rail') {
                  return (
                    <RailSegment
                      key={`rail-${si}`}
                      blocks={seg.blocks}
                      allBlocks={blocks}
                      isStreaming={isStreaming}
                    />
                  )
                }
                if (seg.kind === 'pane') {
                  const block = seg.block
                  if (block.type === 'stock_chart') {
                    return (
                      <StockChartBlock
                        key={block.id}
                        symbol={block.symbol}
                        fileUri={block.fileUri}
                        phase={block.phase}
                        error={block.error}
                      />
                    )
                  }
                  if (block.type === 'answer') {
                    return (
                      <div key={block.id} style={{ marginTop: '0.6rem', marginBottom: '0.8rem' }}>
                        <MarkdownRenderer
                          content={block.content}
                          isStreaming={block.isStreaming}
                        />
                      </div>
                    )
                  }
                  return null
                }
                return null
              })
            })()}

            {/* Working: pre-first-token — covers both empty blocks and when only
                a searching block is present (tool fired before first think token) */}
            {isThinking && !blocks.some(b => b.type === 'thinking' || b.type === 'answer') && <WorkingIndicator />}

            {/* Working: post-gap — streaming, no answer yet, and the last block is
                idle. "Idle" means: a done search, OR a done thinking block
                (i.e. NOT the last block which ThinkingAccordion marks as active).
                Active searches already render Working via ToolCallNotification.
                Active thinking renders Reasoning via ThinkingAccordion. */}
            {(() => {
              // Show Working when the model is active but nothing is currently
              // rendering as a loading state. Two entry conditions:
              // (a) isStreaming=true: chunks are flowing but we're between blocks
              // (b) isStreaming=false but isSearching=false and last block is a
              //     done search: tool fired before any answer tokens so isStreaming
              //     never flipped true, but model is still running
              const active = isStreaming || (!isStreaming && !isThinking && !isSearching && hasBlocks)
              if (!active) return null
              if (blocks.some(b => b.type === 'answer')) return null
              if (blocks.length === 0) return null
              const last = blocks[blocks.length - 1]
              // Active search: ToolCallNotification already shows Working
              if (last.type === 'search' && last.phase === 'searching') return null
              // Active thinking: ThinkingAccordion already shows Reasoning
              if (last.type === 'thinking') return null
              return <WorkingIndicator />
            })()}
          </>
        ) : (
          /* ── Legacy flat-field render path (old messages / fallback) ── */
          <>
            {/* Tool call notification */}
            {(liveToolCall || toolCall) && (
              <ToolCallNotification
                phase={liveToolCall?.phase ?? 'done'}
                query={liveToolCall?.query ?? toolCall!.query}
                results={liveToolCall?.results ?? toolCall?.results}
                error={liveToolCall?.error}
              />
            )}

            {/* Working indicator — covers both thinking and searching states */}
            {(isThinking || isSearching) && !content && <WorkingIndicator />}

            {/* Markdown content */}
            {content && (
              <MarkdownRenderer content={content} isStreaming={isStreaming} />
            )}
          </>
        )}

        {/* Error */}
        {error && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-red-950/30 border border-red-900/40 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Stats bar */}
        <StatsBar
          isThinking={isThinking}
          isStreaming={isStreaming && (hasBlocks ? blocks.some(b => b.type === 'answer' && b.isStreaming) : !!content)}
          stats={stats}
        />
      </div>
    </div>
  )
}

// ── Mode divider ─────────────────────────────────────────────────
function ModeDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1 select-none">
      <div className="flex-1 h-px bg-surface-border/60" />
      <span className="text-[10px] text-content-muted tracking-wide font-medium whitespace-nowrap">
        {label}
      </span>
      <div className="flex-1 h-px bg-surface-border/60" />
    </div>
  )
}

// ── Public component ─────────────────────────────────────────────
interface MessageBubbleProps {
  message: Message
}

export const MessageBubble = memo(function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'divider') {
    return <ModeDivider label={message.content} />
  }

  return (
    <div>
      {message.role === 'user'
        ? <UserBubble content={message.content} attachments={message.attachments} />
        : (
          <AssistantBubble
            content={message.content}
            isThinking={message.isThinking}
            isStreaming={message.isStreaming}
            isSearching={message.isSearching}
            stats={message.stats}
            error={message.error}
            toolCall={message.toolCall}
            liveToolCall={message.liveToolCall}
            blocks={message.blocks}
          />
        )
      }
    </div>
  )
})
