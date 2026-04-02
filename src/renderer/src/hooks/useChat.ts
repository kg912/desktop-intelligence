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
  const [liveToolCall, setLiveToolCall] = useState<Message['liveToolCall']>(null)

  // Read selected model and thinking mode from global store.
  const { selectedModel, thinkingMode } = useModelStore()

  // Ref so event-listener callbacks always see the latest assistant id
  const assistantIdRef = useRef<string | null>(null)

  // Ref to track the live tool call state inside event-handler closures
  const liveToolCallRef = useRef<Message['liveToolCall']>(null)

  // Think-block timeout: records when the first chunk arrived.
  // If the think block is still unclosed after 45 s the UI would hang showing
  // "Thinking…" forever.  ChatService has repetition detection, but this is a
  // belt-and-suspenders guard in the renderer.
  const thinkStartedAt = useRef<number | null>(null)

  // Tracks the active chat DB row across async boundaries.
  // Stays in sync with the `chatId` prop via useEffect.
  const currentChatIdRef = useRef<string | null>(chatId)

  // Accumulates streamed assistant content for DB persistence at stream-end.
  // A ref avoids stale-closure issues inside the event-handler useEffect.
  const streamingContentRef = useRef<string>('')

  // Set to the retracted content when CHAT_STREAM_RETRACT fires.
  // The next chunk handler reads this, resets streamingContentRef to the
  // retracted baseline, then clears the flag — preventing React 18 automatic-
  // batching stale-closure race where a chunk arriving in the same microtask
  // as the retract would append to the un-retracted prev.content.
  const retractedContentRef = useRef<string | null>(null)

  // Tracks the thinking mode used for the previous turn so a divider can be
  // inserted into the message list when the user switches modes mid-conversation.
  const prevThinkingModeRef = useRef<'thinking' | 'fast'>('fast')

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
      // If a RETRACT fired, reset streamingContentRef to the clean retracted
      // baseline before appending this chunk. This prevents the React 18
      // automatic-batching race where a chunk in the same microtask queue as
      // the retract would read stale prev.content and append to dirty content.
      if (retractedContentRef.current !== null) {
        streamingContentRef.current = retractedContentRef.current
        retractedContentRef.current = null
      }

      // Accumulate for DB persistence
      streamingContentRef.current += chunk

      // Start the think-block timer on the first chunk
      if (thinkStartedAt.current === null) {
        thinkStartedAt.current = Date.now()
      }

      const id = assistantIdRef.current
      // Use streamingContentRef as the content source rather than appending
      // chunk to prev.content — eliminates stale-closure issues after retract.
      const fullContent = streamingContentRef.current
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          content:     fullContent,
          isThinking:  false,
          isStreaming:  true,
          isSearching:  false,
        }
        return updated
      })

      // Safety net: if the think block has been open for > 45 s without closing,
      // the model is likely stuck or hit max_tokens mid-thought.  Force-close the
      // streaming state so parseThinkBlocks(content, streamEnded=true) recovers.
      // ChatService's repetition detector is the primary guard; this handles cases
      // where the model emits varied content slowly without repeating.
      if (
        thinkStartedAt.current !== null &&
        streamingContentRef.current.includes('<think>') &&
        !streamingContentRef.current.includes('</think>') &&
        Date.now() - thinkStartedAt.current > 45_000
      ) {
        console.warn('[useChat] ⏱ Think block timeout — forcing stream end')
        window.api.abortChat()
      }
    })

    const unsubEnd = window.api.onChatStreamEnd((stats: GenerationStats) => {
      const assistantMsgId   = assistantIdRef.current
      const assistantContent = streamingContentRef.current
      const activeChatId     = currentChatIdRef.current

      // Clear in-flight refs before any async work
      assistantIdRef.current      = null
      streamingContentRef.current = ''
      thinkStartedAt.current      = null

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

      // Persist toolCall or decide whether to surface a buffered error
      const finalToolCall = liveToolCallRef.current
      if (finalToolCall?.phase === 'done') {
        // Persist successful search onto the message
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === assistantMsgId)
          if (idx === -1) return prev
          const updated = [...prev]
          updated[idx] = { ...updated[idx], toolCall: { query: finalToolCall.query, results: finalToolCall.results ?? [] } }
          return updated
        })
      } else if (finalToolCall?.phase === 'error') {
        // Only show error card if the model explicitly mentioned the search failure.
        // If the model just answered from training knowledge, show nothing — clean UX.
        const mentionsFailure = /search.{0,40}(fail|unavailable|unable|error|couldn)/i.test(assistantContent)
        if (mentionsFailure) {
          patchAssistant({ liveToolCall: finalToolCall })
          setLiveToolCall(finalToolCall)
        }
      }

      setLiveToolCall(null)
      liveToolCallRef.current = null

      // Persist assistant message to SQLite (fire-and-forget, works in both envs)
      if (activeChatId && assistantMsgId && assistantContent) {
        const toolCallToSave = finalToolCall?.phase === 'done'
          ? JSON.stringify({ query: finalToolCall.query, results: finalToolCall.results ?? [] })
          : null
        window.api
          .saveMessage(activeChatId, assistantMsgId, 'assistant', assistantContent, undefined, toolCallToSave)
          .catch((err) => console.warn('[DB] save assistant msg failed:', err))
      }
    })

    const unsubErr = window.api.onChatError((msg: string) => {
      const id = assistantIdRef.current
      assistantIdRef.current      = null
      streamingContentRef.current = ''
      liveToolCallRef.current     = null
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
      setLiveToolCall(null)
    })

    const unsubSearch = window.api.onWebSearchStatus((s) => {
      if (s.phase === 'searching') {
        setIsSearching(true)
        liveToolCallRef.current = { phase: 'searching', query: s.query }
        setLiveToolCall({ phase: 'searching', query: s.query })
        patchAssistant({ isSearching: true, liveToolCall: { phase: 'searching', query: s.query } })
      } else if (s.phase === 'done') {
        setIsSearching(false)
        liveToolCallRef.current = { phase: 'done', query: s.query, results: s.results ?? [] }
        setLiveToolCall({ phase: 'done', query: s.query, results: s.results ?? [] })
        patchAssistant({ isSearching: false, liveToolCall: { phase: 'done', query: s.query, results: s.results ?? [] } })
      } else {
        // Buffer error — store in ref but don't surface to UI yet.
        // CHAT_STREAM_END will decide whether to show it based on response content.
        liveToolCallRef.current = { phase: 'error', query: s.query, error: s.error }
        patchAssistant({ isSearching: false })
        setIsSearching(false)
      }
    })

    // ── Mid-stream tool call retraction ─────────────────────────
    // When the main process detects a <tool_call> tag mid-stream, it aborts
    // the stream, executes the search, and sends CHAT_STREAM_RETRACT with the
    // pre-tool-call content. We reset streamingContentRef and the assistant
    // message content to the clean version so the tool call XML never appears.
    const unsubRetract = window.api.onChatStreamRetract((cleanContent: string) => {
      streamingContentRef.current = cleanContent
      // Signal to the next chunk handler to reset from this baseline rather
      // than appending to whatever prev.content holds at that instant.
      retractedContentRef.current = cleanContent
      const id = assistantIdRef.current
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id)
        if (idx === -1) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], content: cleanContent }
        return updated
      })
    })

    return () => { unsubChunk(); unsubEnd(); unsubErr(); unsubSearch(); unsubRetract() }
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

    setLiveToolCall(null)
    liveToolCallRef.current  = null
    thinkStartedAt.current   = null
    retractedContentRef.current = null

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

    // Insert a mode-switch divider when the user changes thinking mode
    // mid-conversation. Only shown when there are existing messages.
    const modeChanged = prevThinkingModeRef.current !== thinkingMode
    prevThinkingModeRef.current = thinkingMode

    setMessages((prev) => {
      const dividers: Message[] = (modeChanged && prev.length > 0)
        ? [{
            id:          uuid(),
            role:        'divider',
            content:     thinkingMode === 'thinking'
              ? '— Switched to Thinking Mode —'
              : '— Switched to Fast Mode —',
            stats:       null,
            isThinking:  false,
            isStreaming:  false,
            isSearching:  false,
            error:       null,
          }]
        : []
      return [...prev, ...dividers, userMsg, assistantMsg]
    })
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

    // Build wire messages from current history + new user message.
    // Divider messages are display-only — filter them before sending to LM Studio.
    //
    // Context-amnesia fix: when multiple past messages have toolCall data, only
    // the LAST one gets the full results expanded. All earlier ones get a short
    // stub ('[Previous search: <query>]') so stale search data from a prior turn
    // cannot dominate the context and cause the model to re-answer the old question.
    const allMsgsForWire = [...messages, userMsg].filter((m) => m.role !== 'divider')
    const lastToolCallIndex = allMsgsForWire.reduce(
      (last, m, i) => (m.toolCall ? i : last), -1
    )

    const wire: WireMessage[] = allMsgsForWire.flatMap((m, i) => {
        if (m.toolCall) {
          const isLastToolCall = i === lastToolCallIndex
          const resultsStr = isLastToolCall
            ? JSON.stringify(m.toolCall.results?.slice(0, 3) || [])
            : `[Previous search: ${m.toolCall.query}]`
          const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substring(7)}`

          return [
            {
              role: m.role as 'user' | 'assistant',
              content: m.content,
              tool_calls: [{
                id: toolCallId,
                type: 'function',
                function: { name: 'brave_web_search', arguments: JSON.stringify({ query: m.toolCall.query }) }
              }]
            },
            {
              role: 'tool',
              tool_call_id: toolCallId,
              content: resultsStr
            }
          ] as WireMessage[]
        }

        return [{
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }] as WireMessage[]
      })

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
        // Section 5: pass thinking mode so ChatService sets the LM Studio
        // `thinking` field accordingly.
        thinkingMode,
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
  }, [isStreaming, messages, patchAssistant, onChatCreated, selectedModel, thinkingMode])

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
    setLiveToolCall(null)
    assistantIdRef.current      = null
    streamingContentRef.current = ''
    liveToolCallRef.current     = null
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
    setLiveToolCall(null)
    assistantIdRef.current      = null
    streamingContentRef.current = ''
    liveToolCallRef.current     = null
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
