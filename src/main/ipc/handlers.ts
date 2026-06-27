import { ipcMain, shell, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { modelConnectionManager } from '../managers/ModelConnectionManager'
import { lmsDaemonManager } from '../managers/LMSDaemonManager'
import { chatService } from '../services/ChatService'
import { processFile } from '../services/FileProcessorService'

import { pythonWorker } from '../services/PythonWorkerService'
import { savePlot, searchPlots } from '../services/PlotStore'
import { observabilityService } from '../services/ObservabilityService'
import type { DebugPrefs } from '../services/ObservabilityService'
import {
  getDB,
  getAllChats,
  createChat,
  getChatMessages,
  saveMessage,
  deleteChatById,
  renameChatById,
  setCompactedSummary,
  getChatSystemInstructions,
  setChatSystemInstructions,
  starChatById,
} from '../services/DatabaseService'
import { retrieve as ragRetrieve, buildContextEnvelope } from '../services/rag/RagRetrievalService'
import type {
  ConnectionState,
  DaemonState,
  ChatSendPayload,
  AttachmentFilePayload,
  ProcessedAttachment,
  Chat,
  StoredMessage,
  ModelConfig,
  ReloadModelPayload,
  ReloadResult,
  AvailableModel,
  AppInitPayload,
  StorePlotPayload,
  CompactPayload,
  CompactResult,
} from '../../shared/types'
import { DEFAULT_MODEL_ID } from '../../shared/types'

// ── Settings helpers (module-level, used by the two Settings handlers) ──────

/**
 * Find the lms CLI binary — mirrors LMSDaemonManager.findLmsBinary().
 * Async so we can use dynamic imports without blocking the module load.
 */
async function findLmsBinAsync(): Promise<string | null> {
  const { existsSync } = await import('fs')
  const { homedir }    = await import('os')
  const { join }       = await import('path')
  const { execFileSync } = await import('child_process')

  const candidates = [
    join(homedir(), '.lmstudio', 'bin', 'lms'),
    '/usr/local/bin/lms',
    '/opt/homebrew/bin/lms',
    'lms',
  ]

  for (const c of candidates) {
    if (c === 'lms') {
      try {
        const r = execFileSync('which', ['lms'], { encoding: 'utf8', timeout: 2_000 })
        const p = r.trim()
        if (p && existsSync(p)) return p
      } catch { /* not in PATH */ }
    } else if (existsSync(c)) {
      return c
    }
  }
  return null
}

/**
 * Spawn `lms <args>` and resolve with stdout when the process exits cleanly.
 * Rejects on non-zero exit or timeout.
 */
async function runLmsArgs(bin: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { spawn } = await import('child_process')
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    const out: string[] = []
    const err: string[] = []

    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()))
    proc.stderr.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) {
        err.push(line)
        console.log(`[Settings/lms] ${line}`)
      }
    })

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(new Error(`lms ${args[0]} timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)

    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0 || code === null) resolve(out.join(''))
      else reject(new Error(`lms ${args[0]} exited ${code}: ${err.join(' ').slice(0, 200)}`))
    })

    proc.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

/**
 * Parse model ID and context length from `lms ps` stdout.
 * Uses conservative regex — only matches unambiguous context-size fields.
 * Does NOT match token-usage counts (e.g. "4096 ctx used").
 */
function parseLmsPs(output: string): { modelId: string | null; contextLength: number | null } {
  console.log('[Settings] lms ps raw output:', output)

  // Context length patterns — ordered from most specific to least.
  // IMPORTANT: pattern 3 was removed because "/(\d{4,6})\s*(?:tokens?|ctx)/i" also
  // matches token-usage counts like "4096 ctx" and "4096 tokens used", which
  // incorrectly returns the session's used-tokens value instead of the max context.
  const ctxPatterns: RegExp[] = [
    // "context length: 65536", "context_size: 65536" — named field with keyword
    /context[_\s-](?:length|size|window)\s*[:\s]+(\d{4,})/i,
    // "n_ctx: 65536"
    /n_ctx\s*[:\s]+(\d{4,})/i,
    // "context: 65536" but NOT "context: 4096 / 65536" (used/total — skip)
    /context\s*:\s*(\d{4,})(?!\s*\/)/i,
    // table cell with ≥5 digits (65536, 131072) — avoids 4-digit usage counts
    /\|\s*(\d{5,6})\s*\|/,
  ]
  let contextLength: number | null = null
  for (const re of ctxPatterns) {
    const m = output.match(re)
    if (m) {
      contextLength = parseInt(m[1], 10)
      break
    }
  }

  // Extract model identifier — covers "Identifier: qwen3.5-35b-a3b", HuggingFace paths, etc.
  // NOTE: removed /model[:\s]+/ pattern — it matched table headers ("MODEL   STATUS")
  // and placeholder text ("lms load <model path>") producing "status" or "path".
  const idPatterns: RegExp[] = [
    /identifier[:\s]+([a-z0-9][a-z0-9._/-]+)/i,
    /(mlx-community\/[\w.-]+)/i,
    /(qwen[\w.-]+)/i,
    /(lmstudio-community\/[\w.-]+)/i,
    /(bartowski\/[\w.-]+)/i,
  ]
  let modelId: string | null = null
  for (const re of idPatterns) {
    const m = output.match(re)
    if (m) {
      modelId = m[1].trim()
      break
    }
  }

  console.log(`[Settings] lms ps parsed: modelId="${modelId}" contextLength=${contextLength}`)
  return { modelId, contextLength }
}

/**
 * Returns true when the user message plausibly references a previously
 * generated chart — triggers Image RAG plot retrieval.
 */
function referencesPlot(msg: string): boolean {
  return /\b(chart|graph|plot|visuali[sz]|figure|fig|earlier|previous|that\s+one|last\s+chart|earlier\s+chart|old\s+chart|the\s+one|showed?\s+me|made?\s+(a|that)|generated)\b/i.test(msg)
}

/**
 * registerIpcHandlers
 * All ipcMain.handle / ipcMain.on calls live here — nowhere else.
 */
export function registerIpcHandlers(webContents: () => WebContents | null): void {
  const send = (channel: string, payload: unknown): void => {
    const wc = webContents()
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }

  const CLOUD_PROVIDERS: readonly string[] = ['nvidia', 'ollama', 'openrouter']
  const isCloud = (bp: string): boolean => CLOUD_PROVIDERS.includes(bp)

  // ── Model Connection ────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MODEL_GET_STATUS, async (): Promise<ConnectionState> => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    const bp = s.backendProvider ?? 'lmstudio'
    if (isCloud(bp)) {
      let modelId: string
      let ownedBy: string
      switch (bp) {
        case 'nvidia':
          modelId = s.nvidiaModel ?? 'mistralai/mistral-medium-3.5-128b'
          ownedBy = 'nvidia'
          break
        case 'ollama':
          modelId = s.ollamaModel ?? 'ollama'
          ownedBy = 'ollama'
          break
        case 'openrouter':
        default:
          modelId = s.openrouterModel ?? 'anthropic/claude-sonnet-4'
          ownedBy = 'openrouter'
          break
      }
      return {
        status:         'ready',
        modelInfo:      { id: modelId, object: 'model', created: 0, owned_by: ownedBy },
        lastChecked:    Date.now(),
        error:          null,
        pollIntervalMs: 0,
      }
    }
    return modelConnectionManager.getState()
  })

  ipcMain.handle(IPC_CHANNELS.MODEL_FORCE_POLL, async (): Promise<ConnectionState> => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    const bp = s.backendProvider ?? 'lmstudio'
    if (isCloud(bp)) {
      let modelId: string
      let ownedBy: string
      switch (bp) {
        case 'nvidia':
          modelId = s.nvidiaModel ?? 'mistralai/mistral-medium-3.5-128b'
          ownedBy = 'nvidia'
          break
        case 'ollama':
          modelId = s.ollamaModel ?? 'ollama'
          ownedBy = 'ollama'
          break
        case 'openrouter':
        default:
          modelId = s.openrouterModel ?? 'anthropic/claude-sonnet-4'
          ownedBy = 'openrouter'
          break
      }
      return {
        status:         'ready',
        modelInfo:      { id: modelId, object: 'model', created: 0, owned_by: ownedBy },
        lastChecked:    Date.now(),
        error:          null,
        pollIntervalMs: 0,
      }
    }
    return modelConnectionManager.forcePoll()
  })

  modelConnectionManager.on('statusChange', (state: ConnectionState) =>
    send(IPC_CHANNELS.MODEL_STATUS_CHANGE, state)
  )

  // ── Daemon ──────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.DAEMON_GET_STATE, async (): Promise<DaemonState> => {
    const { readSettings } = await import('../services/SettingsStore')
    if (isCloud(readSettings().backendProvider ?? 'lmstudio')) {
      return { phase: 'ready', error: null, stderr: null }
    }
    return lmsDaemonManager.getState()
  })

  ipcMain.handle(IPC_CHANNELS.DAEMON_RETRY, async (): Promise<DaemonState> => {
    const { readSettings } = await import('../services/SettingsStore')
    if (isCloud(readSettings().backendProvider ?? 'lmstudio')) {
      return { phase: 'ready', error: null, stderr: null }
    }
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
    const modelId       = payload.model ?? DEFAULT_MODEL_ID
    const lastUserMsg   = [...payload.messages].reverse().find((m) => m.role === 'user')
    const userMessageText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    // BASE_SYSTEM_PROMPT and date injection are assembled by ChatService.buildMessages().
    // handlers.ts must NOT add them here — they would be duplicated in every request.
    const systemParts: string[] = []
    // Prepend the global system prompt (saved in settings) as the first layer.
    // Per-message systemPrompt (e.g. from the frontend) appends on top.
    try {
      const { readSettings } = await import('../services/SettingsStore')
      const { systemPrompt: savedSysPrompt } = readSettings()
      if (savedSysPrompt?.trim()) systemParts.unshift(savedSysPrompt.trim())
    } catch { /* non-fatal */ }
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt)

    // ── 1. Routing guard: check if this chat has local documents ──
    // If the chat has files ingested into the vector DB, SKIP web search
    // entirely — the local RAG pipeline is always preferred over a network
    // call that may timeout and delay the response.
    let chatHasDocuments = false
    let ragContextEnvelope: string | undefined
    if (payload.chatId) {
      try {
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



    // ── 3. v2 RAG context retrieval + envelope ──────────────────────────────
    // Builds ONE structured context envelope containing inline docs (full text)
    // and/or retrieved passages from indexed docs, then splices it as a single
    // system message immediately before the last user turn.
    // Doc-free chats: zero queries, zero added messages.
    const enrichedSystemPrompt = systemParts.join('\n\n') || undefined
    let enrichedMessages       = payload.messages

    if (payload.chatId) {
      try {
        const db = getDB()

        // Resolve current context window for inline truncation cap
        let contextWindow = 32768
        try {
          const { readSettings } = await import('../services/SettingsStore')
          const { contextLength } = readSettings()
          if (typeof contextLength === 'number' && contextLength > 0) contextWindow = contextLength
        } catch { /* fallback */ }

        // ── Inline documents: small docs stored in full ──────────────────────
        const inlineRows = db.prepare(
          `SELECT d.name AS doc_name, it.text
           FROM   doc_inline_text it
           JOIN   documents d ON d.id = it.doc_id
           WHERE  d.chat_id = ?`
        ).all(payload.chatId) as Array<{ doc_name: string; text: string }>

        const inlineTexts = inlineRows.map(r => ({ docName: r.doc_name, text: r.text }))

        // ── Indexed documents: hybrid retrieval ──────────────────────────────
        const hasIndexed = (db.prepare(
          `SELECT COUNT(*) AS n FROM documents WHERE chat_id = ? AND mode = 'indexed'`
        ).get(payload.chatId) as { n: number }).n > 0

        let ragResult: Awaited<ReturnType<typeof ragRetrieve>> | null = null
        if (hasIndexed && lastUserMsg) {
          try {
            const { readSettings: _rsRag } = await import('../services/SettingsStore')
            const _ragVerbose = _rsRag().ragVerboseTrace ?? false
            ragResult = await ragRetrieve(userMessageText, payload.chatId,
              undefined, undefined, { captureTrace: _ragVerbose })
          } catch (err) {
            console.error('[RAG] retrieve() failed:', err)
          }
        }

        // ── Observability trace ──────────────────────────────────────────────
        if (ragResult) {
          const { lexicalCount, vectorCount, fusedCount, hits, tokensUsed, degradedMode, noHit } = ragResult
          console.log(
            `[RAG] query="${userMessageText.slice(0, 80)}" ` +
            `lex=${lexicalCount} vec=${vectorCount} fused=${fusedCount} ` +
            `final=${hits.length} tokens=${tokensUsed} ` +
            `degraded=${degradedMode} noHit=${noHit}`
          )
          if (ragResult.trace) {
            observabilityService.emitRagEvent({ type: 'rag_query', ts: Date.now(), payload: ragResult.trace as unknown as Record<string, unknown> })
          } else {
            observabilityService.emitRagEvent({
              type: 'rag_query', ts: Date.now(),
              payload: { query: userMessageText, chatId: payload.chatId, lexicalCount, vectorCount, fusedCount, hitsCount: hits.length, tokensUsed, degradedMode, noHit, rerankUsed: ragResult.rerankUsed },
            })
          }
        }

        // ── Build envelope and pass via ragContext ───────────────────────────
        // The envelope is NOT spliced into enrichedMessages here — instead it is
        // carried as payload.ragContext so buildMessages() can insert it as an
        // untrimmed system message (immune to token-budget trim) immediately
        // before the last user turn.
        const hasContent = inlineTexts.length > 0 || (ragResult !== null)
        if (hasContent) {
          const envelope = buildContextEnvelope({
            passages:        ragResult?.hits ?? [],
            noHit:           ragResult?.noHit ?? false,
            inlineTexts,
            indexedDocNames: ragResult?.docNames ?? [],
            contextWindow,
          })

          if (envelope) {
            ragContextEnvelope = envelope
            console.log(
              `[RAG] CONTEXT ENVELOPE READY — passing via ragContext field ` +
              `(chatId=${payload.chatId}, ${envelope.length} chars): ` +
              envelope.slice(0, 120).replace(/\n/g, ' ') + '…'
            )
          }
        }
      } catch (ragErr) {
        console.error('[RAG] v2 retrieval block failed (non-fatal):', ragErr)
      }
    }

    // ── 7. Image RAG — retrieve stored plots if user references a past chart ──
    // When the user's message contains phrases like "that chart", "earlier graph",
    // "the MSFT visualization", etc., we search the PlotStore for matching charts
    // and inject them as vision image_url attachments on the current turn.
    // Old chart turns in history are already stubbed by ChatService.buildMessages().
    let enrichedPayload: ChatSendPayload = {
      ...payload,
      messages:     enrichedMessages,
      systemPrompt: enrichedSystemPrompt,
      hasDocuments: chatHasDocuments,   // suppresses web search Step 1 when RAG docs are present
      ...(ragContextEnvelope ? { ragContext: ragContextEnvelope } : {}),
    }

    if (payload.chatId && referencesPlot(userMessageText)) {
      try {
        const plots = searchPlots(payload.chatId, userMessageText)
        if (plots.length > 0) {
          console.log(
            `[PlotRAG] 🖼  Found ${plots.length} relevant plot(s): ` +
            plots.map((p) => `"${p.caption}"`).join(', ')
          )
          const { readFileSync } = await import('fs')
          const plotAttachments: ProcessedAttachment[] = plots
            .map((p): ProcessedAttachment | null => {
              try {
                const imgBuf  = readFileSync(p.imagePath)
                const dataUrl = `data:image/png;base64,${imgBuf.toString('base64')}`
                return { id: p.id, name: p.caption || 'chart', kind: 'image', dataUrl, inject: null }
              } catch {
                console.warn(`[PlotRAG] Could not read plot file: ${p.imagePath}`)
                return null
              }
            })
            .filter((a): a is ProcessedAttachment => a !== null)

          if (plotAttachments.length > 0) {
            enrichedPayload = {
              ...enrichedPayload,
              attachments: [...(enrichedPayload.attachments ?? []), ...plotAttachments],
            }
            console.log(`[PlotRAG] ✅ Injected ${plotAttachments.length} retrieved chart(s) as vision attachments`)
          }
        }
      } catch (err) {
        console.warn('[PlotRAG] searchPlots failed (non-fatal):', err)
      }
    }

    // ── DEBUG: log what the model will actually receive ──────────────────────
    console.log(`\n${'='.repeat(80)}`)
    console.log(`🔍 FINAL WIRE PAYLOAD DEBUG — chatId=${enrichedPayload.chatId ?? 'none'}`)
    console.log(`Total messages in wire: ${enrichedPayload.messages?.length ?? 0}`)
    for (let _di = 0; _di < (enrichedPayload.messages?.length ?? 0); _di++) {
      const _dm = enrichedPayload.messages[_di]
      const _content = typeof _dm.content === 'string' ? _dm.content : JSON.stringify(_dm.content)
      console.log(`  [${_di}] role=${_dm.role} chars=${_content.length} preview="${_content.slice(0, 120).replace(/\n/g, '↵')}…"`)
    }
    console.log(`Attachments in payload: ${enrichedPayload.attachments?.length ?? 0}`)
    for (const _da of (enrichedPayload.attachments ?? [])) {
      console.log(`  attachment: name="${_da.name}" kind=${_da.kind} injectChars=${_da.inject?.length ?? 0} hasDataUrl=${!!_da.dataUrl}`)
    }
    if (enrichedPayload.ragContext) {
      console.log(`ragContext: ${enrichedPayload.ragContext.length} chars — preview="${enrichedPayload.ragContext.slice(0, 120).replace(/\n/g, '↵')}…"`)
    } else {
      console.log(`ragContext: (none)`)
    }
    console.log(`${'='.repeat(80)}\n`)

    // ── EOS TOKEN TRACE (always-on) ─────────────────────────────────────────
    // Scans every field of the enriched payload for <|endoftext|> and similar
    // special tokens BEFORE chatService.send() processes them. This runs in
    // handlers.ts (not ChatService) so it fires regardless of compilation state.
    const _EOS_RE = /<\|(?:endoftext|im_end|eot_id|end)\|>/gi
    console.log(`[EOS-TRACE:handlers] Scanning ${enrichedPayload.messages.length} messages pre-send for EOS tokens...`)
    let _eosFound = false
    for (let _ei = 0; _ei < enrichedPayload.messages.length; _ei++) {
      const _em = enrichedPayload.messages[_ei]
      const _contentStr = typeof _em.content === 'string' ? _em.content : JSON.stringify(_em.content)
      _EOS_RE.lastIndex = 0
      const _contentHasEos = _EOS_RE.test(_contentStr)
      _EOS_RE.lastIndex = 0
      // Log every message briefly
      console.log(`[EOS-TRACE:handlers]   msg[${_ei}] role=${_em.role} chars=${_contentStr.length} hasEOS=${_contentHasEos} tail="${_contentStr.slice(-80).replace(/\n/g, '↵')}"`)
      if (_contentHasEos) {
        _eosFound = true
        // Find and show context around every match
        const _allMatches = [..._contentStr.matchAll(new RegExp(_EOS_RE.source, 'gi'))]
        for (const _m of _allMatches) {
          const _s = Math.max(0, (_m.index ?? 0) - 60)
          const _e2 = Math.min(_contentStr.length, (_m.index ?? 0) + 60)
          console.warn(`[EOS-TRACE:handlers]   ⚠️ EOS in msg[${_ei}].content at index ${_m.index}: "...${_contentStr.slice(_s, _e2)}..."`)
        }
      }
      // Also check tool_call_id and any WireMessage tool_calls
      const _wem = _em as { tool_call_id?: string; tool_calls?: unknown }
      if (_wem.tool_call_id) {
        _EOS_RE.lastIndex = 0
        if (_EOS_RE.test(_wem.tool_call_id)) {
          console.warn(`[EOS-TRACE:handlers]   ⚠️ EOS in msg[${_ei}].tool_call_id: "${_wem.tool_call_id}"`)
          _eosFound = true
        }
      }
      if (_wem.tool_calls) {
        const _tcStr = JSON.stringify(_wem.tool_calls)
        _EOS_RE.lastIndex = 0
        if (_EOS_RE.test(_tcStr)) {
          console.warn(`[EOS-TRACE:handlers]   ⚠️ EOS in msg[${_ei}].tool_calls: "${_tcStr.slice(0, 200)}"`)
          _eosFound = true
        }
      }
    }
    if (!_eosFound) {
      console.log('[EOS-TRACE:handlers] ✅ No EOS tokens found in pre-send payload messages.')
    }

    // ── EOS SANITIZE (handlers-level nuclear strip) ───────────────────────
    // ChatService.ts nuclear strip is not firing (compilation issue).
    // Strip here unconditionally so it cannot reach the wire payload.
    // Covers tool messages containing HuggingFace tokenizer JSON with
    // "pad_token":"<|endoftext|>" and any other source.
    if (_eosFound) {
      enrichedPayload = {
        ...enrichedPayload,
        messages: enrichedPayload.messages.map((m) => {
          if (typeof m.content !== 'string') return m
          const _EOS_RE2 = /<\|(?:endoftext|im_end|eot_id|end)\|>/gi
          const cleaned = m.content.replace(_EOS_RE2, '')
          if (cleaned !== m.content) {
            console.log(`[EOS-TRACE:handlers] ✅ Stripped EOS from role=${m.role} (${m.content.length} → ${cleaned.length} chars)`)
          }
          return { ...m, content: cleaned }
        }),
      }
    }
    // ───────────────────────────────────────────────────────────────────────

    try {
      await chatService.send(enrichedPayload, modelId, wc)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[EOS-TRACE:handlers] chatService.send() threw: ${msg}`)
      send(IPC_CHANNELS.CHAT_ERROR, msg)
    }
  })

  /**
   * chat:abort — fire-and-forget from renderer
   */
  ipcMain.on(IPC_CHANNELS.CHAT_ABORT, () => {
    chatService.abort()
  })


  // ── Matplotlib rendering ─────────────────────────────────────
  /**
   * python:render
   *
   * Delegates to PythonWorkerService — a persistent python3 process that
   * pre-imports matplotlib/numpy/scipy once at startup, cutting per-render
   * latency from ~3-4s (cold spawn) to ~200ms (warm worker).
   * Falls back to one-shot spawn automatically if the worker is not ready.
   */
  ipcMain.handle(
    IPC_CHANNELS.PYTHON_RENDER,
    async (_evt, userCode: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> => {
      console.log('[Python] Rendering chart via persistent worker…')
      const result = await pythonWorker.render(userCode)
      if (result.success) {
        console.log(`[Python] ✅ Chart rendered (${result.imageBase64?.length ?? 0} base64 chars)`)
      } else {
        console.error('[Python] ❌ Chart render failed:', result.error)
      }
      return result
    }
  )

  /**
   * plot:store
   *
   * Called by MatplotlibBlock in the renderer after a successful render.
   * Saves the chart PNG to disk and inserts a metadata row into plot_store
   * so the model can retrieve and re-display it in future turns via Image RAG.
   */
  ipcMain.handle(
    IPC_CHANNELS.PLOT_STORE,
    (_evt, payload: StorePlotPayload): { id: string } => {
      const { chatId, code, imageBase64, caption } = payload
      const id = savePlot(chatId, code, imageBase64, caption)
      return { id }
    }
  )

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

  ipcMain.handle(IPC_CHANNELS.DB_RENAME_CHAT, (_, chatId: string, title: string): void =>
    renameChatById(chatId, title)
  )

  ipcMain.handle(
    IPC_CHANNELS.DB_SAVE_MESSAGE,
    (_, chatId: string, id: string, role: string, content: string, attachmentsJson?: string, toolCallJson?: string, blocksJson?: string): void =>
      saveMessage(chatId, id, role, content, attachmentsJson ?? null, toolCallJson ?? null, blocksJson ?? null)
  )

  ipcMain.handle(IPC_CHANNELS.DB_STAR_CHAT, (_, chatId: string, starred: boolean): void =>
    starChatById(chatId, starred)
  )

  // ── Settings: model config via lms CLI ─────────────────────────
  //
  // The LM Studio /api/v0/models/load and /api/v0/models/unload REST
  // endpoints do not exist in all versions (they return 200 with body
  // {"error":"Unexpected endpoint or method."}).
  //
  // Instead we use the `lms` CLI — the same binary already used by
  // LMSDaemonManager:
  //   • `lms ps`                              → reads loaded model + context
  //   • `lms unload --all`                    → unloads whatever is running
  //   • `lms load <id> --context-length <N>`  → loads with new n_ctx
  //
  // Helpers (findLmsBinAsync, runLmsArgs, parseLmsPs) are defined at
  // module scope above registerIpcHandlers.

  // ── Fallback helper: parse a /api/v0/models entry ───────────────
  // Used when lms ps is unavailable or returns no context info.
  function extractModelConfig(entry: Record<string, unknown>): { modelId: string; contextLength: number } {
    console.log('[Settings] Raw model entry from LM Studio:', JSON.stringify(entry, null, 2))

    const modelId =
      (entry.id         as string | undefined) ??
      (entry.modelKey   as string | undefined) ??
      (entry.identifier as string | undefined) ??
      DEFAULT_MODEL_ID

    const cfg = (entry.config ?? entry.configuration ?? entry.loadedModelInfo ?? {}) as Record<string, unknown>

    const contextLength: number =
      (entry.loaded_context_length as number | undefined) ??
      (entry.loadedContextLength   as number | undefined) ??
      (entry.contextLength         as number | undefined) ??
      (entry.context_length        as number | undefined) ??
      (cfg.contextLength           as number | undefined) ??
      (cfg.context_length          as number | undefined) ??
      (cfg.nCtx                    as number | undefined) ??
      (cfg.n_ctx                   as number | undefined) ??
      32768   // do NOT fall back to max_context_length — that's the model cap, not n_ctx

    console.log(`[Settings] Resolved: modelId="${modelId}" contextLength=${contextLength}`)
    return { modelId, contextLength }
  }

  // ── settings:getModelConfig ──────────────────────────────────────
  //
  // Source-of-truth priority:
  //   1. SettingsStore (app-settings.json) — written by us on every reload,
  //      so it always reflects what context length WE loaded the model with.
  //      This is the most reliable source and avoids all lms ps parsing bugs.
  //   2. lms ps — only used on first launch (before any preference is saved).
  //      Parsing is conservative; falls through if no unambiguous value found.
  //   3. /api/v0/models GET — last resort.
  //   4. Hard-coded 32768 default.
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_MODEL,
    async (): Promise<ModelConfig> => {
      // ── 1. SettingsStore — ground truth once a preference exists ──
      // modelId and contextLength are written here on every APP_INITIALIZE / SETTINGS_RELOAD,
      // so this is the most reliable source — no lms ps parsing needed.
      try {
        const { readSettings } = await import('../services/SettingsStore')
        const s = readSettings()
        if (s.contextLength && s.contextLength > 0) {
          const modelId = s.modelId ?? DEFAULT_MODEL_ID
          console.log(`[Settings] From SettingsStore: modelId="${modelId}" contextLength=${s.contextLength}`)
          return {
            modelId,
            contextLength:    s.contextLength,
            temperature:      s.temperature      ?? 0.7,
            topP:             s.topP             ?? 0.95,
            maxOutputTokens:  s.maxOutputTokens  ?? 16384,
            repeatPenalty:    s.repeatPenalty    ?? 1.1,
            systemPrompt:     s.systemPrompt     ?? '',
            gpuOffload:       s.gpuOffload       ?? false,
          }
        }
      } catch (err) {
        console.warn('[Settings] SettingsStore read failed:', (err as Error).message)
      }

      // ── 2. lms ps — first-launch fallback (no pref saved yet) ────
      try {
        const lmsBin = await findLmsBinAsync()
        if (lmsBin) {
          const psOut = await runLmsArgs(lmsBin, ['ps'], 5_000)
          const { modelId: psModelId, contextLength: psCtx } = parseLmsPs(psOut)
          if (psCtx && psCtx > 0) {
            return { modelId: psModelId ?? DEFAULT_MODEL_ID, contextLength: psCtx }
          }
          console.warn('[Settings] lms ps returned no context length — trying REST API')
        }
      } catch (err) {
        console.warn('[Settings] lms ps failed:', (err as Error).message)
      }

      // ── 3. /api/v0/models GET — last resort ───────────────────────
      // Prefer the loaded model; if none, return the first available one.
      try {
        const res     = await fetch('http://localhost:1234/api/v0/models')
        const raw     = await res.text()
        console.log('[Settings] GET /api/v0/models raw response:', raw)
        const json    = JSON.parse(raw) as { data?: Record<string, unknown>[] }
        const entries = json.data ?? []
        const loaded  = entries.find((m) => String(m.state ?? '') === 'loaded')
        const target  = loaded ?? entries[0]
        if (target) return extractModelConfig(target)
      } catch (err) {
        console.error('[Settings] getModelConfig REST fallback failed:', err)
      }

      // ── 4. Hard default ────────────────────────────────────────────
      console.warn('[Settings] All sources failed — returning default 32768')
      return { modelId: DEFAULT_MODEL_ID, contextLength: 32768 }
    }
  )

  // ── settings:reloadModel ─────────────────────────────────────────
  // Uses lms CLI: unload --all → load <id> --context-length <N> → ps to confirm.
  // Concurrency lock: if a reload is already in-flight, reject immediately.
  // This prevents double-loading (RAM spike) if the user triggers TopBar reload
  // concurrently with a settings reload.
  let reloadInFlight = false
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_RELOAD,
    async (_, payload: ReloadModelPayload): Promise<ReloadResult> => {
      if (reloadInFlight) {
        console.warn('[Settings] Reload already in-flight — rejecting concurrent request')
        return { success: false, error: 'A model reload is already in progress. Please wait.' }
      }
      reloadInFlight = true
      try {
      const { modelId, contextLength, gpuOffload } = payload
      console.log(`[Settings] Reloading "${modelId}" → contextLength=${contextLength} gpuOffload=${gpuOffload ?? false}`)

      const { readSettings: _rs, writeSettings } = await import('../services/SettingsStore')

      // ── Cloud provider guard: skip lms CLI entirely, just persist params ─────
      const currentSettings = _rs()
      if (isCloud(currentSettings.backendProvider ?? 'lmstudio')) {
        const patch: Record<string, unknown> = {}
        if (payload.temperature     !== undefined) patch.temperature     = payload.temperature
        if (payload.topP            !== undefined) patch.topP            = payload.topP
        if (payload.maxOutputTokens !== undefined) patch.maxOutputTokens = payload.maxOutputTokens
        if (payload.repeatPenalty   !== undefined) patch.repeatPenalty   = payload.repeatPenalty
        if (payload.systemPrompt    !== undefined) patch.systemPrompt    = payload.systemPrompt
        if (payload.contextLength   !== undefined) patch.contextLength   = payload.contextLength
        writeSettings(patch as Parameters<typeof writeSettings>[0])
        console.log(`[Settings] Cloud provider (${currentSettings.backendProvider}) — skipped lms CLI, params saved to SettingsStore`)
        return { success: true, confirmedCtx: payload.contextLength }
      }

      // ── LM Studio: use lms CLI ────────────────────────────────────
      const lmsBin = await findLmsBinAsync()
      if (!lmsBin) {
        return {
          success: false,
          error:   'lms CLI not found. Ensure LM Studio is installed with the lms command-line tool.',
        }
      }

      try {
        // ── Step 1: unload all running models ───────────────────
        // CRITICAL: must confirm unload succeeded before proceeding to load.
        // Silently swallowing unload errors was the root cause of double-load
        // RAM spikes — if unload fails for any reason other than "nothing loaded",
        // we abort rather than load a second model on top of the existing one.
        console.log('[Settings] Running: lms unload --all')
        try {
          await runLmsArgs(lmsBin, ['unload', '--all'], 15_000)
          console.log('[Settings] lms unload --all completed')
        } catch (err) {
          const msg = (err as Error).message
          // The only safe-to-ignore failure is "nothing is loaded" — lms exits
          // non-zero in that case with a message containing "no model" or similar.
          // Any other failure means the old model may still be in memory: abort.
          const isNothingLoaded = /no.*(model|loaded)|nothing.*load|not.*load/i.test(msg)
          if (!isNothingLoaded) {
            console.error('[Settings] lms unload --all failed — aborting reload to prevent double-load RAM spike:', msg)
            return { success: false, error: `Failed to unload current model: ${msg}. Please unload manually in LM Studio before switching models.` }
          }
          console.warn('[Settings] lms unload --all: nothing was loaded (safe to continue):', msg)
        }

        await new Promise((r) => setTimeout(r, 2_500))

        // ── Step 2: load with requested context length (+ GPU offload flag) ─
        // lms accepts both the full HuggingFace path and the short key.
        // --gpu max offloads all layers to GPU for maximum throughput.
        const loadArgs = [
          modelId,
          ...(gpuOffload ? ['--gpu', 'max'] : []),
          '--context-length', String(contextLength),
        ]
        if (process.env.DEV_MODE === 'true') {
          console.log(`[DEBUG][Settings] lms load command: ${lmsBin} load ${loadArgs.join(' ')}`)
        }
        console.log(`[Settings] Running: lms load ${loadArgs.join(' ')}`)
        await runLmsArgs(lmsBin, ['load', ...loadArgs], 120_000)
        console.log('[Settings] lms load completed')

        // ── Step 3: verify with lms ps ──────────────────────────
        await new Promise((r) => setTimeout(r, 1_000))
        let confirmedCtx: number | undefined
        try {
          const psOut = await runLmsArgs(lmsBin, ['ps'], 5_000)
          const { contextLength: confirmed } = parseLmsPs(psOut)
          if (confirmed && confirmed > 0) confirmedCtx = confirmed
        } catch (err) {
          console.warn('[Settings] lms ps verification failed (non-fatal):', (err as Error).message)
        }

        // ── Step 4: persist the preference for next app startup ────
        // LMSDaemonManager reads this and passes the same flags on next `lms load`.
        try {
          const patch: Record<string, unknown> = {
            contextLength: confirmedCtx ?? contextLength,
            modelId,
          }
          if (payload.temperature     !== undefined) patch.temperature     = payload.temperature
          if (payload.topP            !== undefined) patch.topP            = payload.topP
          if (payload.maxOutputTokens !== undefined) patch.maxOutputTokens = payload.maxOutputTokens
          if (payload.repeatPenalty   !== undefined) patch.repeatPenalty   = payload.repeatPenalty
          if (payload.systemPrompt    !== undefined) patch.systemPrompt    = payload.systemPrompt
          if (payload.gpuOffload      !== undefined) patch.gpuOffload      = payload.gpuOffload
          writeSettings(patch as Parameters<typeof writeSettings>[0])
        } catch { /* non-fatal */ }

        modelConnectionManager.forcePoll().catch(() => { /* non-fatal */ })

        console.log(
          `[Settings] ✅ Reload complete — requested=${contextLength} confirmed=${confirmedCtx ?? 'unknown'} gpuOffload=${gpuOffload ?? false}`
        )
        return { success: true, confirmedCtx }
      } catch (err) {
        const msg = (err as Error).message
        console.error('[Settings] reload error:', msg)
        return { success: false, error: msg }
      }
      } finally {
        reloadInFlight = false
      }
    }
  )

  // ── app:isFirstLaunch ────────────────────────────────────────────
  // Returns true when no modelId has been saved yet (no settings file,
  // or settings file exists but modelId was never written).
  ipcMain.handle(IPC_CHANNELS.APP_IS_FIRST_LAUNCH, async (): Promise<boolean> => {
    const { readSettings } = await import('../services/SettingsStore')
    const { modelId } = readSettings()
    return !modelId
  })

  // ── settings:getAvailableModels ──────────────────────────────────
  // Fetches the list of downloaded models from LM Studio's /api/v0/models endpoint.
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_AVAILABLE_MODELS,
    async (): Promise<AvailableModel[]> => {
      try {
        const res  = await fetch('http://localhost:1234/api/v0/models')
        const json = await res.json() as { data?: Record<string, unknown>[] }
        return (json.data ?? [])
          .map((m) => {
            const id = String(m.id ?? m.modelKey ?? m.identifier ?? '')
            const raw = id.split('/').pop() ?? id
            const displayName = raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            return { id, displayName, state: String(m.state ?? 'unknown') }
          })
          .filter((m) => m.id.length > 0)
      } catch {
        return []
      }
    }
  )

  // ── app:initialize ───────────────────────────────────────────────
  // Called by FirstLaunchModal after the user picks a model.
  // Saves settings and runs `lms load` to load the model.
  ipcMain.handle(
    IPC_CHANNELS.APP_INITIALIZE,
    async (_, payload: AppInitPayload): Promise<ReloadResult> => {
      const { modelId, contextLength } = payload
      console.log(`[App] Initializing: model="${modelId}" contextLength=${contextLength}`)

      const { readSettings: readInitSettings, writeSettings } = await import('../services/SettingsStore')
      writeSettings({ modelId, contextLength })

      // ── Cloud provider guard: skip lms CLI, settings already saved above ─────
      const _initSettings = readInitSettings()
      if (isCloud(_initSettings.backendProvider ?? 'lmstudio')) {
        console.log(`[App] Cloud provider (${_initSettings.backendProvider}) — skipping lms CLI`)
        return { success: true, confirmedCtx: contextLength }
      }

      // Read back gpuOffload from saved settings (set before first-launch in edge cases)
      const { gpuOffload: initGpuOffload } = readInitSettings()

      // ── LM Studio: run lms load ───────────────────────────────────
      const lmsBin = await findLmsBinAsync()
      if (!lmsBin) {
        return { success: false, error: 'lms CLI not found. Ensure LM Studio is installed with the lms command-line tool.' }
      }

      try {
        const initLoadArgs = [
          modelId,
          ...(initGpuOffload ? ['--gpu', 'max'] : []),
          '--context-length', String(contextLength),
        ]
        if (process.env.DEV_MODE === 'true') {
          console.log(`[DEBUG][App] lms load command: ${lmsBin} load ${initLoadArgs.join(' ')}`)
        }
        console.log(`[App] Running: lms load ${initLoadArgs.join(' ')}`)
        await runLmsArgs(lmsBin, ['load', ...initLoadArgs], 120_000)
        console.log('[App] ✅ Model loaded successfully')
        return { success: true, confirmedCtx: contextLength }
      } catch (err) {
        const msg = (err as Error).message
        console.error('[App] initialize failed:', msg)
        return { success: false, error: msg }
      }
    }
  )

  // ── MCP Settings ─────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SETTINGS, async () => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    return {
      braveEnabled:                s.braveSearchEnabled         ?? false,
      braveApiKey:                 s.braveSearchApiKey          ?? '',
      maxSearchLoops:              s.maxSearchLoops             ?? 4,
      keepSearchResultsInContext:  s.keepSearchResultsInContext ?? false,
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.MCP_SAVE_SETTINGS,
    async (_, patch: { braveEnabled?: boolean; braveApiKey?: string; maxSearchLoops?: number; keepSearchResultsInContext?: boolean }) => {
      const { writeSettings } = await import('../services/SettingsStore')
      // Only include defined fields — spreading undefined would erase existing keys
      const cleanPatch: Record<string, unknown> = {}
      if (patch.braveEnabled                 !== undefined) cleanPatch.braveSearchEnabled        = patch.braveEnabled
      if (patch.braveApiKey                  !== undefined) cleanPatch.braveSearchApiKey         = patch.braveApiKey
      if (patch.maxSearchLoops               !== undefined) cleanPatch.maxSearchLoops            = patch.maxSearchLoops
      if (patch.keepSearchResultsInContext   !== undefined) cleanPatch.keepSearchResultsInContext = patch.keepSearchResultsInContext
      writeSettings(cleanPatch as Parameters<typeof writeSettings>[0])
    }
  )

  ipcMain.handle(IPC_CHANNELS.MCP_GET_ENV_KEY_STATUS, () => ({
    hasEnvKey: !!(process.env.BRAVE_SEARCH_API_KEY?.trim()),
  }))

  // ── settings:getSuggestions / settings:saveSuggestions ───────────
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_SUGGESTIONS, async (): Promise<string[]> => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    return s.suggestionCards ?? []   // [] means "use client-side defaults"
  })

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_SUGGESTIONS,
    async (_, cards: string[]): Promise<void> => {
      const { writeSettings } = await import('../services/SettingsStore')
      // Only persist non-empty, trimmed strings — max 4
      const clean = cards
        .filter((c) => typeof c === 'string' && c.trim().length > 0)
        .slice(0, 4)
      writeSettings({ suggestionCards: clean })
    }
  )

  // ── settings:getBackend / settings:saveBackend ────────────────────
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_BACKEND, async () => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    return {
      provider:          s.backendProvider  ?? 'lmstudio',
      nvidiaApiKey:      s.nvidiaApiKey     ?? '',
      nvidiaModel:       s.nvidiaModel      ?? 'mistralai/mistral-medium-3.5-128b',
      ollamaApiKey:      s.ollamaApiKey     ?? '',
      ollamaModel:       s.ollamaModel      ?? '',
      ollamaBaseUrl:     s.ollamaBaseUrl    ?? 'https://ollama.com',
      openrouterApiKey:            s.openrouterApiKey            ?? '',
      openrouterModel:              s.openrouterModel             ?? 'anthropic/claude-sonnet-4',
      openrouterReasoningEffort:    s.openrouterReasoningEffort   ?? 'auto',
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SAVE_BACKEND,
    async (_, patch: { provider?: string; nvidiaApiKey?: string; nvidiaModel?: string; ollamaApiKey?: string; ollamaModel?: string; ollamaBaseUrl?: string; openrouterApiKey?: string; openrouterModel?: string; openrouterReasoningEffort?: string }) => {
      const { writeSettings } = await import('../services/SettingsStore')
      const cleanPatch: Record<string, unknown> = {}
      if (patch.provider                  !== undefined) cleanPatch.backendProvider           = patch.provider
      if (patch.nvidiaApiKey              !== undefined) cleanPatch.nvidiaApiKey              = patch.nvidiaApiKey
      if (patch.nvidiaModel               !== undefined) cleanPatch.nvidiaModel               = patch.nvidiaModel
      if (patch.ollamaApiKey              !== undefined) cleanPatch.ollamaApiKey              = patch.ollamaApiKey
      if (patch.ollamaModel               !== undefined) cleanPatch.ollamaModel               = patch.ollamaModel
      if (patch.ollamaBaseUrl             !== undefined) cleanPatch.ollamaBaseUrl             = patch.ollamaBaseUrl
      if (patch.openrouterApiKey          !== undefined) cleanPatch.openrouterApiKey          = patch.openrouterApiKey
      if (patch.openrouterModel           !== undefined) cleanPatch.openrouterModel           = patch.openrouterModel
      if (patch.openrouterReasoningEffort !== undefined) cleanPatch.openrouterReasoningEffort = patch.openrouterReasoningEffort
      writeSettings(cleanPatch as Parameters<typeof writeSettings>[0])
    },
  )

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_OLLAMA_MODELS, async (_, baseUrl?: string, apiKey?: string) => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    const url = (baseUrl ?? s.ollamaBaseUrl ?? 'https://ollama.com').replace(/\/$/, '')
    const key = apiKey ?? s.ollamaApiKey ?? ''
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (key) headers['Authorization'] = `Bearer ${key}`
      const res = await fetch(`${url}/api/tags`, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { models: [], error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
      }
      const data = await res.json() as { models?: Array<{ name: string }> }
      return { models: (data.models ?? []).map((m) => m.name), error: null }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { models: [], error: msg }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_OPENROUTER_MODELS, async (_, apiKey?: string) => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    const key = apiKey ?? s.openrouterApiKey ?? ''
    if (!key) return { models: [], modalities: {}, error: 'No API key configured' }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return { models: [], modalities: {}, pricing: {}, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
      }
      const data = await res.json() as { data?: Array<{ id: string; architecture?: { input_modalities?: string[] }; pricing?: { prompt?: string; completion?: string; cache_read?: string; input_cache_read?: string } }> }
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => typeof id === 'string' && id.length > 0)
        .sort()
      const modalities: Record<string, string[]> = {}
      const pricing: Record<string, { prompt: number | null; completion: number | null; cacheRead: number | null }> = {}
      for (const m of (data.data ?? [])) {
        if (m.id && m.architecture?.input_modalities) {
          modalities[m.id] = m.architecture.input_modalities
        }
        if (m.id && m.pricing) {
          const toNum = (v?: string) => {
            const n = parseFloat(v ?? '')
            return isNaN(n) ? null : n
          }
          pricing[m.id] = {
            prompt:     toNum(m.pricing.prompt),
            completion: toNum(m.pricing.completion),
            cacheRead:  toNum((m.pricing as Record<string, string>).input_cache_read ?? (m.pricing as Record<string, string>).cache_read),
          }
        }
      }
      return { models, modalities, pricing, error: null }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { models: [], modalities: {}, pricing: {}, error: msg }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_OPENROUTER_STATS, async (_, apiKey?: string) => {
    const { readSettings } = await import('../services/SettingsStore')
    const s = readSettings()
    const key = apiKey ?? s.openrouterApiKey ?? ''
    if (!key) return { credits: null, activity: null, error: 'No API key' }
    try {
      const res = await fetch('https://openrouter.ai/api/v1/credits', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`Credits API returned ${res.status}`)
      const json = await res.json() as { data: { total_credits: number; total_usage: number } }
      return { credits: json.data, activity: null, error: null }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { credits: null, activity: null, error: msg }
    }
  })

  // ── chat:compact — manual context compaction ─────────────────────
  // Summarises the current chat via a local LM Studio call, replaces
  // all non-system messages with a single dense assistant summary row,
  // and returns the before/after token delta.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPACT,
    async (_, payload: CompactPayload): Promise<CompactResult> => {
      const COMPACT_PROMPT =
        `You are a context compaction assistant. Below is a conversation history between a user and an AI assistant.\n` +
        `Produce a dense, structured summary written in first person from the assistant's perspective (e.g. "The user and I discussed..."). Preserve ALL of the following without omission:\n\n` +
        `Every factual claim, decision, or conclusion reached\n` +
        `All code discussed, file names, function names, error messages\n` +
        `The user's stated goals, preferences, and constraints\n` +
        `Any unresolved questions or next steps\n\n` +
        `This summary will REPLACE the full conversation history. The assistant reading it must be able to continue the conversation seamlessly. Be thorough — do not omit technical details. Do not add preamble or postamble.\n` +
        `CONVERSATION TO SUMMARISE:\n`

      const { countTokens } = await import('../services/tokenUtils')
      const { net } = await import('electron')

      // 1. Load all non-system messages
      const allMessages = getChatMessages(payload.chatId)
      const messages    = allMessages.filter((m) => m.role !== 'system')

      // 2. Count tokens before
      const transcript    = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
      const tokensBefore  = countTokens(transcript)

      console.log(`[Compact] chatId=${payload.chatId} — ${messages.length} messages, ~${tokensBefore} tokens`)

      // 3. Build summarisation payload — one user message with the full transcript
      const requestBody = {
        model:      payload.model,
        stream:     false,
        max_tokens: 2048,
        messages:   [
          {
            role:    'user',
            content: COMPACT_PROMPT + transcript,
          },
        ],
      }

      // 4. Call LM Studio (non-streaming)
      const resp = await net.fetch('http://localhost:1234/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(requestBody),
      })

      if (!resp.ok) {
        const errText = await resp.text().catch(() => resp.statusText)
        throw new Error(`LM Studio returned ${resp.status}: ${errText}`)
      }

      const json        = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
      const summaryContent = json.choices?.[0]?.message?.content?.trim()
      if (!summaryContent) {
        throw new Error('LM Studio returned an empty summary')
      }

      // 5. Store summary in chats.compacted_summary (does NOT delete message rows).
      // The UI keeps showing the full history; only the LM Studio wire payload changes.
      setCompactedSummary(payload.chatId, summaryContent)

      // 6. Count tokens after
      const tokensAfter = countTokens(summaryContent)

      // 7. Detect whether this chat has attached documents (RAG context re-injects regardless)
      let hasDocuments = false
      try {
        const docRow = getDB()
          .prepare('SELECT COUNT(*) AS n FROM documents WHERE chat_id = ?')
          .get(payload.chatId) as { n: number }
        hasDocuments = docRow.n > 0
      } catch { /* non-fatal */ }

      console.log(`[Compact] ✅ Done — ${tokensBefore} → ${tokensAfter} tokens hasDocuments=${hasDocuments}`)

      return { tokensBefore, tokensAfter, hasDocuments }
    }
  )

  // ── MCP Custom Servers ────────────────────────────────────────────
  //
  // These handlers manage the lifecycle and config of user-defined MCP servers.
  // McpServerManager owns the child processes; handlers are thin pass-throughs.

  ipcMain.handle(IPC_CHANNELS.MCP_LIST_CUSTOM_SERVERS, async () => {
    const { mcpServerManager } = await import('../services/McpServerManager')
    return mcpServerManager.readConfig()
  })

  ipcMain.handle(
    IPC_CHANNELS.MCP_SAVE_CUSTOM_SERVERS,
    async (_, settings) => {
      const { mcpServerManager } = await import('../services/McpServerManager')
      await mcpServerManager.writeConfig(settings)
    }
  )

  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVER_STATUS, async () => {
    const { mcpServerManager } = await import('../services/McpServerManager')
    return mcpServerManager.getServerStatus()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_RESTART_SERVER, async (_, name: string) => {
    const { mcpServerManager } = await import('../services/McpServerManager')
    await mcpServerManager.restartServer(name)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_, name: string) => {
    const { mcpServerManager } = await import('../services/McpServerManager')
    await mcpServerManager.removeServer(name)
  })

  ipcMain.handle(
    IPC_CHANNELS.MCP_SET_TOOL_ENABLED,
    async (_, { serverName, toolName, enabled }: { serverName: string; toolName: string; enabled: boolean }) => {
      const { mcpServerManager } = await import('../services/McpServerManager')
      await mcpServerManager.setToolEnabled(serverName, toolName, enabled)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MCP_TOOL_PERMISSION_RESPONSE,
    async (_, response: import('../../shared/types').McpToolPermissionResponse) => {
      const { mcpServerManager } = await import('../services/McpServerManager')
      mcpServerManager.resolvePermission(response)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MCP_BYPASS_PERMISSIONS_CHANGED,
    async (_, bypass: boolean) => {
      const { mcpServerManager } = await import('../services/McpServerManager')
      mcpServerManager.setBypassPermissions(bypass)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MCP_SET_SERVER_APPROVAL_MODE,
    async (_, { serverName, requiresApproval }: { serverName: string; requiresApproval: boolean }) => {
      const { mcpServerManager } = await import('../services/McpServerManager')
      mcpServerManager.setServerApprovalMode(serverName, requiresApproval)
    }
  )

  // ── Observability ─────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.OBS_GET_PREFS, (): DebugPrefs =>
    observabilityService.getPrefs()
  )

  ipcMain.handle(IPC_CHANNELS.OBS_SET_PREFS, (_, patch: Partial<DebugPrefs>): void =>
    observabilityService.setPrefs(patch)
  )

  ipcMain.handle(IPC_CHANNELS.OBS_LIST_SESSIONS, async () =>
    observabilityService.listSessions()
  )

  ipcMain.handle(IPC_CHANNELS.OBS_OPEN_SESSION, async (_, sessionIdOrPath: string): Promise<void> => {
    // If passed an absolute path (e.g. the logs directory itself), open it directly.
    if (sessionIdOrPath.startsWith('/') || /^[A-Za-z]:\\/.test(sessionIdOrPath)) {
      await shell.openPath(sessionIdOrPath)
      return
    }
    const sessions = await observabilityService.listSessions()
    const entry = sessions.find((s) => s.sessionId === sessionIdOrPath)
    if (entry) await shell.openPath(entry.filePath)
  })

  ipcMain.handle(IPC_CHANNELS.OBS_DELETE_SESSION, async (_, sessionId: string): Promise<void> =>
    observabilityService.deleteSession(sessionId)
  )

  ipcMain.handle(IPC_CHANNELS.OBS_CLEAR_ALL, async (): Promise<void> =>
    observabilityService.clearAllSessions()
  )

  ipcMain.handle(IPC_CHANNELS.OBS_GET_LOGS_DIR, (): string =>
    observabilityService.getLogsDir()
  )

  ipcMain.handle(IPC_CHANNELS.OBS_TOTAL_SIZE, async (): Promise<number> =>
    observabilityService.getTotalSizeBytes()
  )

  ipcMain.handle(
    IPC_CHANNELS.OBS_CAPTURE_ARTIFACT,
    (_, event: import('../services/ObservabilityService').ObsEvent): void => {
      observabilityService.captureArtifact(event)
    }
  )

  // ── Per-chat system instructions ────────────────────────────────
  ipcMain.handle('chat:get-system-instructions', (_event, chatId: string) => {
    return getChatSystemInstructions(chatId)
  })

  ipcMain.handle('chat:set-system-instructions', (_event, chatId: string, text: string) => {
    setChatSystemInstructions(chatId, text)
  })

}
