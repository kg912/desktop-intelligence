import { useRef, useEffect } from 'react'
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
            Qwen Studio
          </h1>
          <p className="text-sm text-content-tertiary mt-1">
            Local intelligence, zero latency
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

export function ChatArea({ messages, isStreaming = false, onSuggest }: ChatAreaProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll on every content change.
  // During active streaming use 'instant' so rapid chunk updates don't
  // stutter — the browser cancels-and-restarts a 'smooth' scroll on
  // every invocation, making it look frozen until the stream ends.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: isStreaming ? 'instant' : 'smooth',
      block:    'end',
    })
  }, [messages.length, messages[messages.length - 1]?.content, isStreaming])

  const hasMessages = messages.length > 0

  return (
    <div className="flex-1 overflow-y-auto relative no-drag">
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
}
