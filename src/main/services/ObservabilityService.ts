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

const THINKING_LIMIT    = 50000
const TOOL_RESULT_LIMIT = 8000

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

  async endSession(sessionId: string): Promise<void> {
    if (!sessionId) return
    const buf = this.sessions.get(sessionId)
    if (!buf) return
    this.sessions.delete(sessionId)
    console.log(
      `[ObservabilityService] Session ${sessionId} ended —`,
      `${buf.answerBuf.length} answer chars,`,
      `${buf.toolCalls.length} tool calls,`,
      `${buf.thinkingBuf.length} thinking chars`
    )
    setImmediate(() => {
      this._writeSession(sessionId, buf).catch((err) =>
        console.error('[ObservabilityService] Write failed:', err)
      )
    })
  }

  /** @internal — test use only */
  _getBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessions.get(sessionId)
  }

  // --- Helpers ---

  // Fix 5: truncate each message's content field individually before serialising
  private truncateMessages(messages: unknown[]): unknown[] {
    return messages.map((msg) => {
      if (typeof msg !== 'object' || msg === null) return msg
      const m = msg as Record<string, unknown>
      if (typeof m['content'] === 'string' && m['content'].length > 2000) {
        return {
          ...m,
          content: m['content'].slice(0, 2000) + '\n[… truncated]',
        }
      }
      return m
    })
  }

  // Fix 4: truncate long buffers with suffix
  private truncateBuf(text: string): string {
    if (text.length <= THINKING_LIMIT) return text
    return text.slice(0, THINKING_LIMIT) + `\n[… truncated at ${THINKING_LIMIT} chars]`
  }

  // --- File writer ---

  private async writeSessionPlain(sessionId: string, buf: SessionBuffer): Promise<void> {
    const lines: string[] = []
    const hr = '─'.repeat(72)

    lines.push(`SESSION  ${sessionId}`)
    lines.push(`Chat     ${buf.chatId}`)
    lines.push(`Model    ${buf.modelId}`)
    lines.push(`Provider ${buf.provider}`)
    lines.push(`Started  ${buf.startedAt}`)
    lines.push(`Finish   ${buf.finishReason ?? ''}`)
    lines.push(`Duration ${buf.durationMs ?? 0} ms`)
    lines.push(`Tokens   prompt=${buf.promptTokens ?? 0}  output=${buf.outputTokens ?? 0}`)
    lines.push('')

    if (buf.systemPrompt) {
      lines.push(hr)
      lines.push('SYSTEM PROMPT')
      lines.push(hr)
      lines.push(buf.systemPrompt.slice(0, 8000))
      lines.push('')
    }

    if (buf.ragChunks.length > 0) {
      lines.push(hr)
      lines.push(`RAG CHUNKS  (${buf.ragChunks.length})`)
      lines.push(hr)
      for (const chunk of buf.ragChunks) {
        lines.push(`[${chunk.source}]`)
        lines.push(chunk.content.slice(0, 2000))
        lines.push('')
      }
    }

    // Fix 5: use truncateMessages helper; no whole-JSON slice
    if (buf.messagesSent.length > 0) {
      lines.push(hr)
      lines.push(`MESSAGES SENT  (${buf.messagesSent.length})`)
      lines.push(hr)
      lines.push(JSON.stringify(this.truncateMessages(buf.messagesSent), null, 2))
      lines.push('')
    }

    // Fix 4: 50K limit with suffix
    if (buf.thinkingBuf) {
      lines.push(hr)
      lines.push('THINKING')
      lines.push(hr)
      lines.push(this.truncateBuf(buf.thinkingBuf))
      lines.push('')
    }

    if (buf.answerBuf) {
      lines.push(hr)
      lines.push('ANSWER')
      lines.push(hr)
      lines.push(this.truncateBuf(buf.answerBuf))
      lines.push('')
    }

    // Fix 3: inline truncation at 8K with suffix
    if (buf.toolCalls.length > 0) {
      lines.push(hr)
      lines.push(`TOOL CALLS  (${buf.toolCalls.length})`)
      lines.push(hr)
      for (const tc of buf.toolCalls) {
        lines.push(`Tool: ${tc.toolName}`)
        lines.push(`Args: ${JSON.stringify(tc.args)}`)
        if (tc.result !== undefined) {
          const result = tc.result.length > TOOL_RESULT_LIMIT
            ? tc.result.slice(0, TOOL_RESULT_LIMIT) + `\n[… truncated at ${TOOL_RESULT_LIMIT} chars]`
            : tc.result
          lines.push(`Result: ${result}`)
        }
        lines.push('')
      }
    }

    if (buf.codeArtifacts.length > 0) {
      lines.push(hr)
      lines.push(`CODE ARTIFACTS  (${buf.codeArtifacts.length})`)
      lines.push(hr)
      for (const ca of buf.codeArtifacts) {
        lines.push(`[${ca.label}] (${ca.language})`)
        lines.push(ca.code.slice(0, 8000))
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

    mdLines.push(`# Session ${sessionId}`)
    mdLines.push('')
    mdLines.push(`| Field | Value |`)
    mdLines.push(`|---|---|`)
    mdLines.push(`| Chat | ${buf.chatId} |`)
    mdLines.push(`| Model | ${buf.modelId} |`)
    mdLines.push(`| Provider | ${buf.provider} |`)
    mdLines.push(`| Started | ${buf.startedAt} |`)
    mdLines.push(`| Finish | ${buf.finishReason ?? ''} |`)
    mdLines.push(`| Duration | ${buf.durationMs ?? 0} ms |`)
    mdLines.push(`| Tokens | prompt=${buf.promptTokens ?? 0} output=${buf.outputTokens ?? 0} |`)
    mdLines.push('')

    if (buf.systemPrompt) {
      mdLines.push('## System Prompt')
      mdLines.push('')
      mdLines.push('```')
      mdLines.push(buf.systemPrompt.slice(0, 8000))
      mdLines.push('```')
      mdLines.push('')
    }

    if (buf.ragChunks.length > 0) {
      mdLines.push(`## RAG Chunks (${buf.ragChunks.length})`)
      mdLines.push('')
      for (const chunk of buf.ragChunks) {
        mdLines.push(`**[${chunk.source}]**`)
        mdLines.push('')
        mdLines.push(chunk.content.slice(0, 2000))
        mdLines.push('')
      }
    }

    // Fix 2: Messages Sent section (after RAG chunks, before Thinking)
    // Fix 5: use truncateMessages helper
    if (buf.messagesSent.length > 0) {
      mdLines.push(`## Messages Sent (${buf.messagesSent.length})`)
      mdLines.push('')
      mdLines.push('```json')
      mdLines.push(JSON.stringify(this.truncateMessages(buf.messagesSent), null, 2))
      mdLines.push('```')
      mdLines.push('')
    }

    // Fix 4: 50K limit with suffix
    if (buf.thinkingBuf) {
      mdLines.push('## Thinking')
      mdLines.push('')
      mdLines.push(this.truncateBuf(buf.thinkingBuf))
      mdLines.push('')
    }

    if (buf.answerBuf) {
      mdLines.push('## Answer')
      mdLines.push('')
      mdLines.push(this.truncateBuf(buf.answerBuf))
      mdLines.push('')
    }

    // Fix 3: image tool results — inline ≤ 8K, sidecar > 8K
    if (buf.toolCalls.length > 0) {
      mdLines.push(`## Tool Calls (${buf.toolCalls.length})`)
      mdLines.push('')
      let tcIdx = 0
      for (const tc of buf.toolCalls) {
        const n = tcIdx++
        mdLines.push(`### ${tc.toolName}`)
        mdLines.push('```json')
        mdLines.push(JSON.stringify(tc.args, null, 2))
        mdLines.push('```')
        if (tc.result !== undefined) {
          if (tc.result.length <= TOOL_RESULT_LIMIT) {
            mdLines.push('**Result:**')
            mdLines.push('```')
            mdLines.push(tc.result)
            mdLines.push('```')
          } else {
            const sidecarName = `tool_result_${tc.toolName}_${n}.txt`
            const sidecarPath = path.join(sessionDir, sidecarName)
            await fs.writeFile(sidecarPath, tc.result, 'utf8')
            mdLines.push(`**Result:** [view full result](./${sidecarName})`)
          }
        }
        mdLines.push('')
      }
    }

    if (buf.codeArtifacts.length > 0) {
      mdLines.push(`## Code Artifacts (${buf.codeArtifacts.length})`)
      mdLines.push('')
      for (const ca of buf.codeArtifacts) {
        mdLines.push(`### ${ca.label || 'Untitled'}`)
        mdLines.push(`\`\`\`${ca.language}`)
        mdLines.push(ca.code.slice(0, 8000))
        mdLines.push('```')
        mdLines.push('')
      }
    }

    // Write image sidecars
    let imgIdx = 0
    for (const img of buf.imageArtifacts) {
      const n = imgIdx++
      const fname = `image_${n}_${img.label || 'artifact'}.${img.ext || 'png'}`
      await fs.writeFile(path.join(sessionDir, fname), Buffer.from(img.base64, 'base64'))
      mdLines.push(`## Image: ${img.label || fname}`)
      mdLines.push('')
      mdLines.push(`![${img.label}](./${fname})`)
      mdLines.push('')
    }

    // Fix 6: write .py sidecar instead of inline fenced code block
    let chartIdx = 0
    for (const chart of buf.chartImages) {
      const n = chartIdx++
      const label = chart.label || 'chart'
      const pngFname = `chart_${n}_${label}.png`
      await fs.writeFile(path.join(sessionDir, pngFname), Buffer.from(chart.base64, 'base64'))
      mdLines.push(`## Chart: ${label}`)
      mdLines.push('')
      mdLines.push(`![${label}](./${pngFname})`)
      mdLines.push('')
      if (chart.pySource) {
        const pyFname = `chart_${n}_${label}.py`
        await fs.writeFile(path.join(sessionDir, pyFname), chart.pySource, 'utf8')
        mdLines.push(`**Source:** [${pyFname}](./${pyFname})`)
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
      filePath:  sessionDir,  // Fix 1: folder path so shell.openPath opens Finder
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
