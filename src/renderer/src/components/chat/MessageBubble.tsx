/**
 * MessageBubble
 *
 * User  → right-aligned, subtle dark red/burgundy tint
 * AI    → left-aligned, transparent bg, full markdown + LaTeX + stats bar
 */

import { useState, useEffect, useRef, memo } from 'react'
import { User, Paperclip } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { StatsBar } from './StatsBar'
import { ToolCallNotification } from './ToolCallNotification'
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
    <div className="flex justify-end gap-3">
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
              background: 'rgba(127,29,29,0.22)',
              border: '1px solid rgba(127,29,29,0.35)',
            }}
          >
            <MarkdownRenderer content={content} variant="user" />
          </div>
        )}
      </div>
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-DEFAULT border border-surface-border
                      flex items-center justify-center mt-1">
        <User className="w-3.5 h-3.5 text-content-tertiary" />
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
}: {
  content: string
  isStreaming?: boolean
  className?: string
}) {
  const [open, setOpen]         = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  const startedAtRef            = useRef<number>(Date.now())
  const scrollRef               = useRef<HTMLDivElement>(null)

  // Record elapsed seconds when streaming ends
  useEffect(() => {
    if (!isStreaming && duration === null) {
      setDuration(Math.round((Date.now() - startedAtRef.current) / 1000))
    }
  }, [isStreaming, duration])

  // Auto-scroll to bottom while streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [content, isStreaming])

  // ── Active: shimmer header + scrolling content ──
  if (isStreaming) {
    return (
      <div className={cn('mb-3 border-l border-white/[0.07] pl-3', className)}>
        <div className="flex items-center gap-1.5 h-5 mb-1.5">
          <span
            className="shimmer-text font-mono text-[11px] tracking-[0.06em] uppercase"
            style={{ fontFamily: "'SF Mono', 'Fira Code', ui-monospace, monospace" }}
          >
            Reasoning
          </span>
        </div>
        <div className="relative">
          <div
            className="pointer-events-none absolute top-0 left-0 right-0 h-6 z-10"
            style={{ background: 'linear-gradient(to bottom, #0f0f0f, transparent)' }}
          />
          <div
            ref={scrollRef}
            className="max-h-[96px] overflow-hidden font-mono text-[11px] text-white/30 leading-relaxed whitespace-pre-wrap"
          >
            {content || '…'}
          </div>
        </div>
      </div>
    )
  }

  // ── Collapsed pill ──
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-2 mb-2 py-0.5 group/tp',
          'text-left cursor-pointer select-none',
          className
        )}
      >
        <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-white/40 group-hover/tp:text-white/60 transition-colors duration-100">
          Thought process
        </span>
        <span className="text-white/35 group-hover/tp:text-white/55 transition-colors duration-100 text-[11px]">›</span>
        {duration !== null && (
          <span className="font-mono text-[10px] text-white/25">
            {duration}s
          </span>
        )}
      </button>
    )
  }

  // ── Expanded ──
  return (
    <div className={cn('mb-2', className)}>
      <button
        onClick={() => setOpen(false)}
        className="flex items-center gap-2 mb-1 py-0.5 group/tp text-left cursor-pointer select-none"
      >
        <span className="font-mono text-[11px] tracking-[0.06em] uppercase text-white/40 group-hover/tp:text-white/60 transition-colors duration-100">
          Thought process
        </span>
        <span className="text-white/35 group-hover/tp:text-white/55 transition-colors duration-100 text-[11px] inline-block rotate-90">›</span>
        {duration !== null && (
          <span className="font-mono text-[10px] text-white/25">
            {duration}s
          </span>
        )}
      </button>
      <div className="border-l border-white/[0.08] pl-3">
        <div className="font-mono text-[11px] text-white/30 leading-relaxed whitespace-pre-wrap selectable">
          {content}
        </div>
      </div>
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
            {blocks.map((block, i) => {
              if (block.type === 'search') {
                const prevIsAnswer = i > 0 && blocks[i - 1].type === 'answer'
                return (
                  <ToolCallNotification
                    key={block.id}
                    phase={block.phase}
                    query={block.query}
                    toolName={block.toolName}
                    results={block.results}
                    error={block.error}
                    formattedContent={block.formattedContent}
                    toolArgs={block.toolArgs}
                    toolImages={block.toolImages}
                    className={prevIsAnswer ? 'mt-3' : ''}
                  />
                )
              }
              if (block.type === 'thinking') {
                const prevIsAnswer = i > 0 && blocks[i - 1].type === 'answer'
                return (
                  <ThinkingAccordion
                    key={block.id}
                    content={block.content}
                    isStreaming={isStreaming && block.id === blocks[blocks.length - 1].id}
                    className={prevIsAnswer ? 'mt-3' : ''}
                  />
                )
              }
              if (block.type === 'answer') {
                return (
                  <MarkdownRenderer
                    key={block.id}
                    content={block.content}
                    isStreaming={block.isStreaming}
                  />
                )
              }
              return null
            })}

            {/* Working indicator while waiting for the very first block */}
            {isThinking && <WorkingIndicator />}

            {/* Post-tool-call gap: search block(s) exist but answer hasn't started yet */}
            {!isThinking && isStreaming && hasBlocks && !blocks.some(b => b.type === 'answer') && (
              <WorkingIndicator />
            )}
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
