import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { v4 as uuid } from 'uuid'
import { Sidebar } from './Sidebar'
import type { AgentRailState, SidebarMode } from './Sidebar'
import { SettingsPage } from '../settings/SettingsPage'
import { TopBar } from './TopBar'
import { ChatArea } from './ChatArea'
import type { ChatAreaHandle } from './ChatArea'
import { InputBar } from './InputBar'
import type { Attachment } from './InputBar'
import { useChat } from '../../hooks/useChat'
import { useModelConfig, useModelRuntime } from '../../store/ModelStore'
import { CompactingGate } from '../chat/CompactingGate'
import { McpPermissionDialog } from '../chat/McpPermissionDialog'
import { SandboxViolationToast } from '../chat/SandboxViolationToast'
import { FinalSynthesis, MultiAgentSidebarView } from '../chat/MultiAgentSidebarView'
import { useMultiAgentRun } from '../../hooks/useMultiAgentRun'
import { inputLockMessage, isRunActive, pausedAgents } from '../../lib/multiAgentRunState'
import { estimateRunCost } from '../../../../shared/multiAgentModels'
import type { Chat, McpToolPermissionResponse, ProcessedAttachment, StoredMessage, McpToolPermissionRequest, SandboxViolationTraceEvent } from '../../../../shared/types'
import type { Message } from '../chat/MessageBubble'

