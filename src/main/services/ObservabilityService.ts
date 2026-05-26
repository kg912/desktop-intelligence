import { app } from 'electron'
import fs from 'fs/promises'
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

type TraceEvent =
  | { kind: 'thinking';       text: string }
  | { kind: 'text';           text: string }
  | { kind: 'tool_call';      toolName: string; args: Record<string, unknown>; result?: string }
  | { kind: 'chart_image';    label: string; base64: string; pySource?: string }
  | { kind: 'image_artifact'; label: string; ext: string; base64: string }

interface SessionBuffer {
  chatId:       string
  modelId:      string
  provider:     string
  startedAt:    string
  hasImages:    boolean

  systemPrompt: string
  ragChunks:    Array<{ source: string; content: string }>
  messagesSent: unknown[]

  trace: TraceEvent[]

  finishReason?: string
  durationMs?:   number
  promptTokens?: number
  outputTokens?: number
}

interface SessionMeta {
  sessionId:  string
  chatId:     string
  modelId:    string
  provider:   string
  startedAt:  string
  hasImages:  boolean
  sizeBytes:  number
  filePath:   string
}

// No truncation limit — observability logs capture full content

// ── Service ───────────────────────────────────────────────────────────────────

export class ObservabilityService {
  private readonly logsDir: string
  private readonly sessions = new Map<string, SessionBuffer>()
  private activeSessionId = ''
  private _enabled      = false
  private _includeImages = false

  constructor() {
    // Guard: app.getPath is unavailable in vitest (node environment with no
    // Electron runtime). Fall back to a safe no-op path so the module can be
    // imported by test files without crashing. The service stays disabled
    // (this._enabled = false) so all capture calls are no-ops in tests.
    try {
      this.logsDir = path.join(app.getPath('userData'), 'observability-logs')
    } catch {
      this.logsDir = path.join('/tmp', 'di-observability-logs')
    }
    try {
      const s = readSettings()
      this._enabled       = s.observabilityEnabled ?? false
      this._includeImages = s.includeImages ?? false
    } catch {
      this._enabled       = false
      this._includeImages = false
    }
  }

  isEnabled(): boolean {
    return this._enabled
  }

  includeImages(): boolean {
    return this._enabled && this._includeImages
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
    // Keep in-memory cache in sync — avoids readSettings() on next isEnabled() call
    if (patch.observabilityEnabled !== undefined) {
      this._enabled = patch.observabilityEnabled
    }
    if (patch.includeImages !== undefined) {
      this._includeImages = patch.includeImages
    }
  }

  // --- Capture API ---

