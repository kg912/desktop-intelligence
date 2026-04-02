/**
 * Preload — contextBridge surface exposed as window.api
 * Every method typed; no raw ipcRenderer exposed.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  ConnectionState,
  DaemonState,
  ChatSendPayload,
  GenerationStats,
  AttachmentFilePayload,
  ProcessedAttachment,
  WebSearchStatus,
  Chat,
  StoredMessage,
  ModelConfig,
  ReloadModelPayload,
  ReloadResult,
  AvailableModel,
  AppInitPayload,
} from '../shared/types'

const api = {
  // ── Model Connection ────────────────────────────────────────
  getModelStatus: (): Promise<ConnectionState> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_GET_STATUS),

  forcePoll: (): Promise<ConnectionState> =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_FORCE_POLL),

  onModelStatusChange: (cb: (s: ConnectionState) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: ConnectionState): void => cb(s)
    ipcRenderer.on(IPC_CHANNELS.MODEL_STATUS_CHANGE, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MODEL_STATUS_CHANGE, h)
  },

  // ── Daemon ──────────────────────────────────────────────────
  getDaemonState: (): Promise<DaemonState> =>
    ipcRenderer.invoke(IPC_CHANNELS.DAEMON_GET_STATE),

  retryDaemon: (): Promise<DaemonState> =>
    ipcRenderer.invoke(IPC_CHANNELS.DAEMON_RETRY),

  onDaemonStateChange: (cb: (s: DaemonState) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: DaemonState): void => cb(s)
    ipcRenderer.on(IPC_CHANNELS.DAEMON_STATE_CHANGE, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DAEMON_STATE_CHANGE, h)
  },

  // ── Chat ────────────────────────────────────────────────────
  sendChatMessage: (payload: ChatSendPayload): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, payload),

  abortChat: (): void => ipcRenderer.send(IPC_CHANNELS.CHAT_ABORT),

  onChatStreamChunk: (cb: (chunk: string) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, c: string): void => cb(c)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_CHUNK, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_CHUNK, h)
  },

  onChatStreamEnd: (cb: (stats: GenerationStats) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: GenerationStats): void => cb(s)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_END, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_END, h)
  },

  onChatStreamRetract: (cb: (cleanContent: string) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, c: string): void => cb(c)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_RETRACT, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_RETRACT, h)
  },

  onChatError: (cb: (msg: string) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, m: string): void => cb(m)
    ipcRenderer.on(IPC_CHANNELS.CHAT_ERROR, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_ERROR, h)
  },

  // ── File processing ──────────────────────────────────────────
  processFile: (payload: AttachmentFilePayload): Promise<ProcessedAttachment> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_PROCESS, payload),

  onWebSearchStatus: (cb: (s: WebSearchStatus) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, s: WebSearchStatus): void => cb(s)
    ipcRenderer.on(IPC_CHANNELS.WEB_SEARCH_STATUS, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEB_SEARCH_STATUS, h)
  },

  // ── Matplotlib rendering ─────────────────────────────────────
  renderMatplotlib: (code: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PYTHON_RENDER, code),

  // ── Image RAG — plot persistence ─────────────────────────────
  storePlot: (payload: {
    chatId:      string
    code:        string
    imageBase64: string
    caption:     string
  }): Promise<{ id: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLOT_STORE, payload),

  // ── Model settings (context length via /api/v0) ──────────────
  getModelConfig: (): Promise<ModelConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_MODEL),

  reloadModel: (payload: ReloadModelPayload): Promise<ReloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RELOAD, payload),

  // ── First-launch onboarding ───────────────────────────────────
  isFirstLaunch: (): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_IS_FIRST_LAUNCH),

  getAvailableModels: (): Promise<AvailableModel[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_AVAILABLE_MODELS),

  initializeApp: (payload: AppInitPayload): Promise<ReloadResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_INITIALIZE, payload),

  // ── MCP / Tool settings ──────────────────────────────────────────
  mcpGetSettings: (): Promise<{ braveEnabled: boolean; braveApiKey: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SETTINGS),

  mcpSaveSettings: (patch: { braveEnabled?: boolean; braveApiKey?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_SETTINGS, patch),

  mcpGetEnvKeyStatus: (): Promise<{ hasEnvKey: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_ENV_KEY_STATUS),

  // ── RAG (Phase 5 stubs) ──────────────────────────────────────
  ingestFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_INGEST_FILE, filePath),

  onIngestProgress: (cb: (p: unknown) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: unknown): void => cb(p)
    ipcRenderer.on(IPC_CHANNELS.RAG_INGEST_PROGRESS, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.RAG_INGEST_PROGRESS, h)
  },

  // ── Chat History (SQLite) ────────────────────────────────────
  getChats: (): Promise<Chat[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_GET_CHATS),

  getChatMessages: (chatId: string): Promise<StoredMessage[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_GET_MESSAGES, chatId),

  newChat: (id: string, title: string): Promise<Chat> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_NEW_CHAT, id, title),

  deleteChat: (chatId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_DELETE_CHAT, chatId),

  saveMessage: (
    chatId:          string,
    id:              string,
    role:            string,
    content:         string,
    attachmentsJson?: string | null,
    toolCallJson?:   string | null
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_SAVE_MESSAGE, chatId, id, role, content, attachmentsJson, toolCallJson),
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
