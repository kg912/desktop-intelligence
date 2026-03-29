/**
 * Browser mock for window.api
 * Activated in main.tsx when window.api is undefined (Vite dev server / preview).
 * Simulates real streaming so Phase 3 features are visible in the demo.
 */

import type { ElectronAPI } from '../../../preload/index'
import type {
  ConnectionState,
  DaemonState,
  GenerationStats,
  AttachmentFilePayload,
  ProcessedAttachment,
  WebSearchStatus,
  Chat,
  StoredMessage,
} from '../../../shared/types'

// ── Pub/sub bus ──────────────────────────────────────────────────
type Listener<T> = (value: T) => void

function pubsub<T>() {
  const subs: Listener<T>[] = []
  return {
    emit:      (v: T)            => subs.forEach((s) => s(v)),
    subscribe: (fn: Listener<T>) => {
      subs.push(fn)
      return () => { const i = subs.indexOf(fn); if (i > -1) subs.splice(i, 1) }
    }
  }
}

const chunkBus  = pubsub<string>()
const endBus    = pubsub<GenerationStats>()
const errorBus  = pubsub<string>()

// ── Demo response corpus ─────────────────────────────────────────
// Showcases every Phase 3 feature: markdown headings, bold/italic,
// inline LaTeX, display LaTeX, a syntax-highlighted code block,
// and a final stats bar.
const DEMO_RESPONSE = `## Self-Attention: Mathematical Intuition

Given input $X \\in \\mathbb{R}^{n \\times d}$, we compute three projections:

$$Q = XW_Q, \\quad K = XW_K, \\quad V = XW_V$$

The attention scores are:

$$\\text{Attention}(Q, K, V) = \\text{softmax}\\!\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$

The $\\sqrt{d_k}$ scaling prevents dot products from growing large in high dimensions, which would push softmax into regions of **vanishing gradients**.

### Python Implementation

\`\`\`python
import torch
import torch.nn.functional as F
import math

def scaled_dot_product_attention(Q, K, V, mask=None):
    """
    Args:
        Q: [batch, heads, seq_len, d_k]
        K: [batch, heads, seq_len, d_k]
        V: [batch, heads, seq_len, d_k]
    Returns:
        output: [batch, heads, seq_len, d_k]
        weights: attention weight matrix
    """
    d_k = Q.size(-1)
    scores = torch.matmul(Q, K.transpose(-2, -1)) / math.sqrt(d_k)

    if mask is not None:
        scores = scores.masked_fill(mask == 0, -1e9)

    weights = F.softmax(scores, dim=-1)
    return torch.matmul(weights, V), weights
\`\`\`

### Multi-Head Attention

For $h$ parallel attention heads, outputs are concatenated and re-projected:

$$\\text{MHA}(Q,K,V) = \\text{Concat}(\\text{head}_1, \\ldots, \\text{head}_h)\\,W_O$$

where $\\text{head}_i = \\text{Attention}(QW_i^Q,\\, KW_i^K,\\, VW_i^V)$.

The key insight is that **each head can specialise** — one might attend to syntactic dependencies, another to semantic similarity, and a third to positional patterns.
`

// Stream the response in realistic ~4-char chunks at ~70 tok/s
async function streamResponse(): Promise<void> {
  const CHUNK_CHARS   = 4          // chars per chunk
  const DELAY_MS      = 22         // ms between chunks (~181 chunks/s → ~4×181/3.6 ≈ 201 t/s, scaled by chunks)
  const THINK_DELAY   = 380        // ms before first token (simulates TTFT)

  await delay(THINK_DELAY)

  const startTime    = Date.now()
  let   firstTokenAt = Date.now()
  let   totalChars   = 0

  for (let i = 0; i < DEMO_RESPONSE.length; i += CHUNK_CHARS) {
    const chunk = DEMO_RESPONSE.slice(i, i + CHUNK_CHARS)
    chunkBus.emit(chunk)
    totalChars += chunk.length
    await delay(DELAY_MS)
  }

  const totalMs    = Date.now() - startTime
  const totalTokens = Math.round(totalChars / 3.6)
  const ttft        = firstTokenAt - (startTime - THINK_DELAY)

  endBus.emit({
    ttft:         ttft,
    tokensPerSec: Math.round((totalTokens / (totalMs / 1000)) * 10) / 10,
    totalMs:      totalMs + THINK_DELAY,
    totalTokens,
    aborted:      false,
  })
}

// ── Concurrency guard — only one demo stream at a time ───────────
let mockStreaming = false

