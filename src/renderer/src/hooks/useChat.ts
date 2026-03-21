/**
 * useChat — streaming chat state machine + SQLite persistence
 *
 * State transitions per assistant turn:
 *   idle → thinking → streaming → done
 *                               ↳ (aborted → done)
 *
 * The hook owns the message list, assembles streamed chunks in place,
 * persists each turn to SQLite (fire-and-forget), and exposes
 * sendMessage / abort / loadMessages to the UI.
 *
 * ── IS_MOCK detection ────────────────────────────────────────────
 * In Electron with contextIsolation:true the global `electron` object
 * is NOT injected into window, so `'electron' in window` is always
 * false even in the real app.  The reliable signal is the Chromium
 * user-agent string which Electron always appends 'Electron/x.y.z' to.
 * In a plain browser (Vite preview) that substring is absent, so we
 * fall back to the in-memory mock that main.tsx already injected.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useModelStore } from '../store/ModelStore'
import { v4 as uuid } from 'uuid'
import type { Message, MessageAttachment } from '../components/chat/MessageBubble'
import type {
  Chat,
  GenerationStats,
  ProcessedAttachment,
  WireMessage,
} from '../../../shared/types'

// ── Environment detection ────────────────────────────────────────
// True only when running in a plain browser (Vite dev / preview).
// In a packaged OR dev Electron process the UA always contains 'Electron'.
const IS_BROWSER_MOCK = !navigator.userAgent.includes('Electron')

// ── Empty assistant placeholder ──────────────────────────────────
function makeAssistant(): Message {
  return {
    id:          uuid(),
    role:        'assistant',
    content:     '',
    stats:       null,
    isThinking:  true,
    isStreaming:  false,
    isSearching:  false,
    error:       null,
  }
}

// ── Hook options ─────────────────────────────────────────────────
interface UseChatOptions {
  /** ID of the currently selected chat session (null = new unsaved session) */
  chatId?:        string | null
  /** Called when the hook auto-creates a new chat row for a fresh session */
  onChatCreated?: (chat: Chat) => void
}

