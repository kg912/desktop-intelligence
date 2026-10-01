/**
 * PrintChatView — rendered instead of the normal Layout when the app is
 * loaded with `?print=<chatId>` inside the hidden export BrowserWindow
 * (see handlers.ts CHAT_EXPORT_PDF). Mounts every message for the chat
 * unvirtualized, using the same MessageBubble / MarkdownRenderer components
 * as the live app so Mermaid diagrams and ECharts plots render for real
 * instead of being screenshotted mid-scroll.
 *
 * Readiness: Mermaid/ECharts/Matplotlib/SVG blocks all show a `.animate-spin`
 * loading indicator while their async render is pending (see
 * MarkdownRenderer.tsx). Polling for that class to disappear — rather than a
 * fixed timeout — is what lets notifyPrintReady() fire as soon as the page
 * has actually finished drawing, with the main process's own hard timeout as
 * a backstop if a chart never settles.
 */
import { useEffect, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { MessageBubble } from './MessageBubble'
import type { Message } from './MessageBubble'
import { ChatIdCtx } from '../layout/ChatArea'
import type { Chat, StoredMessage } from '../../../../shared/types'

interface PrintChatViewProps {
  chatId: string
}

const POLL_MS         = 200
const REQUIRED_STABLE = 2      // consecutive zero-spinner checks before we call it settled
const MAX_WAIT_MS     = 3500   // local cap — main process also enforces a 4000ms hard fallback

export function PrintChatView({ chatId }: PrintChatViewProps) {
  const [chat, setChat]         = useState<Chat | null>(null)
  const [messages, setMessages] = useState<Message[] | null>(null)
  const containerRef            = useRef<HTMLDivElement>(null)
  const readySentRef            = useRef(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.getChats(), window.api.getChatMessages(chatId)])
      .then(([chats, stored]: [Chat[], StoredMessage[]]) => {
        if (cancelled) return
        setChat(chats.find((c) => c.id === chatId) ?? null)
        const msgs: Message[] = stored.map((wm) => ({
          id:          uuid(),
          role:        wm.role as 'user' | 'assistant',
          content:     wm.content,
          attachments: wm.attachmentsJson ? JSON.parse(wm.attachmentsJson) : undefined,
          toolCall:    wm.toolCallJson    ? JSON.parse(wm.toolCallJson)    : undefined,
          blocks:      wm.blocksJson      ? JSON.parse(wm.blocksJson)      : undefined,
          stats:       null,
          isThinking:  false,
          isStreaming: false,
          isSearching: false,
          error:       null,
        }))
        setMessages(msgs)
      })
      .catch((err) => {
        console.error('[PrintChatView] Failed to load chat:', err)
        if (!cancelled) setMessages([])
      })
    return () => { cancelled = true }
  }, [chatId])

  // Poll for pending chart/diagram renders, then signal the main process.
  useEffect(() => {
    if (messages === null || readySentRef.current) return

    let cancelled     = false
    let stableChecks   = 0
    const start        = Date.now()
    let timer: ReturnType<typeof setTimeout>

    function poll(): void {
      if (cancelled || readySentRef.current) return
      const pending = containerRef.current?.querySelectorAll('.animate-spin').length ?? 0
      stableChecks = pending === 0 ? stableChecks + 1 : 0

      if (stableChecks >= REQUIRED_STABLE || Date.now() - start >= MAX_WAIT_MS) {
        readySentRef.current = true
        window.api.notifyPrintReady()
        return
      }
      timer = setTimeout(poll, POLL_MS)
    }

    // Let the DOM commit before the first spinner check.
    const raf = requestAnimationFrame(() => { timer = setTimeout(poll, POLL_MS) })
    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(timer) }
  }, [messages])

  if (messages === null) return null

  return (
    <ChatIdCtx.Provider value={chatId}>
      <div
        ref={containerRef}
        className="print-chat-view"
        style={{ background: '#0f0f0f', minHeight: '100vh' }}
      >
        <div className="max-w-[55rem] mx-auto px-6 py-8 space-y-6">
          <h1 className="text-[15px] font-semibold text-content-primary mb-2">
            {chat?.title ?? 'Chat'}
          </h1>
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>
      </div>
      {/* Print-specific overrides — the app shell's html/body/#root
          height:100% + overflow:hidden (globals.css) would clip the PDF to one
          window height; no scroll containers, no clipped content,
          chart/code cards never split across a page break. */}
      <style>{`
        html, body, #root {
          height: auto !important;
          overflow: visible !important;
        }
        .print-chat-view .overflow-y-auto,
        .print-chat-view .overflow-x-auto {
          overflow: visible !important;
          max-height: none !important;
        }
        .print-chat-view pre,
        .print-chat-view .diagram-block,
        .print-chat-view .rounded-xl.overflow-hidden {
          break-inside: avoid;
        }
      `}</style>
    </ChatIdCtx.Provider>
  )
}