export function Layout() {
  const { setThinkingMode, setIsMultiAgentRunning, multiAgentMode, setMultiAgentMode } = useModelConfig()
  const { setContextUsage, isReloading } = useModelRuntime()
  const [sidebarMode,          setSidebarMode]          = useState<SidebarMode | null>('chat')
  const [settingsOpen,         setSettingsOpen]         = useState(false)
  const [mcpPermissionRequests, setMcpPermissionRequests] = useState<McpToolPermissionRequest[]>([])
  const [mcpActivity,          setMcpActivity]          = useState<{ serverName: string; toolName: string } | null>(null)
  // The multi-agent run lives in the sidebar, widened ('agents' mode) — no separate pane.
  const [focusAgentId,   setFocusAgentId]   = useState<string | null>(null)
  const [reviewableChat, setReviewableChat] = useState<string | null>(null)
  const [isOpenRouter,   setIsOpenRouter]   = useState(false)
  // Below 1280 px the dock overlays the chat; below 1024 px its plan column hides too.
  const narrowWindow    = useMediaQuery('(max-width: 1279px)')
  const tinyWindow      = useMediaQuery('(max-width: 1023px)')
  const chatAreaRef     = useRef<ChatAreaHandle>(null)
  const lastSidebarMode = useRef<SidebarMode>('chat')

  // Track last non-null mode so the TopBar toggle can reopen the right panel
  useEffect(() => {
    if (sidebarMode !== null) lastSidebarMode.current = sidebarMode
  }, [sidebarMode])

  useEffect(() => {
    window.api.getBackendSettings?.()
      .then((s) => setIsOpenRouter(s.provider === 'openrouter'))
      .catch(() => { /* rail button stays hidden */ })
  }, [])

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
  // Optimistic prepend is sufficient — the refreshChats() that fires when
  // isStreaming → false canonically syncs from DB after all messages are saved.
  // The previous fire-and-forget getChats() here raced against in-flight
  // saveMessage calls and could overwrite chats state with stale data, causing
  // starred chats to reorder unexpectedly.
  const handleChatCreated = useCallback((chat: Chat) => {
    setActiveChatId(chat.id)
    setChats((prev) => [chat, ...prev.filter((c) => c.id !== chat.id)])
  }, [])

  // ── Mode lock: regular and agent chats never cross over ──────
  // A listed chat has been sent to, so its mode is fixed; a new chat (no id) may choose.
  const chatMode = chats.find((c) => c.id === activeChatId)?.mode ?? null
  const useAgents = chatMode ? chatMode === 'multi-agent' : multiAgentMode
  // The toggle follows the destination chat, never the previous chat's value.
  useEffect(() => {
    setMultiAgentMode(chatMode === 'multi-agent')
  }, [activeChatId, chatMode, setMultiAgentMode])

  // ── useChat (streaming + DB persistence) ─────────────────────
  const {
    isStreaming,
    sendMessage,
    abort,
    loadMessages,
    clearMessages,
    chatSystemInstructions,
    updateChatSystemInstructions,
  } = useChat({ chatId: activeChatId, onChatCreated: handleChatCreated })

  // Stable refs so handleSend/handleSuggest never need to be recreated when
  // sendMessage/abort change identity (e.g. after a useChat internal update).
  // This prevents handleSend's useCallback from invalidating InputBar's memo.
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])
  const abortRef = useRef(abort)
  useEffect(() => { abortRef.current = abort }, [abort])

  // ── Load a chat's stored messages into the chat view ─────────
  const loadChatMessages = useCallback(async (chatId: string) => {
    try {
      const stored: StoredMessage[] = await window.api.getChatMessages(chatId)
      const msgs: Message[] = stored.map((wm) => ({
        id:          uuid(),
        role:        wm.role as 'user' | 'assistant',
        content:     wm.content,
        // Restore attachment pills from serialised metadata (null → undefined)
        attachments: wm.attachmentsJson ? JSON.parse(wm.attachmentsJson) : undefined,
        // Restore web-search notification (null → undefined, legacy path)
        toolCall:    wm.toolCallJson    ? JSON.parse(wm.toolCallJson)    : undefined,
        // Restore v2.1 block list (null → undefined — falls back to legacy path)
        blocks:      wm.blocksJson      ? JSON.parse(wm.blocksJson)      : undefined,
        stats:       null,
        isThinking:  false,
        isStreaming:  false,
        isSearching:  false,
        error:       null,
      }))
      loadMessages(msgs)
      // Scroll to the bottom after load so the most recent message is visible,
      // matching every other chat app. Double-rAF ensures this fires after React
      // has committed the new messages AND the virtualizer has had one frame to
      // measure item heights, so scrollHeight is fully accurate.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chatAreaRef.current?.scrollToBottom()
        })
      })
    } catch (err) {
      console.warn('[DB] getChatMessages failed:', err)
    }
  }, [loadMessages])

  // ── Multi-agent run (live or under review) ────────────────────
  const activeChatIdRef = useRef(activeChatId)
  activeChatIdRef.current = activeChatId
  const handleRunFinished = useCallback((chatId: string) => {
    void refreshChats()
    // The coordinator saved the final answer as an assistant message.
    if (activeChatIdRef.current === chatId) void loadChatMessages(chatId)
  }, [loadChatMessages])
  const multiAgent = useMultiAgentRun(handleRunFinished)
  const shownRun = multiAgent.run && multiAgent.run.chatId === activeChatId ? multiAgent.run : null
  const shownRunActive = !!shownRun && !shownRun.review && isRunActive(shownRun.view)

  // Navigation lock: while a run is live (planning, plan approval, running, tool
  // approvals, synthesis) the user cannot leave its chat; any terminal event unlocks.
  const navLocked = !!multiAgent.run && !multiAgent.run.review && isRunActive(multiAgent.run.view)
  useEffect(() => {
    setIsMultiAgentRunning(navLocked)
  }, [navLocked, setIsMultiAgentRunning])

  // Warm the sidecar as soon as the mode is switched on.
  useEffect(() => {
    if (multiAgentMode) window.api.warmUpMultiAgent?.().catch(() => { /* reported at run start */ })
  }, [multiAgentMode])

  const estimate = useMemo(() => {
    if (!shownRun || shownRun.view.steps.length === 0 || Object.keys(multiAgent.pricing).length === 0) return null
    return estimateRunCost({ task: shownRun.task, steps: shownRun.view.steps, config: shownRun.config, pricing: multiAgent.pricing })
  }, [shownRun, multiAgent.pricing])

  const dockOpen = sidebarMode === 'agents'
  // Locked, leaving the dock collapses it rather than switching to the chat list.
  const leaveDock: SidebarMode | null = navLocked ? null : 'chat'
  const closeDock = useCallback(() => setSidebarMode((m) => (m === 'agents' ? leaveDock : m)), [leaveDock])
  const selectAgent = useCallback((agentId: string) => {
    setSidebarMode('agents')
    setFocusAgentId(null)
    requestAnimationFrame(() => setFocusAgentId(agentId))
  }, [])

  // With the dock open, the active chat's saved run is loaded into it (read-only).
  const { review: reviewRun } = multiAgent
  const runChatId = multiAgent.run?.chatId
  const activeTitle = chats.find((c) => c.id === activeChatId)?.title ?? ''
  useEffect(() => {
    if (dockOpen && activeChatId && reviewableChat === activeChatId && runChatId !== activeChatId) {
      void reviewRun(activeChatId, activeTitle)
    }
  }, [dockOpen, activeChatId, reviewableChat, runChatId, reviewRun, activeTitle])

  // The agents rail button is always there on OpenRouter, but only usable in an agent chat.
  const railEnabled = chatMode === 'multi-agent' || !!shownRun
  const agentRail = useMemo((): AgentRailState => {
    const run = shownRun && !shownRun.review ? shownRun.view : null
    const waiting = run ? pausedAgents(run).length : 0
    const working = run ? Object.values(run.agents).filter((a) => ['running', 'reflecting', 'retrying', 'paused'].includes(a.status)).length : 0
    return {
      visible: isOpenRouter,
      disabled: !railEnabled,
      state: run && isRunActive(run) ? (waiting ? 'approval' : 'live') : run ? 'done' : 'idle',
      count: waiting || working,
    }
  }, [shownRun, isOpenRouter, railEnabled])
  // Leaving an agent chat for a regular one closes the dock: it has nothing to show there.
  useEffect(() => {
    if (!railEnabled && dockOpen) setSidebarMode('chat')
  }, [railEnabled, dockOpen])

  // ── Sidebar: select an existing chat ─────────────────────────
  const handleSelectChat = useCallback(async (chatId: string) => {
    if (isStreaming || navLocked) return

    // Set the active ID immediately so useChat's ref is updated on the
    // next render before any messages are loaded.
    setActiveChatId(chatId)
    // A finished run belongs to its own chat; leave its view when navigating away.
    if (multiAgent.run && multiAgent.run.chatId !== chatId && (multiAgent.run.review || !isRunActive(multiAgent.run.view))) {
      multiAgent.dismiss()
    }
    await loadChatMessages(chatId)
  }, [isStreaming, navLocked, loadChatMessages, multiAgent])

  // Offer "View agent run" for chats that hold a persisted multi-agent trace.
  useEffect(() => {
    setReviewableChat(null)
    if (!activeChatId) return
    let cancelled = false
    window.api.getMultiAgentRun(activeChatId)
      .then((record) => {
        if (!cancelled && record?.mode === 'multi-agent' && record.executionTrace.length > 0) setReviewableChat(activeChatId)
      })
      .catch(() => { /* non-fatal */ })
    return () => { cancelled = true }
  }, [activeChatId, multiAgent.run])

  // ── Sidebar: new chat ─────────────────────────────────────────
  const handleNewChat = useCallback(() => {
    if (navLocked) return
    clearMessages()
    setActiveChatId(null)
    if (multiAgent.run && (multiAgent.run.review || !isRunActive(multiAgent.run.view))) multiAgent.dismiss()
  }, [clearMessages, multiAgent, navLocked])

  // ── Sidebar: rename a chat ────────────────────────────────────
  const handleRenameChat = useCallback(async (chatId: string, title: string) => {
    // Optimistic update so the sidebar reflects the new name immediately
    setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, title } : c))
    try {
      await window.api.renameChat(chatId, title)
    } catch (err) {
      console.warn('[DB] renameChat failed:', err)
      // Revert on failure
      await refreshChats()
    }
  }, [refreshChats])

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

  // ── Sidebar: star / unstar a chat ────────────────────────────
  const handleStarChat = useCallback(async (chatId: string, starred: boolean) => {
    setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, starred } : c))
    try {
      await window.api.starChat(chatId, starred)
    } catch (err) {
      console.warn('[DB] starChat failed:', err)
      await refreshChats()
    }
  }, [refreshChats])

  // Refresh sidebar after each stream completes so the chat's
  // updated_at timestamp sorts it back to the top of the list.
  useEffect(() => {
    if (!isStreaming) {
      refreshChats().catch(() => {/* already logged inside */})
    }
  }, [isStreaming, refreshChats])

  // ── MCP permission dialog + activity indicator ────────────────
  useEffect(() => {
    const unsubPerm = window.api.onMcpToolPermissionRequest((req) => {
      setMcpPermissionRequests((current) => current.some((pending) => pending.requestId === req.requestId) ? current : [...current, req])
    })
    const unsubExpired = window.api.onMcpToolPermissionExpired((requestId) => {
      setMcpPermissionRequests((current) => current.filter((pending) => pending.requestId !== requestId))
    })
    const unsubStart = window.api.onChatStreamToolStart((payload) => {
      // Show activity only for MCP tools (namespaced with __)
      if (payload.query && payload.query.includes('__')) {
        const [serverName, toolName] = payload.query.split('__')
        setMcpActivity({ serverName, toolName })
      }
    })
    const unsubDone = window.api.onChatStreamToolDone(() => {
      setMcpActivity(null)
    })
    const unsubError = window.api.onChatStreamToolError(() => {
      setMcpActivity(null)
    })
    return () => { unsubPerm(); unsubExpired(); unsubStart(); unsubDone(); unsubError() }
  }, [])

  // ── Sandbox credential-path violation toast (Phase 3) ──────────
  // Top-level listener (mirrors the app-wide onDaemonStateChange in App.tsx)
  // so the alert is visible regardless of which view (chat or settings) is
  // showing — rendered outside the settingsOpen conditional below.
  const [sandboxViolationToast, setSandboxViolationToast] = useState<SandboxViolationTraceEvent | null>(null)
  useEffect(() => {
    return window.api.onSandboxViolationAlert((violation) => {
      setSandboxViolationToast(violation)
      setTimeout(() => setSandboxViolationToast(null), 5000)
    })
  }, [])

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
    if (useAgents) return // multi-agent runs take no attachments

    const MAX_IMAGE_BYTES = 5 * 1024 * 1024

    Array.from(e.dataTransfer.files).forEach((file) => {
      const isImage = file.type.startsWith('image/')
      if (isImage && file.size > MAX_IMAGE_BYTES) return

      // file.path was removed in Electron 32 — use webUtils bridge via preload
      const filePath = window.api.getFilePath(file)
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
  }, [useAgents])

  // ── Process attachments and send ──────────────────────────────
  const handleSend = useCallback(async (text: string, rawAttachments?: Attachment[]) => {
    // Note: scrollToBottom is handled by ChatArea's useEffect that fires after
    // React commits the new user message to the DOM — calling it here (before
    // setMessages) would land at the pre-send bottom position.

    const list = rawAttachments ?? []
    if (useAgents && list.length > 0) {
      multiAgent.setStartError('Multi-agent runs do not take attachments — remove them or turn Multi-Agent mode off.')
      return
    }
    // Sending normally from a finished run view returns to the chat.
    if (!useAgents && multiAgent.run?.chatId === activeChatId && !shownRunActive) multiAgent.dismiss()

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
    if ((list.length > 0 || useAgents) && !activeChatId) {
      try {
        const newId = uuid()
        const title = text.slice(0, 80).trim() || 'New Chat'
        // The mode is fixed at creation: the first message locks it.
        const chat  = await window.api.newChat(newId, title, useAgents ? 'multi-agent' : 'single')
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

    // Observability artifact capture for image attachments — fire-and-forget
    if (processed.length > 0) {
      window.api.obsGetPrefs()
        .then((prefs) => {
          if (prefs.observabilityEnabled && prefs.includeImages) {
            for (const attachment of processed) {
              if (attachment.kind === 'image' && attachment.dataUrl) {
                const base64 = attachment.dataUrl.split(',')[1] ?? ''
                const ext = attachment.name.split('.').pop() ?? 'png'
                void window.api.obsCaptureArtifact({
                  type: 'image_artifact',
                  payload: { label: attachment.name, ext, base64 },
                  ts: Date.now(),
                })
              }
            }
          }
        })
        .catch(() => { /* non-fatal */ })
    }

    if (useAgents && effectiveChatId) {
      await window.api.saveMessage(effectiveChatId, uuid(), 'user', text)
      await loadChatMessages(effectiveChatId)
      // Sending a multi-agent task opens the dock; it stays open after the run ends.
      if (await multiAgent.start(effectiveChatId, text)) setSidebarMode('agents')
      return
    }

    // Pass preChatId so useChat skips its own chat-creation step (avoiding double rows).
    sendMessageRef.current(text, processed.length ? processed : undefined, preChatId)
  }, [activeChatId, handleChatCreated, loadChatMessages, multiAgent, useAgents, shownRunActive])

  // Suggestion pill clicked → pre-fill and send immediately
  const handleSuggest = useCallback((text: string) => {
    sendMessageRef.current(text)
  }, [])

  const respondToPermission = useCallback(async (response: McpToolPermissionResponse) => {
    try { await window.api.mcpRespondToPermission(response) }
    catch (err) { console.warn('[Layout] mcpRespondToPermission failed:', err) }
    finally { setMcpPermissionRequests((current) => current.filter((pending) => pending.requestId !== response.requestId)) }
  }, [])
  const modalPermissionRequests = useMemo(
    // Inline in the agent's card while the dock shows the run; modal otherwise, so it cannot be missed.
    () => mcpPermissionRequests.filter((r) => !(dockOpen && r.agent && shownRun && !shownRun.review && r.agent.runId === shownRun.view.runId)),
    [mcpPermissionRequests, shownRun, dockOpen]
  )

  // After compaction: only reset the context bar.
  // Message history in the UI is intentionally preserved — the compacted summary
  // lives in chats.compacted_summary and only affects the LM Studio wire payload.
  const handleCompactComplete = useCallback(() => {
    setContextUsage({ used: 0, total: 0 })
  }, [setContextUsage])

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      <AnimatePresence>
        {sandboxViolationToast && <SandboxViolationToast violation={sandboxViolationToast} />}
      </AnimatePresence>

      {settingsOpen ? (
        <SettingsPage onClose={() => setSettingsOpen(false)} />
      ) : (
        <>
          {/* ── Sidebar ── */}
          <div className="relative flex-shrink-0 h-full">
            <Sidebar
              sidebarMode={sidebarMode}
              navLocked={navLocked}
              onToggleChat={() => { if (!navLocked) setSidebarMode(sidebarMode === 'chat' ? null : 'chat') }}
              onToggleStarred={() => { if (!navLocked) setSidebarMode(sidebarMode === 'starred' ? null : 'starred') }}
              onToggleAgents={() => setSidebarMode(dockOpen ? leaveDock : 'agents')}
              agentRail={agentRail}
              overlayDock={narrowWindow}
              agentsPanel={
                shownRun ? (
                  <MultiAgentSidebarView
                    view={shownRun.view}
                    task={shownRun.task}
                    config={shownRun.config}
                    readOnly={shownRun.review}
                    estimate={estimate}
                    permissionRequests={mcpPermissionRequests}
                    onRespondPermission={respondToPermission}
                    onApprove={() => multiAgent.approvePlan(true)}
                    onCancel={() => multiAgent.approvePlan(false)}
                    onAbort={multiAgent.abort}
                    focusAgentId={focusAgentId}
                    onSelectAgent={selectAgent}
                    onClose={closeDock}
                    hidePlanColumn={tinyWindow}
                    runIds={shownRun.runIds}
                    recorded={shownRun.recorded}
                    onShowRun={(runId) => { if (activeChatId) void reviewRun(activeChatId, activeTitle, runId) }}
                  />
                ) : null
              }
              chats={chats}
              activeChatId={activeChatId}
              onSelectChat={handleSelectChat}
              onNewChat={handleNewChat}
              onDeleteChat={handleDeleteChat}
              onRenameChat={handleRenameChat}
              onStarChat={handleStarChat}
              onOpenSettings={() => { if (!isStreaming && !navLocked) setSettingsOpen(true) }}
            />
            {/* Streaming lock — blocks the sidebar while a single-chat response is in
                flight; never the dock, which needs Abort and Approve during a run. */}
            {isStreaming && !dockOpen && (
              <div
                className="absolute inset-0 z-40 cursor-not-allowed"
                title="Cannot switch chats while a response is streaming"
              />
            )}
          </div>

          {/* ── Main execution canvas ── */}
          <div
            className="flex-1 flex flex-col h-full min-w-0 bg-background relative"
            onDrop={handleMainDrop}
            onDragOver={(e) => e.preventDefault()}
          >
            {/* Window-level drag overlay */}
            {isDragging && (
              <div
                className="absolute inset-0 z-50 flex items-center justify-center
                           bg-black/40 border-2 border-dashed border-red-700
                           rounded-none pointer-events-none"
              >
                <p className="text-sm text-red-400 font-medium select-none">
                  Drop files to attach
                </p>
              </div>
            )}

            {/* Compaction / reload blocking overlay — isolated in its own
                signal subscriber so Layout itself is not a signal subscriber */}
            <CompactingGate isReloading={isReloading} />

            {/* MCP tool permission dialogs. Requests from agents of the run on
                screen render inline in their agent card (non-blocking, spec §07);
                everything else stays modal so it cannot be missed. */}
            {modalPermissionRequests.length > 0 && (
              <div className="absolute inset-0 z-50 flex flex-wrap content-center justify-center gap-4 overflow-y-auto bg-black/70 p-6 backdrop-blur-sm">
                {modalPermissionRequests.map((request) => (
                  <McpPermissionDialog key={request.requestId} inline request={request} onRespond={respondToPermission} />
                ))}
              </div>
            )}

            <TopBar
              activeChatId={activeChatId}
              onCompactComplete={handleCompactComplete}
              sidebarCollapsed={sidebarMode === null}
              onSidebarToggle={() => setSidebarMode(sidebarMode !== null ? null : navLocked ? 'agents' : lastSidebarMode.current)}
              chatSystemInstructions={chatSystemInstructions}
              onUpdateChatSystemInstructions={updateChatSystemInstructions}
            />

            {/* The main area stays a chat: a pill to the dock and, while a run is live, the synthesis. */}
            {(shownRun || (reviewableChat === activeChatId && activeChatId)) && (
              <div className="flex justify-center pt-3">
                <button
                  data-testid="agent-run-pill"
                  onClick={() => setSidebarMode(dockOpen ? leaveDock : 'agents')}
                  className="inline-flex h-[30px] items-center gap-2 rounded-[15px] border-[0.5px] border-ma-red/35 bg-ma-red/[0.08] px-3.5 text-[12.5px] text-ma-redtext hover:bg-ma-red/[0.14]"
                >
                  {dockOpen && shownRunActive && <span className="ma-pill-dot" />}
                  {dockOpen ? 'Viewing agent run · close' : 'View agent run'}
                </button>
              </div>
            )}
            <ChatArea
              ref={chatAreaRef}
              activeChatId={activeChatId}
              onSuggest={handleSuggest}
              chatSystemInstructions={chatSystemInstructions}
              footer={shownRun && shownRunActive && shownRun.view.phase !== 'planning' && shownRun.view.phase !== 'preflight'
                ? <FinalSynthesis view={shownRun.view} onSelectAgent={selectAgent} />
                : null}
            />

            {multiAgent.startError && (
              <div className="mx-4 mb-1 flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300" role="alert">
                <span className="flex-1">{multiAgent.startError}</span>
                <button onClick={() => multiAgent.setStartError(null)} className="text-red-400 hover:text-red-200">Dismiss</button>
              </div>
            )}

            <InputBar
              onSend={handleSend}
              onAbort={() => abortRef.current()}
              attachments={attachments}
              onAttachments={setAttachments}
              mcpActivity={mcpActivity}
              disabled={shownRunActive}
              lockedMessage={shownRunActive && shownRun ? inputLockMessage(shownRun.view) : null}
              modeLock={chatMode}
            />
          </div>
        </>
      )}
    </div>
  )
}

function useMediaQuery(query: string): boolean {
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const onChange = (): void => setMatches(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])
  return matches
}
