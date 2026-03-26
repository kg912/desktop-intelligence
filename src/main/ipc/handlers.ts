import { ipcMain, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { modelConnectionManager } from '../managers/ModelConnectionManager'
import { lmsDaemonManager } from '../managers/LMSDaemonManager'
import { chatService } from '../services/ChatService'
import { processFile } from '../services/FileProcessorService'
import { detectSearchIntent, performWebSearch } from '../services/WebSearchService'
import { BASE_SYSTEM_PROMPT } from '../services/SystemPromptService'
import {
  getAllChats,
  createChat,
  getChatMessages,
  saveMessage,
  deleteChatById,
} from '../services/DatabaseService'
import type {
  ConnectionState,
  DaemonState,
  ChatSendPayload,
  AttachmentFilePayload,
  ProcessedAttachment,
  Chat,
  StoredMessage,
  WireMessage,
} from '../../shared/types'
import { DEFAULT_MODEL_ID } from '../../shared/types'

/**
 * registerIpcHandlers
 * All ipcMain.handle / ipcMain.on calls live here — nowhere else.
 */
export function registerIpcHandlers(webContents: () => WebContents | null): void {
  const send = (channel: string, payload: unknown): void => {
    const wc = webContents()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }

  // ── Model Connection ────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MODEL_GET_STATUS, (): ConnectionState =>
    modelConnectionManager.getState()
  )

  ipcMain.handle(IPC_CHANNELS.MODEL_FORCE_POLL, async (): Promise<ConnectionState> =>
    modelConnectionManager.forcePoll()
  )

  modelConnectionManager.on('statusChange', (state: ConnectionState) =>
    send(IPC_CHANNELS.MODEL_STATUS_CHANGE, state)
  )

  // ── Daemon ──────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.DAEMON_GET_STATE, (): DaemonState =>
    lmsDaemonManager.getState()
  )

  ipcMain.handle(IPC_CHANNELS.DAEMON_RETRY, async (): Promise<DaemonState> => {
    await lmsDaemonManager.retry()
    return lmsDaemonManager.getState()
  })

  lmsDaemonManager.on('stateChange', (state: DaemonState) =>
    send(IPC_CHANNELS.DAEMON_STATE_CHANGE, state)
  )

  // ── File processing ─────────────────────────────────────────
  ipcMain.handle(
    IPC_CHANNELS.FILE_PROCESS,
    async (_, filePayload: AttachmentFilePayload): Promise<ProcessedAttachment> => {
      return processFile(filePayload)
    }
  )

  // ── Chat — streaming ────────────────────────────────────────
  /**
   * chat:send  (Phase 4 + 5)
   *
   * Enrichment pipeline before forwarding to the LLM:
   *   1. Web search intent detection  (Phase 4)
   *   2. RAG context retrieval        (Phase 5)
   *   3. System-prompt assembly
   *   4. Context sliding if > 6 000 tokens (Phase 5)
   */
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_, payload: ChatSendPayload): Promise<void> => {
    const wc = webContents()
    if (!wc || wc.isDestroyed()) return

    // Model is dictated by the frontend (ModelStore). Fall back to DEFAULT_MODEL_ID
    // if the payload field is absent (e.g. during browser mock / unit tests).
    const modelId     = payload.model ?? DEFAULT_MODEL_ID
    const lastUserMsg = [...payload.messages].reverse().find((m) => m.role === 'user')

    // BASE_SYSTEM_PROMPT is always first — it tells the model about the app's
    // native rendering capabilities (Mermaid diagrams, KaTeX) so it stops
    // generating ASCII art and text-based diagrams.
    const systemParts: string[] = [BASE_SYSTEM_PROMPT]
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt)

    // ── 1. Routing guard: check if this chat has local documents ──
    // If the chat has files ingested into the vector DB, SKIP web search
    // entirely — the local RAG pipeline is always preferred over a network
    // call that may timeout and delay the response.
    let chatHasDocuments = false
    if (payload.chatId) {
      try {
        const { getDB } = await import('../services/DatabaseService')
        const db  = getDB()
        const row = db
          .prepare('SELECT COUNT(*) AS n FROM documents WHERE chat_id = ?')
          .get(payload.chatId) as { n: number }
        chatHasDocuments = row.n > 0
        console.log(`[Routing] chatId=${payload.chatId} hasDocuments=${chatHasDocuments} (${row.n} doc(s))`)
      } catch (err) {
        console.error('[Routing] document check failed:', err)
      }
    }

    // ── 2. Web search — only when no local documents exist for this chat ──
    if (lastUserMsg && !chatHasDocuments) {
      const query = detectSearchIntent(lastUserMsg.content)
      if (query) {
        const searchResult = await performWebSearch(query, wc)
        systemParts.push(searchResult)
      }
    }

    // ── 3. RAG context retrieval ─────────────────────────────
    // Runs unconditionally (independent of web search) so a web search
    // timeout can never starve the RAG pipeline. Kept separate from
    // systemParts so it is injected as a dedicated system message
    // immediately before the user's last turn (step 6 below).
    let ragContext = ''
    if (lastUserMsg) {
      try {
        const { retrieveContext } = await import('../services/RAGService')
        ragContext = await retrieveContext(lastUserMsg.content, payload.chatId)
      } catch (err) {
        console.error('[RAG] retrieveContext failed:', err)
      }
    }

    // ── 4. Build enriched system prompt (web search only) ────
    const enrichedSystemPrompt = systemParts.join('\n\n') || undefined
    let enrichedMessages       = payload.messages

    // ── 5. Context sliding ───────────────────────────────────
    try {
      const { slideIfNeeded } = await import('../services/ContextSliderService')
      enrichedMessages = await slideIfNeeded(
        payload.messages,
        enrichedSystemPrompt ?? '',
        modelId
      )
    } catch {
      // Leave messages unchanged if slider fails
    }

    // ── 6. Splice RAG context as a dedicated system message ──
    // Insert immediately before the last user message so the model sees
    // the retrieved chunks as the most recent context signal.
    // Phase 8 (Bug 3): the mandatory directive prefix forces the model to
    // treat the provided text as directly readable file content and prevents
    // it from claiming it cannot access the vector database or attached files.
    if (ragContext) {
      const lastUserIdx = [...enrichedMessages].map((m) => m.role).lastIndexOf('user')
      if (lastUserIdx !== -1) {
        const RAG_DIRECTIVE =
          '[SYSTEM DIRECTIVE: You are equipped with a local RAG vector database. ' +
          'The user has attached files to this conversation. The raw text from these ' +
          'files has been extracted and is provided below. YOU MUST ACT AS IF YOU CAN ' +
          'READ THESE FILES DIRECTLY. NEVER state that you cannot access files or the ' +
          'vector database. Use the text below to answer the user\'s query perfectly.]'

        const fullRagContent = `${RAG_DIRECTIVE}\n\n${ragContext}`
        const ragMessage: WireMessage = { role: 'system', content: fullRagContent }
        enrichedMessages = [
          ...enrichedMessages.slice(0, lastUserIdx),
          ragMessage,
          ...enrichedMessages.slice(lastUserIdx),
        ]
        console.log(
          `[RAG] INJECTING RAG CONTEXT (chatId=${payload.chatId ?? 'none'}, ` +
          `${ragContext.length} chars): ` +
          ragContext.slice(0, 120).replace(/\n/g, ' ') + '…'
        )
      }
    }

    const enrichedPayload: ChatSendPayload = {
      ...payload,
      messages:     enrichedMessages,
      systemPrompt: enrichedSystemPrompt,
    }

    try {
      await chatService.send(enrichedPayload, modelId, wc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      send(IPC_CHANNELS.CHAT_ERROR, msg)
    }
  })

  /**
   * chat:abort — fire-and-forget from renderer
   */
  ipcMain.on(IPC_CHANNELS.CHAT_ABORT, () => {
    chatService.abort()
  })

  // ── Chat History (SQLite) ───────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.DB_GET_CHATS, (): Chat[] =>
    getAllChats()
  )

  ipcMain.handle(IPC_CHANNELS.DB_GET_MESSAGES, (_, chatId: string): StoredMessage[] =>
    getChatMessages(chatId)
  )

  ipcMain.handle(IPC_CHANNELS.DB_NEW_CHAT, (_, id: string, title: string): Chat =>
    createChat(id, title)
  )

  ipcMain.handle(IPC_CHANNELS.DB_DELETE_CHAT, (_, chatId: string): void =>
    deleteChatById(chatId)
  )

  ipcMain.handle(
    IPC_CHANNELS.DB_SAVE_MESSAGE,
    (_, chatId: string, id: string, role: string, content: string, attachmentsJson?: string): void =>
      saveMessage(chatId, id, role, content, attachmentsJson ?? null)
  )
}
