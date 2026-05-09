import { useRef, useEffect, forwardRef, useImperativeHandle, createContext } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useSignals, useSignalEffect } from '@preact/signals-react/runtime'
import { useVirtualizer } from '@tanstack/react-virtual'
import { MessageBubble } from '../chat/MessageBubble'
import { CompactToast } from '../chat/CompactToast'
import { useModelStore } from '../../store/ModelStore'
import { streamingBlocks, completedMessages, streamingMessage } from '../../signals/chatSignals'
import logoWelcome from '../../assets/logo-welcome.png'

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
            One Interface. Every model.
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
  activeChatId: string | null
  onSuggest?:   (text: string) => void
}

export const ChatIdCtx = createContext<string | null>(null)

export interface ChatAreaHandle {
  /** Immediately snap to the bottom of the message list. */
  scrollToBottom: () => void
}

export const ChatArea = forwardRef<ChatAreaHandle, ChatAreaProps>(
function ChatArea({ activeChatId, onSuggest }, ref) {
  useSignals()
  const { compactToast } = useModelStore()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const completedMsgs = completedMessages.value
  const streamingMsg  = streamingMessage.value
  const messages      = streamingMsg ? [...completedMsgs, streamingMsg] : completedMsgs
  const hasMessages   = messages.length > 0

  // ── Virtualizer ──────────────────────────────────────────────
  // Replaces the flat messages.map() with a virtual list so only
  // the visible (plus overscan) rows are in the DOM. This eliminates
  // the scroll-freeze on M1 Pro caused by hundreds of MessageBubble
  // DOM nodes.
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 200,
    overscan: 3,
  })

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
      userScrolledUp.current       = false
      isProgrammaticScroll.current = true
      const el = scrollContainerRef.current
      if (el) el.scrollTop = el.scrollHeight
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
      // unmounts.  Setting scrollTop = virtualizer.getTotalSize() is synchronous
      // and reliable because the inner messages div has height = getTotalSize().
      // Double-rAF ensures execution after both the React commit phase AND the
      // browser layout/paint, so the virtualizer has updated its total size.
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

  // ── Auto-scroll on streaming block updates — unless paused ──────
  // useSignalEffect subscribes to streamingBlocks so it fires on every rAF
  // tick during token streaming without needing a React re-render. This
  // replaces the old useEffect([messages[last].content, ...]) dep array,
  // which required a full re-render before scroll could fire.
  const scrollRafRef = useRef<number | null>(null)
  useSignalEffect(() => {
    void streamingBlocks.value  // subscribe: fires on every block update
    if (userScrolledUp.current) return
    if (scrollRafRef.current !== null) return  // already scheduled this frame
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      if (userScrolledUp.current) return
      const el = scrollContainerRef.current
      if (el) {
        isProgrammaticScroll.current = true
        el.scrollTop = el.scrollHeight
      }
    })
  })

  // ── Re-measure streaming message height on every block change ────
  // During streaming the last message grows on every token.  The virtualizer
  // caches the measured height; if we don't force a re-measure it uses the
  // stale height from the first measurement and the scroll position drifts.
  // This effect fires on every blocks-array change of the last message and
  // calls virtualizer.measureElement to update the cached size immediately.
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (lastMsg?.isStreaming) {
      const idx = messages.length - 1
      const el = scrollContainerRef.current?.querySelector(`[data-index="${idx}"]`)
      if (el) virtualizer.measureElement(el)
    }
  }, [messages[messages.length - 1]?.blocks, messages[messages.length - 1]?.content])

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
          <div
            key="messages"
            className="max-w-[55rem] mx-auto px-6 py-8"
            style={{ position: 'relative', height: virtualizer.getTotalSize() }}
          >
            <ChatIdCtx.Provider value={activeChatId}>
              {virtualizer.getVirtualItems().map((virtualItem) => (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: '24px',
                  }}
                >
                  <MessageBubble message={messages[virtualItem.index]} />
                </div>
              ))}
            </ChatIdCtx.Provider>
          </div>
        )}
      </AnimatePresence>
    </div>
  )
})
