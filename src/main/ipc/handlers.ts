import { ipcMain, WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { modelConnectionManager } from '../managers/ModelConnectionManager'
import { lmsDaemonManager } from '../managers/LMSDaemonManager'
import { chatService } from '../services/ChatService'
import { processFile } from '../services/FileProcessorService'
import { detectSearchIntent, performWebSearch } from '../services/WebSearchService'
import { BASE_SYSTEM_PROMPT } from '../services/SystemPromptService'
import {
  getDB,
  getAllChats,
  createChat,
  getChatMessages,
  saveMessage,
  deleteChatById,
} from '../services/DatabaseService'
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
    const modelId     = payload.model ?? DEFAULT_MODEL_ID
    const lastUserMsg = [...payload.messages].reverse().find((m) => m.role === 'user')

    // BASE_SYSTEM_PROMPT is always first — it tells the model about the app's
    // native rendering capabilities (Mermaid diagrams, KaTeX) so it stops
    // generating ASCII art and text-based diagrams.
    const systemParts: string[] = [BASE_SYSTEM_PROMPT]
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

    // ── 2. Web search — only when no local documents exist for this chat ──
    if (lastUserMsg && !chatHasDocuments) {
      const query = detectSearchIntent(lastUserMsg.content)
      if (query) {
        const searchResult = await performWebSearch(query, wc)
        systemParts.push(searchResult)
      }
    }

    // ── 3. RAG context retrieval ─────────────────────────────
    // Runs unconditionally (independent of web search) so a web search
    // timeout can never starve the RAG pipeline. Kept separate from
    // systemParts so it is injected as a dedicated system message
    // immediately before the user's last turn (step 6 below).
    // Dynamic import keeps uuid (ESM-only dep of RAGService) out of the CJS
    // main bundle — static import causes Vite to emit require('uuid') which
    // Electron rejects at startup with ERR_REQUIRE_ESM.
    let ragContext = ''
    if (lastUserMsg) {
      try {
        const { retrieveContext } = await import('../services/RAGService')
        ragContext = await retrieveContext(lastUserMsg.content, payload.chatId)
      } catch (err) {
        console.error('[RAG] retrieveContext failed:', err)
      }
    }

    // ── 4. Build enriched system prompt (web search only) ────
    const enrichedSystemPrompt = systemParts.join('\n\n') || undefined
    let enrichedMessages       = payload.messages

    // ── 5. Context sliding ───────────────────────────────────
    try {
      const { slideIfNeeded } = await import('../services/ContextSliderService')
      enrichedMessages = await slideIfNeeded(
        payload.messages,
        enrichedSystemPrompt ?? '',
        modelId
      )
    } catch {
      // Leave messages unchanged if slider fails
    }

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

    const enrichedPayload: ChatSendPayload = {
      ...payload,
      messages:     enrichedMessages,
      systemPrompt: enrichedSystemPrompt,
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
   * Executes a matplotlib Python script and returns the chart as a
   * base64-encoded PNG.  The script is wrapped with:
   *  - matplotlib Agg backend (no display needed)
   *  - Dark theme rcParams matching the app palette
   *  - Pre-imported plt and np so the model code stays concise
   *  - Automatic tight_layout() + savefig() → base64 on stdout
   *
   * The model must NOT call plt.show(), plt.savefig(), or import matplotlib.
   *
   * Timeout: 30 seconds — prevents runaway scripts from blocking IPC.
   */
  ipcMain.handle(
    IPC_CHANNELS.PYTHON_RENDER,
    async (_evt, userCode: string): Promise<{ success: boolean; imageBase64?: string; error?: string }> => {
      const { spawn } = await import('child_process')

      const PREAMBLE = `
import sys, io, base64
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
try:
    import scipy
    from scipy import stats as scipy_stats
except ImportError:
    pass

plt.rcParams.update({
    'figure.facecolor':  '#0f0f0f',
    'axes.facecolor':    '#141414',
    'axes.edgecolor':    '#3a3a3a',
    'axes.labelcolor':   '#a3a3a3',
    'grid.color':        '#2a2a2a',
    'grid.linestyle':    '--',
    'grid.alpha':        0.6,
    'text.color':        '#f5f5f5',
    'xtick.color':       '#a3a3a3',
    'ytick.color':       '#a3a3a3',
    'legend.facecolor':  '#1a1a1a',
    'legend.edgecolor':  '#3a3a3a',
    'legend.labelcolor': '#f5f5f5',
    'axes.prop_cycle':   plt.cycler(color=[
        '#f87171','#60a5fa','#86efac','#fb923c',
        '#c084fc','#67e8f9','#fcd34d','#f472b6']),
    'figure.figsize':    (10, 6),
    'lines.linewidth':   2,
    'font.size':         11,
    'axes.titlesize':    13,
    'axes.titlecolor':   '#f5f5f5',
    'axes.titlepad':     10,
})

# ── Safety shims: prevent model code from crashing the runner ──────
# plt.show / plt.savefig / plt.close are no-ops — the engine epilogue
# captures the figure itself after user code runs.
_real_savefig = plt.savefig
_real_close   = plt.close
plt.show    = lambda *a, **kw: None
plt.savefig = lambda *a, **kw: None
plt.close   = lambda *a, **kw: None

# suptitle(pad=...) is not a Text property — strip it silently.
_orig_suptitle = plt.Figure.suptitle
def _safe_suptitle(self, t, **kw):
    kw.pop('pad', None)
    return _orig_suptitle(self, t, **kw)
plt.Figure.suptitle = _safe_suptitle

# Cap plt.subplots() at 2 visible columns.  To prevent IndexError when model
# code accesses axes[2] or axes[3], wrap the returned axes in _FlexAxes — a
# list subclass that returns a hidden off-screen axes for out-of-range indices
# instead of raising IndexError.  Tuple unpacking (ax1, ax2 = axes) still
# works because the list has exactly the capped number of real elements.
class _FlexAxes(list):
    def __init__(self, ax_list, fig):
        super().__init__(ax_list)
        self._fig = fig
        self._overflow = {}
    def __getitem__(self, i):
        if isinstance(i, int) and not (-len(self) <= i < len(self)):
            if i not in self._overflow:
                ax = self._fig.add_axes([0, 0, 0.001, 0.001])
                ax.set_visible(False)
                self._overflow[i] = ax
            return self._overflow[i]
        return list.__getitem__(self, i)

_orig_subplots = plt.subplots
def _safe_subplots(nrows=1, ncols=1, **kw):
    orig_ncols = int(ncols)
    ncols = min(orig_ncols, 2)
    nrows = min(int(nrows), 3)
    if orig_ncols != ncols and 'figsize' in kw:
        w, h = kw['figsize']
        kw['figsize'] = (w * ncols / orig_ncols, h)
    fig, axes = _orig_subplots(nrows, ncols, **kw)
    # Only wrap in _FlexAxes when we actually capped (orig_ncols > ncols).
    # If the model requested ≤2 columns we return the numpy array untouched so
    # that axes.flatten(), tuple unpacking, and all normal numpy ops work fine.
    if orig_ncols > ncols:
        if nrows == 1:
            return fig, _FlexAxes(list(np.atleast_1d(axes)), fig)
        else:
            return fig, [_FlexAxes(list(row), fig) for row in axes]
    return fig, axes
plt.subplots = _safe_subplots

# Shared covariance-matrix repair.  Models frequently write:
#   covs = [[0.8, 0.3], [1.2, -0.4]]   — 1-D vectors, not 2×2 matrices.
# _fix_cov() turns any 1-D array into a diagonal matrix (treating the values
# as per-axis variances) and ensures the result is square.
def _fix_cov(cov, d=None):
    if cov is None or (isinstance(cov, (int, float)) and not hasattr(cov, '__len__')):
        return cov  # scalar — leave alone
    c = np.asarray(cov, dtype=float)
    if c.ndim == 1:
        c = np.diag(np.abs(c))   # [sx, sy] → diag(|sx|, |sy|)
    elif c.ndim == 2 and c.shape[0] != c.shape[1]:
        c = np.diag(np.abs(np.diag(c)))  # non-square fallback
    return c

# scipy.stats.multivariate_normal.pdf:
#   • auto-fix 1-D covariance vectors → diagonal matrices
#   • auto-transpose x when shape is (d, N) instead of (N, d)
try:
    from scipy.stats import multivariate_normal as _mvn_dist
    _mvn_orig_pdf = _mvn_dist.pdf
    def _mvn_safe_pdf(x, mean=None, cov=1, allow_singular=False, **kw):
        x = np.asarray(x, dtype=float)
        cov = _fix_cov(cov)
        if mean is not None:
            _m = np.asarray(mean, dtype=float)
            d = _m.shape[0] if _m.ndim >= 1 else 1
            if x.ndim == 2 and x.shape[0] == d and x.shape[1] != d:
                x = x.T  # (d, N) → (N, d)
        return _mvn_orig_pdf(x, mean=mean, cov=cov, allow_singular=allow_singular, **kw)
    _mvn_dist.pdf = _mvn_safe_pdf
except Exception:
    pass

# np.random.multivariate_normal: auto-fix 1-D covariance vectors.
_orig_mvn_random = np.random.multivariate_normal
def _safe_mvn_random(mean, cov, size=None, **kw):
    cov = _fix_cov(cov)
    return _orig_mvn_random(mean, cov, size=size, **kw)
np.random.multivariate_normal = _safe_mvn_random

# Auto-normalise imshow for 2-D float arrays so colormaps use the full
# data range — prevents charts that appear all-white or all-black when
# values cluster near zero.
import matplotlib.axes as _mplaxes
_orig_imshow = _mplaxes.Axes.imshow
def _auto_norm_imshow(self, X, **kw):
    if 'vmin' not in kw and 'vmax' not in kw and 'norm' not in kw:
        try:
            arr = np.asarray(X)
            if arr.ndim == 2:
                vmin, vmax = float(arr.min()), float(arr.max())
                if vmin != vmax:
                    kw['vmin'] = vmin
                    kw['vmax'] = vmax
        except Exception:
            pass
    return _orig_imshow(self, X, **kw)
_mplaxes.Axes.imshow = _auto_norm_imshow
`.trimStart()

      const EPILOGUE = `

# ── Engine epilogue: capture figure and emit base64 PNG ───────────
try:
    plt.gcf().tight_layout()
except Exception:
    pass
_buf = io.BytesIO()
_real_savefig(_buf, format='png', dpi=150, bbox_inches='tight', facecolor='#0f0f0f')
_buf.seek(0)
sys.stdout.buffer.write(base64.b64encode(_buf.read()))
_real_close('all')
`

      const fullScript = PREAMBLE + userCode + EPILOGUE

      return new Promise((resolve) => {
        const proc = spawn('python3', ['-c', fullScript], {
          timeout: 30_000,
          env: { ...process.env, MPLBACKEND: 'Agg' },
        })

        const chunks: Buffer[] = []
        const errChunks: string[] = []

        proc.stdout.on('data', (d: Buffer) => chunks.push(d))
        proc.stderr.on('data', (d: Buffer) => errChunks.push(d.toString()))

        proc.on('close', (code: number | null) => {
          if (code === 0 && chunks.length > 0) {
            const imageBase64 = Buffer.concat(chunks).toString('ascii')
            console.log(`[Python] ✅ matplotlib render OK (${imageBase64.length} base64 chars)`)
            resolve({ success: true, imageBase64 })
          } else {
            const err = errChunks.join('').trim() || `python3 exited with code ${code}`
            console.error('[Python] ❌ matplotlib render failed:', err)
            resolve({ success: false, error: err })
          }
        })

        proc.on('error', (err: Error) => {
          const msg = err.message.includes('ENOENT')
            ? 'python3 not found. Install Python 3 + matplotlib to render this chart.'
            : err.message
          console.error('[Python] ❌ spawn error:', msg)
          resolve({ success: false, error: msg })
        })
      })
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
    (_, chatId: string, id: string, role: string, content: string, attachmentsJson?: string): void =>
      saveMessage(chatId, id, role, content, attachmentsJson ?? null)
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
}
