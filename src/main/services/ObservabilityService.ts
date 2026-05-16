import { app } from 'electron'
import path from 'path'
import { readSettings, writeSettings } from './SettingsStore'

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

export class ObservabilityService {
  private readonly logsDir: string

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

  // --- Capture API (stubs — Phase 2 will implement) ---

  startSession(_chatId: string): string {
    return '' // Phase 2
  }

  capture(_sessionId: string, _event: ObsEvent): void {
    if (!this.isEnabled()) return // fast-exit — no allocations
    // Phase 2: buffer event
  }

  async endSession(_sessionId: string): Promise<void> {
    // Phase 2: flush + write file
  }

  // --- File selector API (stubs — Phase 4 will implement) ---

  async listSessions(): Promise<SessionEntry[]> {
    return [] // Phase 4
  }

  async deleteSession(_sessionId: string): Promise<void> {
    // Phase 4
  }

  async clearAllSessions(): Promise<void> {
    // Phase 4
  }

  async getTotalSizeBytes(): Promise<number> {
    return 0 // Phase 4
  }
}

export const observabilityService = new ObservabilityService()