export function useChat({ chatId = null, onChatCreated }: UseChatOptions = {}) {
  const [messages,    setMessages]    = useState<Message[]>([])
  const [isStreaming, setIsStreaming]  = useState(false)
  const [isSearching, setIsSearching] = useState(false)

  // Read selected model from global store so the IPC payload always carries
  // the model the user has chosen (or the default on first load).
  const { selectedModel } = useModelStore()

  // Ref so event-listener callbacks always see the latest assistant id
  const assistantIdRef = useRef<string | null>(null)

  // Tracks the active chat DB row across async boundaries.
  // Stays in sync with the `chatId` prop via useEffect.
  const currentChatIdRef = useRef<string | null>(chatId)

  // Accumulates streamed assistant content for DB persistence at stream-end.
  // A ref avoids stale-closure issues inside the event-handler useEffect.
  const streamingContentRef = useRef<string>('')

  // Keep ref in sync with whatever chatId Layout passes down.
  useEffect(() => {
    currentChatIdRef.current = chatId
  }, [chatId])

  // ── Patch the current assistant message in-place ─────────────
  const patchAssistant = useCallback((patch: Partial<Message>) => {
    const id = assistantIdRef.current
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      if (idx === -1) return prev
      const updated = [...prev]
      updated[idx] = { ...updated[idx], ...patch }
      return updated
    })
  }, [])

  // ── Register demo trigger only in browser/mock mode ───────────
  useEffect(() => {
    if (!IS_BROWSER_MOCK) return
    import('../mocks/api.mock').then(({ registerDemoTrigger }) => {
      registerDemoTrigger((text: string) => sendMessage(text))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Subscribe to streaming events from main ───────────────────
  useEffect(() => {
    const unsubChunk = window.api.onChatStreamChunk((chunk: string) => {
      // Accumulate for DB persistence
      streamingContentRef.current += chunk

      const id = assistantIdRef.current
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          content:    updated[idx].content + chunk,
          isThinking:  false,
          isStreaming:  true,
          isSearching:  false,
        }
        return updated
      })
    })

    const unsubEnd = window.api.onChatStreamEnd((stats: GenerationStats) => {
      const assistantMsgId   = assistantIdRef.current
      const assistantContent = streamingContentRef.current
      const activeChatId     = currentChatIdRef.current

      // Clear in-flight refs before any async work
      assistantIdRef.current      = null
      streamingContentRef.current = ''

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantMsgId)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          isThinking: false,
          isStreaming: false,
          isSearching: false,
          stats,
        }
        return updated
      })
      setIsStreaming(false)
      setIsSearching(false)

      // Persist assistant message to SQLite (fire-and-forget, works in both envs)
      if (activeChatId && assistantMsgId && assistantContent) {
        window.api
          .saveMessage(activeChatId, assistantMsgId, 'assistant', assistantContent)
          .catch((err) => console.warn('[DB] save assistant msg failed:', err))
      }
    })

    const unsubErr = window.api.onChatError((msg: string) => {
      const id = assistantIdRef.current
      assistantIdRef.current      = null
      streamingContentRef.current = ''
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          isThinking: false,
          isStreaming: false,
          isSearching: false,
          error: msg,
        }
        return updated
      })
      setIsStreaming(false)
      setIsSearching(false)
    })

    const unsubSearch = window.api.onWebSearchStatus((s) => {
      if (s.status === 'searching') {
        setIsSearching(true)
        patchAssistant({ isSearching: true })
      } else {
        setIsSearching(false)
        patchAssistant({ isSearching: false })
      }
    })

    return () => { unsubChunk(); unsubEnd(); unsubErr(); unsubSearch() }
  }, [patchAssistant])

  // ── Send a message ────────────────────────────────────────────
  const sendMessage = useCallback(async (
    text:            string,
    attachments?:    ProcessedAttachment[],
    /**
     * Chat ID pre-created by Layout before processFile was called.
     * When provided (first-message file-attach case), this value is used
     * directly and no new chat row is created here — Layout already did it.
     * Without this, documents would be ingested with chat_id = NULL and
     * the SQL filter in retrieveContext would return zero rows.
     */
    overrideChatId?: string
  ) => {
    if (isStreaming) return

    // Map ProcessedAttachment → lightweight display metadata for the Message type.
    // Stored separately from content so they survive chat history round-trips.
    const msgAttachments: MessageAttachment[] | undefined =
      attachments && attachments.length > 0
        ? attachments.map((a) => ({ name: a.name, type: a.kind }))
        : undefined

    const userMsg: Message = {
      id:          uuid(),
      role:        'user',
      content:     text,
      stats:       null,
      isThinking:  false,
      isStreaming:  false,
      isSearching:  false,
      error:       null,
      attachments: msgAttachments,
    }

    const assistantMsg = makeAssistant()
    assistantIdRef.current      = assistantMsg.id
    streamingContentRef.current = ''

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    // ── Ensure a chat row exists in SQLite before we stream ───────
    // activeChatId is declared at function scope (NOT inside a bare {} block)
    // so it is accessible both to saveMessage below AND to sendChatMessage.
    let activeChatId = overrideChatId ?? currentChatIdRef.current

    if (overrideChatId && !currentChatIdRef.current) {
      // Chat was pre-created by Layout (first-message file-attach case).
      // Sync the ref immediately so the stream-end persistence handler
      // writes the assistant reply to the correct chat.
      // We do NOT call onChatCreated here — Layout already did it.
      currentChatIdRef.current = overrideChatId
      console.log(`[Chat] Using pre-created chat id=${overrideChatId}`)
    } else if (!activeChatId) {
      // Text-only first message — create the DB row now.
      const newId = uuid()
      const title = text.slice(0, 80).trim() || 'New Chat'
      try {
        const chat = await window.api.newChat(newId, title)
        // Update the ref immediately so the stream-end handler can use it.
        currentChatIdRef.current = chat.id
        activeChatId             = chat.id
        console.log(`[Chat] Created new chat row: id=${chat.id}, title="${chat.title}"`)
        // Notify Layout to (a) set activeChatId and (b) refresh the sidebar.
        onChatCreated?.(chat)
      } catch (err) {
        console.warn('[DB] newChat failed:', err)
      }
    }

    // Persist user message with attachment metadata.
    // attachmentsJson is null for text-only messages.
    const attachmentsJson = msgAttachments
      ? JSON.stringify(msgAttachments)
      : null

    if (activeChatId) {
      window.api
        .saveMessage(activeChatId, userMsg.id, 'user', text, attachmentsJson)
        .catch((err) => console.warn('[DB] save user msg failed:', err))
    }

    // Build wire messages from current history + new user message
    const wire: WireMessage[] = [...messages, userMsg].map((m) => ({
      role:    m.role,
      content: m.content,
    }))

    try {
      await window.api.sendChatMessage({
        messages:    wire,
        attachments: attachments?.length ? attachments : undefined,
        // activeChatId is guaranteed non-null here — either it was set before
        // this call, or it was just created in the block above. Passing it
        // scopes RAG retrieval in the main process to this chat only.
        chatId:      activeChatId ?? undefined,
        // Frontend dictates the model — the main process reads this from the
        // payload and injects it into the LM Studio request dynamically.
        model:       selectedModel,
      })
    } catch (err) {
      patchAssistant({
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        error: err instanceof Error ? err.message : String(err),
      })
      setIsStreaming(false)
      setIsSearching(false)
      assistantIdRef.current      = null
      streamingContentRef.current = ''
    }
  }, [isStreaming, messages, patchAssistant, onChatCreated, selectedModel])

  // ── Abort ─────────────────────────────────────────────────────
  const abort = useCallback(() => {
    window.api.abortChat()
    // Stats will arrive via onChatStreamEnd with aborted: true
  }, [])

  // ── Load messages (used when switching chat sessions) ─────────
  // Does NOT touch currentChatIdRef — Layout updates chatId prop,
  // and the useEffect above syncs the ref after the re-render.
  const loadMessages = useCallback((msgs: Message[]) => {
    setMessages(msgs)
    setIsStreaming(false)
    setIsSearching(false)
    assistantIdRef.current      = null
    streamingContentRef.current = ''
  }, [])

  // ── Clear conversation (New Chat button) ──────────────────────
  // Resets all in-flight refs INCLUDING currentChatIdRef so the next
  // sendMessage creates a fresh DB row rather than appending to the
  // previous chat.
  const clearMessages = useCallback(() => {
    if (isStreaming) window.api.abortChat()
    setMessages([])
    setIsStreaming(false)
    setIsSearching(false)
    assistantIdRef.current      = null
    streamingContentRef.current = ''
    // Reset the chat ID ref now; the useEffect([chatId]) will also run
    // once Layout sets activeChatId → null, but resetting here prevents
    // any async handler from writing to the wrong chat in the interim.
    currentChatIdRef.current    = null
  }, [isStreaming])

  return {
    messages,
    isStreaming,
    isSearching,
    sendMessage,
    abort,
    loadMessages,
    clearMessages,
  }
}