// ── Demo trigger — called by useChat once mounted in mock mode ───
export let triggerDemo: ((text: string) => void) | null = null
export function registerDemoTrigger(fn: (text: string) => void) {
  triggerDemo = fn
}

// ── In-memory chat store (mock mode only) ────────────────────────
let mockChats: Chat[] = []
const mockMessages: Record<string, StoredMessage[]> = {}

// ── Mock API ────────────────────────────────────────────────────
const READY_STATE: ConnectionState = {
  status:        'ready',
  modelInfo:     {
    id:       'qwen3-30b-a3b-mlx@8bit',
    object:   'model',
    created:  Date.now(),
    owned_by: 'lm-studio',
  },
  lastChecked:   Date.now(),
  error:         null,
  pollIntervalMs: 15000,
}

const DAEMON_READY: DaemonState = {
  phase:  'ready',
  error:  null,
  stderr: null,
}

export const mockApi: ElectronAPI = {
  // ── Connection (always ready in mock) ────────────────────────
  getModelStatus:      async () => READY_STATE,
  forcePoll:           async () => READY_STATE,
  onModelStatusChange: (cb) => {
    // Emit once so the hook has data on mount
    queueMicrotask(() => cb(READY_STATE))
    return () => {}
  },

  // ── Daemon ────────────────────────────────────────────────────
  getDaemonState:      async () => DAEMON_READY,
  retryDaemon:         async () => DAEMON_READY,
  onDaemonStateChange: () => () => {},

  // ── Chat ──────────────────────────────────────────────────────
  sendChatMessage: async (_payload) => {
    if (mockStreaming) return
    mockStreaming = true
    streamResponse()
      .catch(console.error)
      .finally(() => { mockStreaming = false })
  },
  abortChat: () => {},

  onChatStreamChunk: (cb) => chunkBus.subscribe(cb),
  onChatStreamEnd:   (cb) => endBus.subscribe(cb),
  onChatError:       (cb) => errorBus.subscribe(cb),

  // ── File processing (mock — no real FS access in browser) ────
  processFile: async (_payload: AttachmentFilePayload): Promise<ProcessedAttachment> => {
    const isImage = _payload.mimeType.startsWith('image/')
    return {
      id:      `mock-${Date.now()}`,
      name:    _payload.fileName,
      kind:    isImage ? 'image' : 'document',
      dataUrl: null,
      inject:  isImage
        ? null
        : `[System: The user has attached a document named ${_payload.fileName}. It has been parsed and stored.]`,
    }
  },

  onWebSearchStatus: (_cb: (s: WebSearchStatus) => void): (() => void) => () => {},

  // ── RAG stubs ─────────────────────────────────────────────────
  ingestFile:        async () => {},
  onIngestProgress:  () => () => {},

  // ── Matplotlib stub (browser cannot run Python) ───────────────
  renderMatplotlib: async (_code: string) => ({
    success: false as const,
    error: 'matplotlib rendering requires the Electron runtime — not available in browser preview.',
  }),

  // ── Chat History (in-memory mock) ─────────────────────────────
  getChats: async (): Promise<Chat[]> => [...mockChats],

  getChatMessages: async (chatId: string): Promise<StoredMessage[]> =>
    mockMessages[chatId] ? [...mockMessages[chatId]] : [],

  newChat: async (id: string, title: string): Promise<Chat> => {
    const now  = Date.now()
    const chat: Chat = { id, title, createdAt: now, updatedAt: now }
    mockChats = [chat, ...mockChats]
    mockMessages[id] = []
    return chat
  },

  deleteChat: async (chatId: string): Promise<void> => {
    mockChats = mockChats.filter((c) => c.id !== chatId)
    delete mockMessages[chatId]
  },

  saveMessage: async (
    chatId: string,
    _id: string,
    role: string,
    content: string,
    attachmentsJson?: string | null
  ): Promise<void> => {
    if (!mockMessages[chatId]) mockMessages[chatId] = []
    mockMessages[chatId].push({
      role:            role as 'user' | 'assistant' | 'system',
      content,
      attachmentsJson: attachmentsJson ?? null,
    })
    // Bump updatedAt
    const chat = mockChats.find((c) => c.id === chatId)
    if (chat) chat.updatedAt = Date.now()
  },
}

// ── Helpers ───────────────────────────────────────────────────────
// Use MessageChannel instead of setTimeout so the stream is not
// throttled when the preview tab is backgrounded / not focused.
function delay(_ms: number): Promise<void> {
  return new Promise((r) => {
    const ch = new MessageChannel()
    ch.port1.onmessage = () => r()
    ch.port2.postMessage(null)
  })
}
