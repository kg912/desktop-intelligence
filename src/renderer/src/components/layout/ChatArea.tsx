import { useRef, useEffect, forwardRef, useImperativeHandle, createContext } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MessageBubble } from '../chat/MessageBubble'
import { CompactToast } from '../chat/CompactToast'
import { useModelStore } from '../../store/ModelStore'
import logoWelcome from '../../assets/logo-welcome.png'
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
        <img
          src={logoWelcome}
          alt="Desktop Intelligence"
          className="w-14 h-14"
          draggable={false}
        />
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
  messages:     Message[]
  isStreaming?: boolean
  activeChatId: string | null
  onSuggest?:   (text: string) => void
}

export const ChatIdCtx = createContext<string | null>(null)

export interface ChatAreaHandle {
  /** Immediately snap to the bottom of the message list. */
  scrollToBottom: () => void
}

export const ChatArea = forwardRef<ChatAreaHandle, ChatAreaProps>(
function ChatArea({ messages, isStreaming = false, activeChatId, onSuggest }, ref) {
  const { compactToast } = useModelStore()
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

  // ── Re-enable scroll AND snap to bottom when the user sends a message ──
  // sendMessage inserts both the user message AND the assistant placeholder
  // in a single setMessages call, so after the state update the last message
  // is the empty assistant placeholder (role 'assistant'), not the user message.
  // Detecting the placeholder (empty content + isThinking=true) fires exactly
  // once per send, immediately when it appears, before any streaming output.
  useEffect(() => {
    const last       = messages[messages.length - 1]
    const secondLast = messages[messages.length - 2]
    if (
      last?.role === 'assistant' &&
      last?.content === '' &&
      last?.isThinking === true &&
      secondLast?.role === 'user'
    ) {
      userScrolledUp.current = false
      // Scroll the container directly rather than using bottomRef.scrollIntoView.
      // bottomRef lives inside the messages div, which AnimatePresence (mode="wait")
      // does not mount until the empty-state exit animation finishes (~150ms).
      // During that window bottomRef.current is null and scrollIntoView does nothing.
      // scrollContainerRef is always mounted — it is the outermost div and never
      // unmounts.  Setting scrollTop = scrollHeight is synchronous and reliable.
      // Double-rAF ensures execution after both the React commit phase AND the
      // browser layout/paint, so scrollHeight reflects the newly added messages.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current
          if (el) {
            isProgrammaticScroll.current = true
            el.scrollTop = el.scrollHeight
          }
        })
      })
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
    // Use 20% of the visible container height as the re-enable threshold.
    // This is zoom-independent: scrolling to within the bottom 20% of the
    // visible area re-enables auto-scroll regardless of OS/browser zoom level.
    // Capped at 300px so very tall monitors don't create an oversized zone.
    const threshold = Math.min(el.clientHeight * 0.20, 300)
    if (distanceFromBottom <= threshold) {
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
      {/* Compaction result toast */}
      <AnimatePresence>
        {compactToast && (
          <CompactToast
            tokensBefore={compactToast.tokensBefore}
            tokensAfter={compactToast.tokensAfter}
            hasDocuments={compactToast.hasDocuments}
          />
        )}
      </AnimatePresence>

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
          <div key="messages" className="max-w-[55rem] mx-auto px-6 py-8">
            <ChatIdCtx.Provider value={activeChatId}>
              <div className="space-y-6">
                <AnimatePresence initial={false}>
                  {messages.map((msg) => (
                    <MessageBubble key={msg.id} message={msg} />
                  ))}
                </AnimatePresence>
              </div>
            </ChatIdCtx.Provider>
            <div ref={bottomRef} className="h-4" />
          </div>
        )}
      </AnimatePresence>
    </div>
  )
})
