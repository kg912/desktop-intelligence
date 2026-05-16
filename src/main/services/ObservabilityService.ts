import { app } from 'electron'
import path from 'path'
import { readSettings, writeSettings } from './SettingsStore'

// ── Public types ──────────────────────────────────────────────────────────────

export interface DebugPrefs {
  observabilityEnabled: boolean
  includeImages: boolean
}

export interface SessionEntry {
  sessionId: string
  chatId: string
  modelId: string
  provider: string
  startedAt: string
  hasImages: boolean
  sizeBytes: number
  filePath: string
}

export type ObsEventType =
  | 'session_start'
  | 'system_prompt'
  | 'rag_chunks'
  | 'messages_sent'
  | 'thinking_delta'
  | 'answer_delta'
  | 'tool_call'
  | 'tool_result'
  | 'image_artifact'
  | 'code_artifact'
  | 'chart_image'
  | 'session_end'

export interface ObsEvent {
  type: ObsEventType
  payload: Record<string, unknown>
  ts: number
}

// ── Internal buffer types (not exported) ─────────────────────────────────────

interface ToolCallEntry {
  toolName: string
  args:     Record<string, unknown>
  result?:  string
}

interface SessionBuffer {
  chatId:       string
  modelId:      string
  provider:     string
  startedAt:    string
  hasImages:    boolean

  systemPrompt: string
  ragChunks:    Array<{ source: string; content: string }>
  messagesSent: unknown[]

  thinkingBuf:  string
  answerBuf:    string
  toolCalls:    ToolCallEntry[]

  imageArtifacts: Array<{ label: string; ext: string; base64: string }>
  codeArtifacts:  Array<{ label: string; language: string; code: string }>
  chartImages:    Array<{ label: string; base64: string; pySource?: string }>

  finishReason?: string
  durationMs?:   number
  promptTokens?: number
  outputTokens?: number
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ObservabilityService {
  private readonly logsDir: string
  private readonly sessions = new Map<string, SessionBuffer>()

  constructor() {
    this.logsDir = path.join(app.getPath('userData'), 'observability-logs')
  }

  isEnabled(): boolean {
    return readSettings().observabilityEnabled ?? false
  }

  includeImages(): boolean {
    return this.isEnabled() && (readSettings().includeImages ?? false)
  }

  getLogsDir(): string {
    return this.logsDir
  }

  getPrefs(): DebugPrefs {
    const s = readSettings()
    return {
      observabilityEnabled: s.observabilityEnabled ?? false,
      includeImages:        s.includeImages        ?? false,
    }
  }

  setPrefs(patch: Partial<DebugPrefs>): void {
    writeSettings(patch)
  }

  // --- Capture API ---

  startSession(chatId: string, modelId: string, provider: string): string {
    if (!this.isEnabled()) return ''
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(sessionId, {
      chatId,
      modelId,
      provider,
      startedAt:      new Date().toISOString(),
      hasImages:      this.includeImages(),
      systemPrompt:   '',
      ragChunks:      [],
      messagesSent:   [],
      thinkingBuf:    '',
      answerBuf:      '',
      toolCalls:      [],
      imageArtifacts: [],
      codeArtifacts:  [],
      chartImages:    [],
    })
    return sessionId
  }

  capture(sessionId: string, event: ObsEvent): void {
    if (!this.isEnabled()) return
    if (!sessionId)        return
    const buf = this.sessions.get(sessionId)
    if (!buf) return

    switch (event.type) {
      case 'system_prompt':
        buf.systemPrompt = String(event.payload.text ?? '')
        break

      case 'rag_chunks':
        buf.ragChunks = (event.payload.chunks as Array<{ source: string; content: string }>) ?? []
        break

      case 'messages_sent':
        buf.messagesSent = (event.payload.messages as unknown[]) ?? []
        break

      case 'thinking_delta':
        buf.thinkingBuf += String(event.payload.text ?? '')
        break

      case 'answer_delta':
        buf.answerBuf += String(event.payload.text ?? '')
        break

      case 'tool_call':
        buf.toolCalls.push({
          toolName: String(event.payload.toolName ?? ''),
          args:     (event.payload.args as Record<string, unknown>) ?? {},
        })
        break

      case 'tool_result': {
        const entry = [...buf.toolCalls].reverse()
          .find((t) => t.toolName === String(event.payload.toolName ?? '') && t.result === undefined)
        if (entry) entry.result = String(event.payload.result ?? '')
        break
      }

      case 'code_artifact':
        buf.codeArtifacts.push({
          label:    String(event.payload.label ?? ''),
          language: String(event.payload.language ?? ''),
          code:     String(event.payload.code ?? ''),
        })
        break

      case 'image_artifact':
      case 'chart_image':
        break

      case 'session_end':
        buf.finishReason  = String(event.payload.finishReason ?? '')
        buf.durationMs    = Number(event.payload.durationMs ?? 0)
        buf.promptTokens  = Number(event.payload.promptTokens ?? 0)
        buf.outputTokens  = Number(event.payload.outputTokens ?? 0)
        break
    }
  }

  async endSession(sessionId: string): Promise<SessionBuffer | null> {
    if (!sessionId) return null
    const buf = this.sessions.get(sessionId)
    if (!buf) return null
    this.sessions.delete(sessionId)
    console.log(
      `[ObservabilityService] Session ${sessionId} ended —`,
      `${buf.answerBuf.length} answer chars,`,
      `${buf.toolCalls.length} tool calls,`,
      `${buf.thinkingBuf.length} thinking chars`
    )
    return buf
  }

  /** @internal — test use only */
  _getBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessions.get(sessionId)
  }

  // --- File selector API (stubs — Phase 4 will implement) ---

  async listSessions(): Promise<SessionEntry[]> {
    return []
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // Phase 4
  }

  async clearAllSessions(): Promise<void> {
    // Phase 4
  }

  async getTotalSizeBytes(): Promise<number> {
    return 0
  }
}

export const observabilityService = new ObservabilityService()
