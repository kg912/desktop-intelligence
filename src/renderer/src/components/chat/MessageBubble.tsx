/**
 * MessageBubble
 *
 * User  → right-aligned, subtle dark red/burgundy tint
 * AI    → left-aligned, transparent bg, full markdown + LaTeX + stats bar
 */

import { motion } from 'framer-motion'
import { Sparkles, User, Globe, Paperclip } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { StatsBar } from './StatsBar'
import { ToolCallNotification } from './ToolCallNotification'
import { cn } from '../../lib/utils'
import type { GenerationStats } from '../../../../shared/types'

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
}

// ── Animation variant ────────────────────────────────────────────
const bubbleVariants = {
  initial: { opacity: 1, y: 0, scale: 1 },
  animate: { opacity: 1, y: 0, scale: 1 }
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
      </div>
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-DEFAULT border border-surface-border
                      flex items-center justify-center mt-1">
        <User className="w-3.5 h-3.5 text-content-tertiary" />
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
}

function AssistantBubble({
  content, isThinking, isStreaming, isSearching, stats, error, toolCall, liveToolCall
}: AssistantBubbleProps) {
  return (
    <div className="flex gap-3">
      {/* AI avatar */}
      <div className="flex-shrink-0 mt-1">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #1a0a0a 0%, #2d0a0a 100%)',
            border: '1px solid rgba(127,29,29,0.4)',
            boxShadow: isThinking || isStreaming
              ? '0 0 10px rgba(220,38,38,0.3)'
              : 'none'
          }}
        >
          <Sparkles
            className={cn(
              'w-3.5 h-3.5',
              isThinking || isStreaming ? 'text-accent-400' : 'text-accent-700'
            )}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-1">
        {/* Tool call notification */}
        {(liveToolCall || toolCall) && (
          <ToolCallNotification
            phase={liveToolCall?.phase ?? 'done'}
            query={liveToolCall?.query ?? toolCall!.query}
            results={liveToolCall?.results ?? toolCall?.results}
            error={liveToolCall?.error}
          />
        )}

        {/* Searching the web indicator */}
        {isSearching && !content && (
          <div className="flex items-center gap-2 py-1.5 text-content-muted text-xs">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
            >
              <Globe className="w-3.5 h-3.5 text-accent-500" />
            </motion.div>
            <span>Searching the web…</span>
          </div>
        )}

        {/* Thinking state — empty content placeholder */}
        {isThinking && !isSearching && !content && (
          <div className="flex items-center gap-2 py-1.5">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="block w-2 h-2 rounded-full bg-accent-700"
                animate={{ opacity: [0.3, 1, 0.3], scale: [0.8, 1.15, 0.8] }}
                transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.2 }}
                style={{ boxShadow: '0 0 5px rgba(220,38,38,0.5)' }}
              />
            ))}
          </div>
        )}

        {/* Markdown content */}
        {content && (
          <MarkdownRenderer content={content} isStreaming={isStreaming} />
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
          isStreaming={isStreaming && !!content}
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

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === 'divider') {
    return <ModeDivider label={message.content} />
  }

  return (
    <motion.div
      variants={bubbleVariants}
      initial="initial"
      animate="animate"
      layout="position"
    >
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
          />
        )
      }
    </motion.div>
  )
}