  startSession(chatId: string, modelId: string, provider: string): string {
    if (!this.isEnabled()) return ''
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(sessionId, {
      chatId,
      modelId,
      provider,
      startedAt:    new Date().toISOString(),
      hasImages:    this.includeImages(),
      systemPrompt: '',
      ragChunks:    [],
      messagesSent: [],
      trace:        [],
    })
    this.activeSessionId = sessionId
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

      case 'thinking_delta': {
        const delta = String(event.payload.text ?? '')
        if (!delta) break
        const last = buf.trace[buf.trace.length - 1]
        if (last?.kind === 'thinking') {
          last.text += delta
        } else {
          buf.trace.push({ kind: 'thinking', text: delta })
        }
        break
      }

      case 'answer_delta': {
        const delta = String(event.payload.text ?? '')
        if (!delta) break
        const last = buf.trace[buf.trace.length - 1]
        if (last?.kind === 'text') {
          last.text += delta
        } else {
          buf.trace.push({ kind: 'text', text: delta })
        }
        break
      }

      case 'tool_call':
        buf.trace.push({
          kind:     'tool_call',
          toolName: String(event.payload.toolName ?? ''),
          args:     (event.payload.args as Record<string, unknown>) ?? {},
        })
        break

      case 'tool_result': {
        const name = String(event.payload.toolName ?? '')
        const entry = [...buf.trace]
          .reverse()
          .find((e): e is Extract<TraceEvent, { kind: 'tool_call' }> =>
            e.kind === 'tool_call' && e.toolName === name && e.result === undefined
          )
        if (entry) entry.result = String(event.payload.result ?? '')
        break
      }

      case 'session_end':
        buf.finishReason  = String(event.payload.finishReason ?? '')
        buf.durationMs    = Number(event.payload.durationMs ?? 0)
        buf.promptTokens  = Number(event.payload.promptTokens ?? 0)
        buf.outputTokens  = Number(event.payload.outputTokens ?? 0)
        break

      // chart_image and image_artifact pushed via captureArtifact (renderer IPC)
      case 'chart_image':
      case 'image_artifact':
      case 'code_artifact':
        break
    }
  }

  async endSession(sessionId: string): Promise<void> {
    if (!sessionId) return
    const buf = this.sessions.get(sessionId)
    if (!buf) return
    console.log(`[ObservabilityService] Session ${sessionId} ended — ${buf.trace.length} trace events`)
    setImmediate(() => {
      this._writeSession(sessionId, buf).catch((err) =>
        console.error('[ObservabilityService] Write failed:', err)
      )
    })
    // activeSessionId cleared inside _writeSession after write completes
  }

  /** @internal — test use only */
  _getBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessions.get(sessionId)
  }

  captureArtifact(event: ObsEvent): void {
    if (!this.isEnabled()) return
    if (!this.activeSessionId) return
    if (!this.sessions.has(this.activeSessionId)) return
    const buf = this.sessions.get(this.activeSessionId)
    if (!buf) return

    switch (event.type) {
      case 'chart_image':
        buf.trace.push({
          kind:     'chart_image',
          label:    String(event.payload.label ?? 'chart'),
          base64:   String(event.payload.base64 ?? ''),
          pySource: event.payload.pySource as string | undefined,
        })
        break
      case 'image_artifact':
        buf.trace.push({
          kind:   'image_artifact',
          label:  String(event.payload.label ?? 'image'),
          ext:    String(event.payload.ext ?? 'png'),
          base64: String(event.payload.base64 ?? ''),
        })
        break
    }
  }

  // --- Helpers ---

  private truncateMessages(messages: unknown[]): unknown[] {
    return messages
  }

  // --- File writer ---

  private async writeSessionPlain(sessionId: string, buf: SessionBuffer): Promise<void> {
    const lines: string[] = []
    const OUTER = '='.repeat(80)
    const section = (title: string) =>
      `── ${title} ${'─'.repeat(Math.max(0, 76 - title.length))}`

    lines.push(OUTER)
    lines.push('DESKTOP INTELLIGENCE — OBSERVABILITY LOG')
    lines.push(`Session : ${sessionId}`)
    lines.push(`Chat    : ${buf.chatId}`)
    lines.push(`Model   : ${buf.modelId}  (${buf.provider})`)
    lines.push(`Started : ${buf.startedAt}`)
    lines.push(`Finish  : ${buf.finishReason ?? ''}`)
    lines.push(`Tokens  : ${buf.promptTokens ?? 0} in / ${buf.outputTokens ?? 0} out`)
    lines.push(`Duration: ${buf.durationMs ?? 0} ms`)
    lines.push(OUTER)
    lines.push('')

    if (buf.systemPrompt) {
      lines.push(section('SYSTEM PROMPT'))
      lines.push(buf.systemPrompt)
      lines.push('')
    }

    if (buf.ragChunks.length > 0) {
      lines.push(section('RAG CONTEXT'))
      for (let i = 0; i < buf.ragChunks.length; i++) {
        const chunk = buf.ragChunks[i]
        lines.push(`[Chunk ${i} | source: ${chunk.source}]`)
        lines.push(chunk.content)
        lines.push('')
      }
    }

    if (buf.messagesSent.length > 0) {
      lines.push(section(`MESSAGES SENT (${buf.messagesSent.length})`))
      lines.push(JSON.stringify(this.truncateMessages(buf.messagesSent), null, 2))
      lines.push('')
    }

    if (buf.trace.length > 0) {
      lines.push(section('TRACE'))
      lines.push('')

      for (const event of buf.trace) {
        switch (event.kind) {
          case 'thinking':
            lines.push('▶ THINKING')
            lines.push(event.text)
            break

          case 'text':
            lines.push('▶ OUTPUT')
            lines.push(event.text)
            break

          case 'tool_call': {
            lines.push(`▶ TOOL CALL  ${event.toolName}`)
            lines.push(`Args: ${JSON.stringify(event.args)}`)
            if (event.result === undefined) {
              lines.push('Result: [no result captured]')
            } else {
              lines.push(`Result: ${event.result}`)
            }
            break
          }

          case 'chart_image':
            lines.push(`▶ CHART  ${event.label}`)
            lines.push('[Chart image — enable "Include Images" to capture]')
            if (event.pySource) {
              lines.push('[Python source below]')
              lines.push(event.pySource)
            }
            break

          case 'image_artifact':
            lines.push(`▶ IMAGE  ${event.label}.${event.ext}`)
            lines.push('[Image — enable "Include Images" to capture]')
            break
        }
        lines.push('')
      }
    }

    const logPath  = path.join(this.logsDir, `${sessionId}.log`)
    const metaPath = path.join(this.logsDir, `${sessionId}.meta.json`)
    const logText  = lines.join('\n')

    await fs.writeFile(logPath, logText, 'utf8')

    const sizeBytes = Buffer.byteLength(logText, 'utf8')
    const meta: SessionMeta = {
      sessionId,
      chatId:    buf.chatId,
      modelId:   buf.modelId,
      provider:  buf.provider,
      startedAt: buf.startedAt,
      hasImages: false,
      sizeBytes,
      filePath:  logPath,
    }
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
  }

  private async writeSessionImages(sessionId: string, buf: SessionBuffer): Promise<void> {
    const sessionDir = path.join(this.logsDir, sessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    const mdLines: string[] = []

    mdLines.push(`# Observability Log — ${sessionId}`)
    mdLines.push('')
    mdLines.push('| Field | Value |')
    mdLines.push('|----------|-------|')
    mdLines.push(`| Chat | \`${buf.chatId}\` |`)
    mdLines.push(`| Model | \`${buf.modelId}\` (\`${buf.provider}\`) |`)
    mdLines.push(`| Started | ${buf.startedAt} |`)
    mdLines.push(`| Finish | ${buf.finishReason ?? ''} |`)
    mdLines.push(`| Tokens | ${buf.promptTokens ?? 0} in / ${buf.outputTokens ?? 0} out |`)
    mdLines.push(`| Duration | ${buf.durationMs ?? 0} ms |`)
    mdLines.push('')

    if (buf.systemPrompt) {
      mdLines.push('## System Prompt')
      mdLines.push('')
      mdLines.push('```')
      mdLines.push(buf.systemPrompt)
      mdLines.push('```')
      mdLines.push('')
    }

    if (buf.ragChunks.length > 0) {
      mdLines.push('## RAG Context')
      mdLines.push('')
      for (let i = 0; i < buf.ragChunks.length; i++) {
        const chunk = buf.ragChunks[i]
        mdLines.push(`### Chunk ${i} — ${chunk.source}`)
        mdLines.push('')
        mdLines.push(chunk.content)
        mdLines.push('')
      }
    }

    if (buf.messagesSent.length > 0) {
      mdLines.push('## Messages Sent')
      mdLines.push('')
      mdLines.push('```json')
      mdLines.push(JSON.stringify(this.truncateMessages(buf.messagesSent), null, 2))
      mdLines.push('```')
      mdLines.push('')
    }

    if (buf.trace.length > 0) {
      mdLines.push('## Trace')
      mdLines.push('')

      let chartN = 0
      let imgN   = 0
      let tcN    = 0

      for (let i = 0; i < buf.trace.length; i++) {
        const event = buf.trace[i]

        switch (event.kind) {
          case 'thinking':
            mdLines.push('### 🧠 Thinking')
            mdLines.push('')
            mdLines.push(event.text)
            break

          case 'text':
            mdLines.push('### 💬 Output')
            mdLines.push('')
            mdLines.push(event.text)
            break

          case 'tool_call': {
            tcN++
            mdLines.push(`### 🔧 Tool Call — ${event.toolName}`)
            mdLines.push('')
            mdLines.push('Args:')
            mdLines.push('```json')
            mdLines.push(JSON.stringify(event.args, null, 2))
            mdLines.push('```')
            if (event.result === undefined) {
              mdLines.push('Result: [no result captured]')
            } else {
              mdLines.push('Result:')
              mdLines.push('```')
              mdLines.push(event.result)
              mdLines.push('```')
            }
            break
          }

          case 'chart_image': {
            const n      = chartN++
            const label  = event.label || 'chart'
            const pngFname = `chart_${n}_${label}.png`
            await fs.writeFile(path.join(sessionDir, pngFname), Buffer.from(event.base64, 'base64'))
            mdLines.push(`### 📊 Chart — ${label}`)
            mdLines.push('')
            mdLines.push(`![${label}](./${pngFname})`)
            if (event.pySource) {
              const pyFname = `chart_${n}_${label}.py`
              await fs.writeFile(path.join(sessionDir, pyFname), event.pySource, 'utf8')
              mdLines.push('')
              mdLines.push(`**Source:** [${pyFname}](./${pyFname})`)
            }
            break
          }

          case 'image_artifact': {
            const n      = imgN++
            const label  = event.label || 'image'
            const fname  = `image_${n}_${label}.${event.ext || 'png'}`
            await fs.writeFile(path.join(sessionDir, fname), Buffer.from(event.base64, 'base64'))
            mdLines.push(`### 🖼 Image — ${label}`)
            mdLines.push('')
            mdLines.push(`![${label}](./${fname})`)
            break
          }
        }

        // Separator between trace events (not after the last one)
        if (i < buf.trace.length - 1) {
          mdLines.push('')
          mdLines.push('---')
        }
        mdLines.push('')
      }
    }

    const mdPath   = path.join(sessionDir, 'session.md')
    const metaPath = path.join(sessionDir, 'session.meta.json')
    const mdText   = mdLines.join('\n')

    await fs.writeFile(mdPath, mdText, 'utf8')

    const sizeBytes = Buffer.byteLength(mdText, 'utf8')
    const meta: SessionMeta = {
      sessionId,
      chatId:    buf.chatId,
      modelId:   buf.modelId,
      provider:  buf.provider,
      startedAt: buf.startedAt,
      hasImages: true,
      sizeBytes,
      filePath:  sessionDir,
    }
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8')
  }

  private async _writeSession(sessionId: string, buf: SessionBuffer): Promise<void> {
    await fs.mkdir(this.logsDir, { recursive: true })
    if (buf.hasImages) {
      await this.writeSessionImages(sessionId, buf)
    } else {
      await this.writeSessionPlain(sessionId, buf)
    }
    this.sessions.delete(sessionId)
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = ''
    }
    console.log(`[ObservabilityService] Wrote session ${sessionId} (hasImages=${buf.hasImages})`)
  }

  // --- File selector API ---

  async listSessions(): Promise<SessionEntry[]> {
    try {
      const entries = await fs.readdir(this.logsDir, { withFileTypes: true })
      const results: SessionMeta[] = []

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.meta.json') && !entry.name.startsWith('.')) {
          try {
            const raw = await fs.readFile(path.join(this.logsDir, entry.name), 'utf8')
            results.push(JSON.parse(raw) as SessionMeta)
          } catch {
            // corrupt meta — skip
          }
        } else if (entry.isDirectory()) {
          const metaPath = path.join(this.logsDir, entry.name, 'session.meta.json')
          try {
            const raw = await fs.readFile(metaPath, 'utf8')
            results.push(JSON.parse(raw) as SessionMeta)
          } catch {
            // no meta or corrupt — skip
          }
        }
      }

      results.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return results
    } catch {
      return []
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const logPath  = path.join(this.logsDir, `${sessionId}.log`)
    const metaPath = path.join(this.logsDir, `${sessionId}.meta.json`)
    try { await fs.unlink(logPath)  } catch { /* not found */ }
    try { await fs.unlink(metaPath) } catch { /* not found */ }

    const sessionDir = path.join(this.logsDir, sessionId)
    try {
      await fs.rm(sessionDir, { recursive: true, force: true })
    } catch { /* not found */ }
  }

  async clearAllSessions(): Promise<void> {
    try {
      await fs.rm(this.logsDir, { recursive: true, force: true })
    } catch { /* already gone */ }
    await fs.mkdir(this.logsDir, { recursive: true })
  }

  async getTotalSizeBytes(): Promise<number> {
    try {
      const entries = await fs.readdir(this.logsDir, { withFileTypes: true })
      let total = 0
      for (const entry of entries) {
        const entryPath = path.join(this.logsDir, entry.name)
        if (entry.isFile()) {
          const stat = await fs.stat(entryPath)
          total += stat.size
        } else if (entry.isDirectory()) {
          try {
            const subEntries = await fs.readdir(entryPath, { withFileTypes: true })
            for (const sub of subEntries) {
              if (sub.isFile()) {
                const stat = await fs.stat(path.join(entryPath, sub.name))
                total += stat.size
              }
            }
          } catch { /* skip */ }
        }
      }
      return total
    } catch {
      return 0
    }
  }
}

export const observabilityService = new ObservabilityService()
