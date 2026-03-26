// ============================================================
// Shared Types — single source of truth for the IPC contract
// ============================================================

// --- Model / Daemon Status ---
export type ModelStatus =
  | 'loading'
  | 'connecting'
  | 'ready'
  | 'offline'
  | 'error'

export interface ModelInfo {
  id: string
  object: string
  created: number
  owned_by: string
}

export interface ConnectionState {
  status:         ModelStatus
  modelInfo:      ModelInfo | null
  lastChecked:    number | null
  error:          string | null
  pollIntervalMs: number
}

// --- Daemon lifecycle ---
export type DaemonPhase =
  | 'idle'
  | 'preflight'
  | 'starting-server'
  | 'loading-model'
  | 'ready'
  | 'error'

export interface DaemonState {
  phase:  DaemonPhase
  error:  string | null
  stderr: string | null
}

// --- Chat ---
export interface ChatMessage {
  id:        string
  role:      'user' | 'assistant' | 'system'
  content:   string
  createdAt: number
}

export interface Chat {
  id:        string
  title:     string
  createdAt: number
  updatedAt: number
}

/**
 * Wire message shape sent over IPC — lean, no id/timestamp overhead.
 */
export interface WireMessage {
  role:    'user' | 'assistant' | 'system'
  content: string
}

/**
 * Message shape returned by getChatMessages — extends WireMessage with
 * serialised attachment metadata so the UI can re-render file pills when
 * loading historical conversations.
 */
export interface StoredMessage extends WireMessage {
  /** JSON-encoded MessageAttachment[] or null when no files were attached */
  attachmentsJson: string | null
}

// --- File Attachments ---

/** Sent by renderer to main to request file processing */
export interface AttachmentFilePayload {
  filePath: string
  fileName: string
  mimeType: string
  size:     number
  /** Active chat session — stored with the document so RAG retrieval can be scoped per-chat */
  chatId?:  string
}

export type AttachmentKind = 'image' | 'document'

/** Processed file ready to be included in a chat request */
export interface ProcessedAttachment {
  id:      string
  name:    string
  kind:    AttachmentKind
  /** base64 data URL for images; null for documents */
  dataUrl: string | null
  /** system-prompt text to inject for documents; null for images */
  inject:  string | null
}

// --- Web Search ---

export interface WebSearchStatus {
  status: 'searching' | 'done' | 'failed'
  query?: string
}

export type ThinkingMode = 'thinking' | 'fast'

export interface ChatSendPayload {
  messages:       WireMessage[]
  systemPrompt?:  string
  attachments?:   ProcessedAttachment[]
  /** Active chat session — used to scope RAG retrieval to this chat only */
  chatId?:        string
  /** LM Studio model identifier chosen by the frontend; falls back to DEFAULT_MODEL_ID */
  model?:         string
  /** Controls whether the model reasons before answering (Section 5 of CLAUDE.md) */
  thinkingMode?:  ThinkingMode
}

export interface GenerationStats {
  ttft:         number   // ms to first token
  tokensPerSec: number   // tokens / sec
  totalMs:      number   // total wall time
  totalTokens:  number   // estimated output tokens
  aborted?:     boolean
}

/**
 * The default model identifier used by the frontend store and the daemon startup.
 * Single source of truth shared between renderer and main process — changing this
 * string is the only edit needed to switch the default target model.
 */
export const DEFAULT_MODEL_ID = 'mlx-community/Qwen3.5-35B-A3B-6bit'

// --- IPC Channel Names ---
export const IPC_CHANNELS = {
  MODEL_GET_STATUS:    'model:getStatus',
  MODEL_STATUS_CHANGE: 'model:statusChange',
  MODEL_FORCE_POLL:    'model:forcePoll',

  DAEMON_GET_STATE:    'daemon:getState',
  DAEMON_STATE_CHANGE: 'daemon:stateChange',
  DAEMON_RETRY:        'daemon:retry',

  CHAT_SEND:           'chat:send',
  CHAT_STREAM_CHUNK:   'chat:streamChunk',
  CHAT_STREAM_END:     'chat:streamEnd',
  CHAT_ABORT:          'chat:abort',
  CHAT_ERROR:          'chat:error',

  RAG_INGEST_FILE:     'rag:ingestFile',
  RAG_INGEST_PROGRESS: 'rag:ingestProgress',

  WEB_SEARCH:          'web:search',
  WEB_SEARCH_STATUS:   'web:searchStatus',

  FILE_PROCESS:        'file:process',

  DB_GET_CHATS:        'db:getChats',
  DB_GET_MESSAGES:     'db:getMessages',
  DB_NEW_CHAT:         'db:newChat',
  DB_DELETE_CHAT:      'db:deleteChat',
  DB_SAVE_MESSAGE:     'db:saveMessage',
} as const

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS]

// --- LM Studio API shapes ---
export interface LMStudioModelsResponse {
  object: 'list'
  data: ModelInfo[]
}
