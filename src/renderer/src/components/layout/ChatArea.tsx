import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { MessageBubble } from '../chat/MessageBubble'
import type { Message } from '../chat/MessageBubble'

// ----------------------------------------------------------------
// Empty state — CSS animations so they work in all environments
// ----------------------------------------------------------------
const SUGGESTIONS = [
  'Explain the math behind transformer self-attention',
  'Write a Rust async file watcher using tokio',
  'Compare RLHF vs DPO for fine-tuning LLMs',
  'Design a RAG pipeline for a 10M-document corpus',
]

function EmptyState({ onSuggest }: { onSuggest: (s: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-8 select-none">
      {/* Hero — CSS fade-in, no Framer Motion initial:0 */}
      <div className="mb-8 flex flex-col items-center gap-4 animate-fade-in">
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #1a0a0a 0%, #2d0a0a 100%)',
            boxShadow: '0 0 32px rgba(139,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.04)'
          }}
        >
          <Sparkles className="w-6 h-6 text-accent-500" />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold text-content-primary tracking-tight">
            Desktop Intelligence
          </h1>
          <p className="text-sm text-content-tertiary mt-1">
            Local Inference. Zero Latency.
          </p>
        </div>
      </div>

      {/* Suggestion grid */}
      <div className="grid grid-cols-2 gap-2 w-full max-w-xl animate-slide-up">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={i}
            onClick={() => onSuggest(s)}
            style={{ animationDelay: `${i * 60}ms` }}
            className="text-left px-4 py-3 rounded-xl animate-fade-in
                       bg-surface-DEFAULT hover:bg-surface-hover active:bg-surface-active
                       border border-surface-border hover:border-surface-border/80
                       text-[13px] text-content-secondary hover:text-content-primary
                       transition-all duration-150 leading-snug
                       focus:outline-none focus:ring-1 focus:ring-accent-900/50
                       no-drag"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// ChatArea
// ----------------------------------------------------------------
interface ChatAreaProps {
  messages:    Message[]
  isStreaming?: boolean
  onSuggest?:  (text: string) => void
}

export interface ChatAreaHandle {
  /** Immediately snap to the bottom of the message list. */
  scrollToBottom: () => void
}

export const ChatArea = forwardRef<ChatAreaHandle, ChatAreaProps>(
function ChatArea({ messages, isStreaming = false, onSuggest }, ref) {
  const bottomRef          = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // true  = user has scrolled up, auto-scroll is paused
  // false = we are at (or near) the bottom, auto-scroll is active
  // Stored in a ref so toggling it never causes a re-render.
  const userScrolledUp = useRef(false)

  // Guards against handleScroll falsely re-enabling auto-scroll when an
  // onScroll event is fired by our own scrollIntoView call rather than by
  // actual user interaction.  Set to true just before each programmatic
  // scroll; cleared by the first onScroll handler invocation that follows.
  const isProgrammaticScroll = useRef(false)

  // ── Imperative handle — lets Layout snap to bottom before async send ──
  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      userScrolledUp.current     = false
      isProgrammaticScroll.current = true
      bottomRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
    },
  }))

  // ── Re-enable scroll whenever the USER sends a new message ──────
  // (their message is always the last one added with role 'user')
  useEffect(() => {
    const last = messages[messages.length - 1]
    if (last?.role === 'user') {
      userScrolledUp.current = false
    }
  }, [messages.length])

  // ── Auto-scroll on every content change — unless paused ─────────
  // During active streaming use 'instant' so rapid chunk updates don't
  // stutter — the browser cancels-and-restarts a 'smooth' scroll on
  // every invocation, making it look frozen until the stream ends.
  useEffect(() => {
    if (userScrolledUp.current) return
    isProgrammaticScroll.current = true        // mark: next onScroll is ours
    bottomRef.current?.scrollIntoView({
      behavior: isStreaming ? 'instant' : 'smooth',
      block:    'end',
    })
  }, [
    messages.length,
    messages[messages.length - 1]?.content,
    messages[messages.length - 1]?.isSearching,
    messages[messages.length - 1]?.isThinking,
    isStreaming,
  ])

  // ── Pause auto-scroll when user scrolls UP ───────────────────────
  // onWheel fires for real trackpad / mouse-wheel gestures only; it does
  // NOT fire for programmatic scrollIntoView calls, which is exactly what
  // we want — this handler is the primary "pause" trigger.
  function handleWheel(e: React.WheelEvent) {
    if (e.deltaY < 0) {          // negative deltaY = scroll toward top
      userScrolledUp.current = true
    }
  }

  // ── Re-enable auto-scroll when user scrolls back to the bottom ──
  // We skip any onScroll event that was caused by our own scrollIntoView
  // so that programmatic scrolls never accidentally clear userScrolledUp.
  // Only genuine user-driven scrolls are evaluated here.
  function handleScroll() {
    // Absorb the one onScroll that every scrollIntoView fires and return.
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false
      return
    }
    // Already at the bottom — nothing to re-enable, skip the layout read.
    if (!userScrolledUp.current) return
    const el = scrollContainerRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    // 150 px of slack: re-enable once the user is clearly back near the
    // live output, without requiring pixel-perfect positioning.
    if (distanceFromBottom <= 150) {
      userScrolledUp.current = false
    }
  }

  const hasMessages = messages.length > 0

  return (
    <div
      ref={scrollContainerRef}
      onWheel={handleWheel}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto relative no-drag"
    >
      <AnimatePresence mode="wait">
        {!hasMessages ? (
          <motion.div
            key="empty"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="h-full"
          >
            <EmptyState onSuggest={onSuggest ?? (() => {})} />
          </motion.div>
        ) : (
          <div key="messages" className="max-w-3xl mx-auto px-6 py-8">
            <div className="space-y-6">
              <AnimatePresence initial={false}>
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} message={msg} />
                ))}
              </AnimatePresence>
            </div>
            <div ref={bottomRef} className="h-4" />
          </div>
        )}
      </AnimatePresence>
    </div>
  )
})
