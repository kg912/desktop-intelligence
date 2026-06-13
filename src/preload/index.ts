/**
 * Preload — contextBridge surface exposed as window.api
 * Every method typed; no raw ipcRenderer exposed.
 */
import { contextBridge, ipcRenderer, shell, webUtils } from 'electron'
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
  BackendSettings,
} from '../shared/types'
import type { DebugPrefs, SessionEntry, ObsEvent } from '../main/services/ObservabilityService'

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

  onChatStreamStockChartReady: (cb: (payload: { symbol: string; fileUri: string }) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, p: { symbol: string; fileUri: string }): void => cb(p)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STREAM_STOCK_CHART_READY, h)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STREAM_STOCK_CHART_READY, h)
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

  // ── Backend provider settings ─────────────────────────────────────
  getBackendSettings: (): Promise<BackendSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_BACKEND),

  saveBackendSettings: (patch: Partial<BackendSettings>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_BACKEND, patch),

  getOllamaModels: (baseUrl?: string, apiKey?: string): Promise<{ models: string[]; error: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_OLLAMA_MODELS, baseUrl, apiKey),

  getOpenRouterModels: (apiKey?: string): Promise<{ models: string[]; modalities: Record<string, string[]>; pricing: Record<string, { prompt: number | null; completion: number | null; cacheRead: number | null }>; error: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_OPENROUTER_MODELS, apiKey),

  getOpenRouterStats: (apiKey?: string): Promise<{
    credits:  { total_credits: number; total_usage: number } | null
    activity: { usage: number; requests: number; prompt_tokens: number; completion_tokens: number } | null
    error:    string | null
  }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_OPENROUTER_STATS, apiKey),

  restartApp: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_RESTART),

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

  mcpRespondToPermission: (r: import('../shared/types').McpToolPermissionResponse): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_TOOL_PERMISSION_RESPONSE, r),

  setBypassPermissions: (bypass: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_BYPASS_PERMISSIONS_CHANGED, bypass),

  setServerApprovalMode: (serverName: string, requiresApproval: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_SET_SERVER_APPROVAL_MODE, { serverName, requiresApproval }),

  mcpSetToolEnabled: (serverName: string, toolName: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_SET_TOOL_ENABLED, { serverName, toolName, enabled }),

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

  // ── Observability ────────────────────────────────────────────
  obsGetPrefs: (): Promise<DebugPrefs> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_GET_PREFS),

  obsSetPrefs: (patch: Partial<DebugPrefs>): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_SET_PREFS, patch),

  obsListSessions: (): Promise<SessionEntry[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_LIST_SESSIONS),

  obsOpenSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_OPEN_SESSION, sessionId),

  obsDeleteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_DELETE_SESSION, sessionId),

  obsClearAll: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_CLEAR_ALL),

  obsGetLogsDir: (): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_GET_LOGS_DIR),

  obsTotalSize: (): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_TOTAL_SIZE),

  obsCaptureArtifact: (event: ObsEvent): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OBS_CAPTURE_ARTIFACT, event),

  // ── Suggestion cards ─────────────────────────────────────────
  getSuggestions: (): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_SUGGESTIONS),

  saveSuggestions: (cards: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_SUGGESTIONS, cards),

  // ── Per-chat system instructions ─────────────────────────────
  getChatSystemInstructions: (chatId: string): Promise<string | null> =>
    ipcRenderer.invoke('chat:get-system-instructions', chatId),

  setChatSystemInstructions: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:set-system-instructions', chatId, text),

  // ── RAG v2 settings (Phase 3+4) ─────────────────────────────
  ragGetSettings: (): Promise<{ rerankEnabled: boolean; ragVerboseTrace: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_RAG),

  ragSaveSettings: (patch: { rerankEnabled?: boolean; ragVerboseTrace?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SAVE_RAG, patch),

  // ── RAG v2 diagnostics (Phase 4) ────────────────────────────
  ragListDocs: (chatId: string): Promise<Array<{ docId: string; docName: string; mode: string; tokenCount: number; chunkCount: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_LIST_DOCS, chatId),

  ragExportChunks: (docId: string): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_EXPORT_CHUNKS, docId),

  ragRunEval: (opts: { filePath: string; chatId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_RUN_EVAL, opts),

  ragPickEvalFile: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_PICK_EVAL_FILE),

  // ── RAG v2 diagnostics (Phase 5 — chat selector + config) ───────
  ragListDocChats: (): Promise<Array<{
    chatId: string; title: string; docCount: number; indexedDocCount: number; totalChunks: number
  }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_LIST_DOC_CHATS),

  ragGetConfig: (): Promise<{
    CHUNK_TOKENS: number; CHUNK_OVERLAP_TOKENS: number
    FINAL_K: number; FINAL_K_RERANKED: number
    K_LEXICAL: number; K_VECTOR: number; RRF_K: number
    VEC_DISTANCE_FLOOR: number; CONTEXT_TOKEN_BUDGET: number
    EMBEDDING_MODEL_ID: string; EMBEDDING_DIM: number
    RERANKER_MODEL_ID: string
  }> =>
    ipcRenderer.invoke(IPC_CHANNELS.RAG_GET_CONFIG),

  // ── Shell utilities ──────────────────────────────────────────
  openExternal: (url: string): Promise<void> => shell.openExternal(url),

  // ── Window state ─────────────────────────────────────────────
  isFullscreen: (): Promise<boolean> =>
    ipcRenderer.invoke('window:isFullscreen'),

  onFullscreenChange: (cb: (isFullscreen: boolean) => void): (() => void) => {
    const h = (_: Electron.IpcRendererEvent, val: boolean): void => cb(val)
    ipcRenderer.on('window:fullscreenChange', h)
    return () => ipcRenderer.removeListener('window:fullscreenChange', h)
  },

  // Electron 32+ removed File.path from the renderer — use webUtils.getPathForFile
  // bridged through the preload instead. Called synchronously before IPC send.
  getFilePath: (file: File): string => webUtils.getPathForFile(file),

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
