import { ipcMain, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { modelConnectionManager } from '../managers/ModelConnectionManager'
import { lmsDaemonManager } from '../managers/LMSDaemonManager'
import { chatService } from '../services/ChatService'
import { processFile } from '../services/FileProcessorService'

import { pythonWorker } from '../services/PythonWorkerService'
import { savePlot, searchPlots } from '../services/PlotStore'
import {
  getDB,
  getAllChats,
  createChat,
  getChatMessages,
  saveMessage,
  deleteChatById,
} from '../services/DatabaseService'
import { retrieveContext } from '../services/RAGService'
import type {
  ConnectionState,
  DaemonState,
  ChatSendPayload,
  AttachmentFilePayload,
  ProcessedAttachment,
  Chat,
  StoredMessage,
  WireMessage,
  ModelConfig,
  ReloadModelPayload,
  ReloadResult,
  AvailableModel,
  AppInitPayload,
  StorePlotPayload,
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
    const modelId       = payload.model ?? DEFAULT_MODEL_ID
    const lastUserMsg   = [...payload.messages].reverse().find((m) => m.role === 'user')
    const userMessageText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

    // BASE_SYSTEM_PROMPT and date injection are assembled by ChatService.buildMessages().
    // handlers.ts must NOT add them here — they would be duplicated in every request.
    const systemParts: string[] = []
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt)

    // ── 1. Routing guard: check if this chat has local documents ──
    // If the chat has files ingested into the vector DB, SKIP web search
    // entirely — the local RAG pipeline is always preferred over a network
    // call that may timeout and delay the response.
    let chatHasDocuments = false
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



    // ── 3. RAG context retrieval ─────────────────────────────
    // Runs unconditionally (independent of web search) so a web search
    // timeout can never starve the RAG pipeline. Kept separate from
    // systemParts so it is injected as a dedicated system message
    // immediately before the user's last turn (step 6 below).
    let ragContext = ''
    if (lastUserMsg) {
      try {
        ragContext = await retrieveContext(lastUserMsg.content, payload.chatId)
      } catch (err) {
        console.error('[RAG] retrieveContext failed:', err)
      }
    }

    // ── 4. Build enriched system prompt (web search only) ────
    const enrichedSystemPrompt = systemParts.join('\n\n') || undefined
    let enrichedMessages       = payload.messages

    // ── 5. Context sliding — now handled by ChatService token-budget trim ──
    // slideIfNeeded() was removed. ChatService.buildMessages() reads the user's
    // configured context window from SettingsStore and trims to a proper budget.

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

  ipcMain.handle(
    IPC_CHANNELS.DB_SAVE_MESSAGE,
    (_, chatId: string, id: string, role: string, content: string, attachmentsJson?: string, toolCallJson?: string): void =>
      saveMessage(chatId, id, role, content, attachmentsJson ?? null, toolCallJson ?? null)
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
        const { contextLength: savedCtx, modelId: savedModelId } = readSettings()
        if (savedCtx && savedCtx > 0) {
          const modelId = savedModelId ?? DEFAULT_MODEL_ID
          console.log(`[Settings] From SettingsStore: modelId="${modelId}" contextLength=${savedCtx}`)
          return { modelId, contextLength: savedCtx }
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
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_RELOAD,
    async (_, payload: ReloadModelPayload): Promise<ReloadResult> => {
      const { modelId, contextLength } = payload
      console.log(`[Settings] Reloading "${modelId}" → contextLength=${contextLength}`)

      const lmsBin = await findLmsBinAsync()
      if (!lmsBin) {
        return {
          success: false,
          error:   'lms CLI not found. Ensure LM Studio is installed with the lms command-line tool.',
        }
      }

      try {
        // ── Step 1: unload all running models ───────────────────
        console.log('[Settings] Running: lms unload --all')
        try {
          await runLmsArgs(lmsBin, ['unload', '--all'], 15_000)
          console.log('[Settings] lms unload --all completed')
        } catch (err) {
          // Non-fatal: "nothing loaded" errors are expected on a fresh boot.
          console.warn('[Settings] lms unload --all warning (may be fine if nothing was loaded):',
            (err as Error).message)
        }

        await new Promise((r) => setTimeout(r, 1_500))

        // ── Step 2: load with requested context length ───────────
        // lms accepts both the full HuggingFace path and the short key.
        // Passing `--context-length` sets n_ctx for this load.
        console.log(`[Settings] Running: lms load "${modelId}" --context-length ${contextLength}`)
        await runLmsArgs(lmsBin, ['load', modelId, '--context-length', String(contextLength)], 120_000)
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
        // LMSDaemonManager reads this and passes --context-length on `lms load`.
        try {
          const { writeSettings } = await import('../services/SettingsStore')
          writeSettings({ contextLength: confirmedCtx ?? contextLength, modelId })
        } catch { /* non-fatal */ }

        console.log(
          `[Settings] ✅ Reload complete — requested=${contextLength} confirmed=${confirmedCtx ?? 'unknown'}`
        )
        return { success: true, confirmedCtx }
      } catch (err) {
        const msg = (err as Error).message
        console.error('[Settings] reload error:', msg)
        return { success: false, error: msg }
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
  // Fetches the list of downloaded models from LM Studio's REST API.
  // Returns [] when the server is not yet reachable.
  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_GET_AVAILABLE_MODELS,
    async (): Promise<AvailableModel[]> => {
      try {
        const res  = await fetch('http://localhost:1234/api/v0/models')
        const json = await res.json() as { data?: Record<string, unknown>[] }
        return (json.data ?? [])
          .map((m) => {
            const id = String(m.id ?? m.modelKey ?? m.identifier ?? '')
            // Derive a friendly display name: take the last path segment, strip extension
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
  // Saves settings, then loads the model via `lms load`.
  ipcMain.handle(
    IPC_CHANNELS.APP_INITIALIZE,
    async (_, payload: AppInitPayload): Promise<ReloadResult> => {
      const { modelId, contextLength } = payload
      console.log(`[App] Initializing: model="${modelId}" contextLength=${contextLength}`)

      const { writeSettings } = await import('../services/SettingsStore')
      writeSettings({ modelId, contextLength })

      const lmsBin = await findLmsBinAsync()
      if (!lmsBin) {
        return { success: false, error: 'lms CLI not found. Ensure LM Studio is installed with the lms command-line tool.' }
      }

      try {
        console.log(`[App] Running: lms load "${modelId}" --context-length ${contextLength}`)
        await runLmsArgs(lmsBin, ['load', modelId, '--context-length', String(contextLength)], 120_000)
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
      braveEnabled:   s.braveSearchEnabled ?? false,
      braveApiKey:    s.braveSearchApiKey  ?? '',
      maxSearchLoops: s.maxSearchLoops     ?? 4,
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.MCP_SAVE_SETTINGS,
    async (_, patch: { braveEnabled?: boolean; braveApiKey?: string; maxSearchLoops?: number }) => {
      const { writeSettings } = await import('../services/SettingsStore')
      // Only include defined fields — spreading undefined would erase existing keys
      const cleanPatch: Record<string, unknown> = {}
      if (patch.braveEnabled    !== undefined) cleanPatch.braveSearchEnabled = patch.braveEnabled
      if (patch.braveApiKey     !== undefined) cleanPatch.braveSearchApiKey  = patch.braveApiKey
      if (patch.maxSearchLoops  !== undefined) cleanPatch.maxSearchLoops     = patch.maxSearchLoops
      writeSettings(cleanPatch as Parameters<typeof writeSettings>[0])
    }
  )

  ipcMain.handle(IPC_CHANNELS.MCP_GET_ENV_KEY_STATUS, () => ({
    hasEnvKey: !!(process.env.BRAVE_SEARCH_API_KEY?.trim()),
  }))
}
