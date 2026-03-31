import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import { Sidebar } from './Sidebar'
import { SettingsPage } from '../settings/SettingsPage'
import { TopBar } from './TopBar'
import { ChatArea } from './ChatArea'
import type { ChatAreaHandle } from './ChatArea'
import { InputBar } from './InputBar'
import type { Attachment } from './InputBar'
import { useChat } from '../../hooks/useChat'
import { useModelStore } from '../../store/ModelStore'
import type { Chat, ProcessedAttachment, StoredMessage } from '../../../../shared/types'
import type { Message } from '../chat/MessageBubble'

export function Layout() {
  const { setThinkingMode } = useModelStore()
  const [sidebarCollapsed,  setSidebarCollapsed]  = useState(false)
  const [settingsOpen,      setSettingsOpen]      = useState(false)
  const chatAreaRef = useRef<ChatAreaHandle>(null)

  // ── Chat history list (sidebar) ───────────────────────────────
  const [chats,        setChats]        = useState<Chat[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)

  // Load chat list on mount
  useEffect(() => {
    window.api.getChats()
      .then(setChats)
      .catch((err) => console.warn('[DB] getChats failed:', err))
  }, [])

  const refreshChats = useCallback(async () => {
    try {
      setChats(await window.api.getChats())
    } catch (err) {
      console.warn('[DB] refreshChats failed:', err)
    }
  }, [])

  // Called by useChat when it auto-creates a new chat row.
  // 1. Immediately set activeChatId so subsequent messages go to this chat.
  // 2. Optimistically prepend so the sidebar reacts instantly.
  // 3. Also do a real DB round-trip so the persisted title/timestamp is shown.
  const handleChatCreated = useCallback((chat: Chat) => {
    setActiveChatId(chat.id)
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)])
    // Refresh from DB to guarantee the sidebar reflects what was actually written
    window.api.getChats()
      .then(setChats)
      .catch((err) => console.warn('[DB] post-create refresh failed:', err))
  }, [])

  // ── useChat (streaming + DB persistence) ─────────────────────
  const {
    messages,
    isStreaming,
    sendMessage,
    abort,
    loadMessages,
    clearMessages,
  } = useChat({ chatId: activeChatId, onChatCreated: handleChatCreated })

  // ── Sidebar: select an existing chat ─────────────────────────
  const handleSelectChat = useCallback(async (chatId: string) => {
    if (isStreaming) return

    // Set the active ID immediately so useChat's ref is updated on the
    // next render before any messages are loaded.
    setActiveChatId(chatId)

    try {
      const stored: StoredMessage[] = await window.api.getChatMessages(chatId)
      const msgs: Message[] = stored.map((wm) => ({
        id:          uuid(),
        role:        wm.role as 'user' | 'assistant',
        content:     wm.content,
        // Restore attachment pills from serialised metadata (null → undefined)
        attachments: wm.attachmentsJson ? JSON.parse(wm.attachmentsJson) : undefined,
        // Restore web-search notification (null → undefined)
        toolCall:    wm.toolCallJson    ? JSON.parse(wm.toolCallJson)    : undefined,
        stats:       null,
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        error:       null,
      }))
      loadMessages(msgs)
    } catch (err) {
      console.warn('[DB] getChatMessages failed:', err)
    }
  }, [isStreaming, loadMessages])

  // ── Sidebar: new chat ─────────────────────────────────────────
  const handleNewChat = useCallback(() => {
    clearMessages()
    setActiveChatId(null)
  }, [clearMessages])

  // ── Sidebar: delete a chat ────────────────────────────────────
  const handleDeleteChat = useCallback(async (chatId: string) => {
    try {
      await window.api.deleteChat(chatId)
    } catch (err) {
      console.warn('[DB] deleteChat failed:', err)
    }
    if (activeChatId === chatId) handleNewChat()
    await refreshChats()
  }, [activeChatId, handleNewChat, refreshChats])

  // Refresh sidebar after each stream completes so the chat's
  // updated_at timestamp sorts it back to the top of the list.
  useEffect(() => {
    if (!isStreaming) {
      refreshChats().catch(() => {/* already logged inside */})
    }
  }, [isStreaming, refreshChats])

  // ── Attachment list shared between window drop zone + InputBar ──
  const [attachments, setAttachments] = useState<Attachment[]>([])

  // ── Window-level drag overlay ─────────────────────────────────
  const dragCounter  = useRef(0)
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    const onEnter = (): void => {
      if (++dragCounter.current === 1) setIsDragging(true)
    }
    const onLeave = (): void => {
      if (--dragCounter.current <= 0) {
        dragCounter.current = 0
        setIsDragging(false)
      }
    }
    const onDrop = (): void => {
      dragCounter.current = 0
      setIsDragging(false)
    }
    const onDragOver = (e: DragEvent): void => { e.preventDefault() }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop',      onDrop)
    window.addEventListener('dragover',  onDragOver)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop',      onDrop)
      window.removeEventListener('dragover',  onDragOver)
    }
  }, [])

  // ── Handle drop on the main column ───────────────────────────
  const handleMainDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounter.current = 0
    setIsDragging(false)

    const MAX_IMAGE_BYTES = 5 * 1024 * 1024

    Array.from(e.dataTransfer.files).forEach((file) => {
      const isImage = file.type.startsWith('image/')
      if (isImage && file.size > MAX_IMAGE_BYTES) return

      const filePath = (file as File & { path?: string }).path ?? ''
      setAttachments((prev) => {
        // Phase 8 (Bug 1): dedup — skip if a file with the same name AND size
        // is already in the list (catches re-drops of the same file).
        if (prev.some((a) => a.name === file.name && a.size === file.size)) return prev
        return [
          ...prev,
          {
            id:       `${Date.now()}-${Math.random()}`,
            name:     file.name,
            type:     isImage ? 'image' : 'document',
            size:     file.size,
            filePath,
            mimeType: file.type || 'application/octet-stream',
          },
        ]
      })
    })
  }, [])

  // ── Process attachments and send ──────────────────────────────
  const handleSend = useCallback(async (text: string, rawAttachments?: Attachment[]) => {
    // Snap to bottom immediately — before any async work or state changes —
    // so the user lands at the bottom the instant they press send, even if
    // they were scrolled up reading history.
    chatAreaRef.current?.scrollToBottom()

    const list = rawAttachments ?? []

    // ── Pre-create the chat row BEFORE processFile is called ─────
    // Root-cause fix: if the user attaches a file on the very first message of a
    // new chat session, activeChatId is null.  Without a chat ID, ingestDocument
    // stores the document with chat_id = NULL.  Then sendChatMessage creates the
    // chat with a fresh UUID, and retrieveContext filters WHERE d.chat_id = <UUID>
    // → zero rows → LLM receives no RAG context.
    //
    // Fix: when there are attachments AND no active chat, pre-create the chat row
    // here (before processFile) so every document is tagged with the correct ID.
    // We then pass preChatId to sendMessage so it skips its own creation step.
    let preChatId: string | undefined
    if (list.length > 0 && !activeChatId) {
      try {
        const newId = uuid()
        const title = text.slice(0, 80).trim() || 'New Chat'
        const chat  = await window.api.newChat(newId, title)
        preChatId   = chat.id
        console.log(`[Layout] Pre-created chat for file ingest: id=${chat.id}`)
        // Update the sidebar and activeChatId state immediately so subsequent
        // renders see the new chat (handleChatCreated also updates currentChatIdRef
        // via the chatId prop → useEffect in useChat).
        handleChatCreated(chat)
      } catch (err) {
        console.warn('[DB] pre-create chat for file attach failed:', err)
      }
    }

    const effectiveChatId = preChatId ?? activeChatId ?? undefined

    // Auto-switch to Thinking mode when the message includes files.
    // PDFs and images benefit significantly from the model's reasoning chain.
    // Section 5.3 of CLAUDE.md specifies this behaviour.
    if (list.length > 0) {
      setThinkingMode('thinking')
    }

    let processed: ProcessedAttachment[] = []
    if (list.length > 0) {
      const results = await Promise.allSettled(
        list.map((a) =>
          window.api.processFile({
            filePath: a.filePath,
            fileName: a.name,
            mimeType: a.mimeType,
            size:     a.size,
            // Tag each document with the chat session (now always non-null for
            // first-message file attachments thanks to the pre-creation above).
            chatId:   effectiveChatId,
          })
        )
      )
      processed = results
        .filter((r): r is PromiseFulfilledResult<ProcessedAttachment> => r.status === 'fulfilled')
        .map((r) => r.value)
    }

    setAttachments([])
    // Pass preChatId so useChat skips its own chat-creation step (avoiding double rows).
    sendMessage(text, processed.length ? processed : undefined, preChatId)
  }, [activeChatId, sendMessage, handleChatCreated])

  // Suggestion pill clicked → pre-fill and send immediately
  const handleSuggest = useCallback((text: string) => {
    sendMessage(text)
  }, [sendMessage])

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {settingsOpen ? (
        <SettingsPage onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          {/* ── Sidebar ── */}
          <div className="relative flex-shrink-0 h-full">
            <Sidebar
              collapsed={sidebarCollapsed}
              onToggle={() => setSidebarCollapsed((v) => !v)}
              chats={chats}
              activeChatId={activeChatId}
              onSelectChat={handleSelectChat}
              onNewChat={handleNewChat}
              onDeleteChat={handleDeleteChat}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          {/* ── Main column ── */}
          <div
            className="flex-1 flex flex-col h-full min-w-0 bg-background relative"
            onDrop={handleMainDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            {/* Window-level drag overlay */}
            <AnimatePresence>
              {isDragging && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="absolute inset-0 z-50 flex items-center justify-center
                             bg-black/40 border-2 border-dashed border-red-700
                             rounded-none pointer-events-none"
                >
                  <p className="text-sm text-red-400 font-medium select-none">
                    Drop files to attach
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            <TopBar />

            <ChatArea
              ref={chatAreaRef}
              messages={messages}
              isStreaming={isStreaming}
              onSuggest={handleSuggest}
            />

            <InputBar
              isStreaming={isStreaming}
              onSend={handleSend}
              onAbort={abort}
              attachments={attachments}
              onAttachments={setAttachments}
            />
          </div>
        </>
      )}
    </div>
  )
}
