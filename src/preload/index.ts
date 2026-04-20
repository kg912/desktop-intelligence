/**
 * Preload — contextBridge surface exposed as window.api
 * Every method typed; no raw ipcRenderer exposed.
 */
import { contextBridge, ipcRenderer, shell } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  ConnectionState,
  DaemonState,
  ChatSendPayload,
  GenerationStats,
  AttachmentFilePayload,
  ProcessedAttachment,
  Chat,
  StoredMessage,
  ModelConfig,
  ReloadModelPayload,
  ReloadResult,
  AvailableModel,
  AppInitPayload,
  CompactPayload,
  CompactResult,
  McpServerSettings,
  McpServerRuntimeInfo,
  McpToolPermissionRequest,
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

  onChatStreamToolStart: (cb: (payload: { query: string }) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: { query: string }): void => cb(p)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_START, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_START, h)
  },

  onChatStreamToolDone: (cb: (payload: { query: string; results: Array<{ title: string; url: string }>; formattedContent: string }) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: { query: string; results: Array<{ title: string; url: string }>; formattedContent: string }): void => cb(p)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_DONE, h)
  },

  onChatStreamToolError: (cb: (payload: { query: string; error: string }) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: { query: string; error: string }): void => cb(p)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_TOOL_ERROR, h)
  },

  onChatError: (cb: (msg: string) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, m: string): void => cb(m)
    ipcRenderer.on(IPC_CHANNELS.CHAT_ERROR, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_ERROR, h)
  },

  // ── File processing ──────────────────────────────────────────
  processFile: (payload: AttachmentFilePayload): Promise<ProcessedAttachment> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_PROCESS, payload),

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
  mcpGetSettings: (): Promise<{ braveEnabled: boolean; braveApiKey: string; maxSearchLoops: number; keepSearchResultsInContext: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SETTINGS),

  mcpSaveSettings: (patch: { braveEnabled?: boolean; braveApiKey?: string; maxSearchLoops?: number; keepSearchResultsInContext?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_SETTINGS, patch),

  mcpGetEnvKeyStatus: (): Promise<{ hasEnvKey: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_ENV_KEY_STATUS),

  // ── Context compaction ───────────────────────────────────────
  compactChat: (payload: CompactPayload): Promise<CompactResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPACT, payload),

  // ── MCP Custom Servers ───────────────────────────────────────────
  mcpListCustomServers: (): Promise<McpServerSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_LIST_CUSTOM_SERVERS),

  mcpSaveCustomServers: (s: McpServerSettings): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_CUSTOM_SERVERS, s),

  mcpGetServerStatus: (): Promise<McpServerRuntimeInfo[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER_STATUS),

  mcpRestartServer: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_RESTART_SERVER, name),

  mcpRemoveServer: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, name),

  mcpRespondToPermission: (r: { requestId: string; approved: boolean; alwaysAllow: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_TOOL_PERMISSION_RESPONSE, r),

  onMcpServerStatusChanged: (cb: (info: McpServerRuntimeInfo) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, info: McpServerRuntimeInfo): void => cb(info)
    ipcRenderer.on(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, h)
  },

  onMcpToolPermissionRequest: (cb: (req: McpToolPermissionRequest) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, req: McpToolPermissionRequest): void => cb(req)
    ipcRenderer.on(IPC_CHANNELS.MCP_TOOL_PERMISSION_REQUEST, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_TOOL_PERMISSION_REQUEST, h)
  },

  // ── Shell utilities ──────────────────────────────────────────
  openExternal: (url: string): Promise<void> => shell.openExternal(url),

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
    chatId:           string,
    id:               string,
    role:             string,
    content:          string,
    attachmentsJson?: string | null,
    toolCallJson?:    string | null,
    blocksJson?:      string | null
  ): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DB_SAVE_MESSAGE, chatId, id, role, content, attachmentsJson, toolCallJson, blocksJson),
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
