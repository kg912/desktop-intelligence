/**
 * ChatService — Main process
 *
 * Streams completions from LM Studio's OpenAI-compatible SSE endpoint.
 * Uses Electron's net.fetch (Chromium-backed, bypasses CSP/CORS issues)
 * with an AbortController for clean cancellation.
 *
 * Responsibilities:
 *  - SSE parsing and chunk forwarding via webContents.send
 *  - TTFT / tokens-per-sec / total-time telemetry
 *  - Abort support (user stop or app quit)
 */

import { net } from 'electron'
import type { WebContents } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import type { GenerationStats, ChatSendPayload } from '../../shared/types'

const LMS_COMPLETIONS = 'http://localhost:1234/v1/chat/completions'

// TARGET_MODEL_ID removed — the model is now supplied dynamically via the IPC
// payload (ChatSendPayload.model) and passed as the modelId argument to send().
// The DEFAULT_MODEL_ID fallback lives in shared/types.ts.

/**
 * Stop sequences (Section 5.4 of CLAUDE.md — ALWAYS send these).
 *
 * These guard against the Qwen runaway loop:
 *   After 5-8 messages the model emits "Final Answer: Your final answer here"
 *   infinitely.  Root cause: thinking block not properly closed → model emits
 *   the post-thinking response skeleton on repeat.
 *
 * "<|im_end|>" and "<|endoftext|>" are the official Qwen chat-template EOS
 * tokens that LM Studio / MLX may emit at stream end.  Including them
 * prevents the server from sending tokens past the natural end-of-turn marker.
 */
export const STOP_SEQUENCES = [
  '<|im_end|>',
  '<|endoftext|>',
  'Final Answer: Your final answer here',
  'Your final answer here',
]

/**
 * Repetition detector state.
 * Tracks the last N trimmed non-empty lines seen in the stream.
 * If the same line appears REPETITION_THRESHOLD times consecutively,
 * the stream is aborted and an error is sent to the renderer.
 */
const REPETITION_WINDOW    = 3   // consecutive identical lines to trigger abort
const REPETITION_MAX_LEN   = 200 // only track lines up to this length (ignore long prose)

// Vision content parts (OpenAI-compatible multimodal format)
type ContentPart =
  | { type: 'text';      text:       string }
  | { type: 'image_url'; image_url: { url: string } }

// Rough token estimator — Qwen tokenizer averages ~3.6 chars/token for English.
// Good enough for the telemetry display; we don't need exact counts here.
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6)

// ── Exported helpers (also used by unit tests) ───────────────────

/**
 * Prepends the Qwen3 soft-prompt prefix (/no_think or /think) to the last
 * user message so the MLX inference backend reliably enables or suppresses
 * the model's reasoning chain.
 *
 * Rules:
 *  • Only the LAST user message is modified — earlier turns are left intact.
 *  • For multimodal messages (ContentPart[]), the prefix is prepended to the
 *    first text part so image_url parts are not disturbed.
 *  • When there are no user messages the input is returned unchanged.
 *
 * Exported for unit testing — the logic is pure (no side effects, no I/O).
 */
export function applyThinkingPrefix(
  messages: Array<{ role: string; content: string | ContentPart[] }>,
  thinkingMode: import('../../shared/types').ThinkingMode | undefined
): Array<{ role: string; content: string | ContentPart[] }> {
  const isFast      = thinkingMode !== 'thinking'
  const prefix      = isFast ? '/no_think\n' : '/think\n'
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')

  if (lastUserIdx === -1) return messages

  const result = [...messages]
  const msg    = result[lastUserIdx]

  if (typeof msg.content === 'string') {
    result[lastUserIdx] = { ...msg, content: prefix + msg.content }
  } else if (Array.isArray(msg.content)) {
    const parts   = [...msg.content] as ContentPart[]
    const textIdx = parts.findIndex((p) => p.type === 'text')
    if (textIdx !== -1) {
      const tp   = parts[textIdx] as { type: 'text'; text: string }
      parts[textIdx] = { type: 'text', text: prefix + tp.text }
      result[lastUserIdx] = { ...msg, content: parts }
    }
  }

  return result
}

export class ChatService {
  private controller: AbortController | null = null

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  async send(
    payload: ChatSendPayload,
    modelId: string,
    wc: WebContents
  ): Promise<void> {
    // Cancel any in-flight request before starting a new one
    this.abort()
    this.controller = new AbortController()
    const { signal } = this.controller

    const builtMessages = applyThinkingPrefix(this.buildMessages(payload), payload.thinkingMode)
    console.log('🚀 FINAL LM STUDIO PAYLOAD:', JSON.stringify(builtMessages, null, 2))

    // Section 5: thinking mode payload.
    // 'thinking' → reasoning chain with 8k budget; 'fast' → disabled.
    // LM Studio/MLX passes unknown fields through to the model backend,
    // so this is safe to send even if the build doesn't honour it.
    //
    // IMPORTANT: max_tokens must be large enough for BOTH the thinking block
    // AND the visible answer.  Qwen3.5 counts all generated tokens (think +
    // answer) against max_tokens.  With 4096 the model could exhaust the
    // budget inside the <think> block and never produce a visible answer —
    // parseThinkBlocks then shows one giant unclosed thought with no answer.
    // Thinking mode: 16 000 total (≥ budget_tokens 8 000 + full answer room).
    // Fast mode:      4 096 total (unchanged — no thinking overhead).
    const isThinking = payload.thinkingMode === 'thinking'
    const thinkingField = isThinking
      ? { thinking: { type: 'enabled', budget_tokens: 8000 } }
      : { thinking: { type: 'disabled' } }

    const body = JSON.stringify({
      // modelId is supplied by the frontend via ChatSendPayload.model,
      // with DEFAULT_MODEL_ID as the fallback applied in handlers.ts.
      model:       modelId,
      messages:    builtMessages,
      stream:      true,
      temperature: 0.7,
      // Running on own compute — no per-token billing.
      // Thinking mode: 32 768 tokens (matches Qwen3.5's typical context window,
      // ensures the full thinking block + a complete answer always fit).
      // Fast mode: 16 384 tokens (4× the old cap; generous for any response type).
      max_tokens:  isThinking ? 32768 : 16384,
      // Section 5.4: always send stop sequences to prevent Qwen runaway loop.
      // These fire at the server level before any tokens are streamed back,
      // so they catch runaway patterns earlier than the client-side detector.
      stop:        STOP_SEQUENCES,
      ...thinkingField,
    })

    const startTime = Date.now()
    let firstTokenAt: number | null = null
    let totalTokens  = 0
    let buffer       = ''

    // ── Repetition detector state ────────────────────────────────
    // Accumulates the in-progress output line being built from deltas.
    // When a newline is seen we commit the line and check for repeats.
    let lineBuffer       = ''
    let lastLine         = ''
    let consecutiveCount = 0

    const send = (channel: string, data: unknown): void => {
      if (!wc.isDestroyed()) wc.send(channel, data)
    }

    try {
      const response = await net.fetch(LMS_COMPLETIONS, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      } as RequestInit)

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`LM Studio ${response.status}: ${errText}`)
      }

      if (!response.body) throw new Error('LM Studio returned no response body')

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()

      // ── SSE parse loop ──────────────────────────────────────────
      let loopAborted = false
      while (true) {
        if (loopAborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Split on newlines; keep trailing incomplete line in buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (data === '[DONE]') break

          let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> }
          try { parsed = JSON.parse(data) } catch { continue }

          const delta = parsed.choices?.[0]?.delta?.content
          if (!delta) continue

          // Record time-to-first-token
          if (firstTokenAt === null) firstTokenAt = Date.now()

          totalTokens += estimateTokens(delta)
          send(IPC_CHANNELS.CHAT_STREAM_CHUNK, delta)

          // ── Client-side repetition detector ───────────────────
          // Accumulate deltas into lines; on each newline boundary,
          // check if the model is stuck repeating the same output.
          // This is a safety net — the server-side stop sequences fire
          // first, but if LM Studio doesn't honour them this catches it.
          lineBuffer += delta
          const newlineIdx = lineBuffer.indexOf('\n')
          if (newlineIdx !== -1) {
            const completedLine = lineBuffer.slice(0, newlineIdx).trim()
            lineBuffer = lineBuffer.slice(newlineIdx + 1)

            if (
              completedLine.length > 0 &&
              completedLine.length <= REPETITION_MAX_LEN
            ) {
              if (completedLine === lastLine) {
                consecutiveCount++
                if (consecutiveCount >= REPETITION_WINDOW) {
                  console.warn(
                    `[ChatService] 🔁 Repetition detected — "${completedLine}" ` +
                    `repeated ${consecutiveCount} times. Aborting stream.`
                  )
                  this.abort()
                  loopAborted = true
                  break
                }
              } else {
                lastLine         = completedLine
                consecutiveCount = 1
              }
            }
          }
        }
      }
    } catch (err) {
      const isAbort = (err as Error).name === 'AbortError'
      if (!isAbort) {
        send(IPC_CHANNELS.CHAT_ERROR, (err as Error).message)
      }
      // Fall through to send stream-end with partial stats even on abort
      const stats: GenerationStats = this.buildStats(
        startTime, firstTokenAt, totalTokens, true
      )
      send(IPC_CHANNELS.CHAT_STREAM_END, stats)
      return
    } finally {
      this.controller = null
    }

    // ── Empty response guard ─────────────────────────────────────
    // LM Studio silently returns an empty completion (0 content deltas) when
    // the prompt exceeds the model's context window, or when the model stops
    // immediately on a stop sequence. Surface this as a visible error so the
    // user knows to start a new chat or switch to Fast mode.
    if (totalTokens === 0 && firstTokenAt === null) {
      console.warn('[ChatService] ⚠️  Empty response from LM Studio — possible context overflow or stop-sequence collision')
      send(IPC_CHANNELS.CHAT_ERROR,
        'The model returned an empty response. This usually means the conversation context is too long. ' +
        'Try starting a new chat, or switch to Fast mode for lighter queries.'
      )
    }

    // ── Successful completion ────────────────────────────────────
    const stats = this.buildStats(startTime, firstTokenAt, totalTokens, false)
    send(IPC_CHANNELS.CHAT_STREAM_END, stats)
  }

  abort(): void {
    if (this.controller) {
      this.controller.abort()
      this.controller = null
    }
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  // Strip <think>…</think> blocks from assistant history messages before
  // sending to LM Studio.  Past reasoning chains are useless to the model on
  // the next turn — only the final answers matter — but they consume thousands
  // of tokens.  Using lastIndexOf matches our renderer logic (Qwen sometimes
  // mentions </think> inside the thought, so we split at the LAST occurrence).
  private stripThinkBlocks(content: string): string {
    const open  = '<think>'
    const close = '</think>'
    const start = content.indexOf(open)
    if (start === -1) return content                       // no think block
    const end = content.lastIndexOf(close)
    if (end === -1) return content.slice(0, start).trim() // unclosed block
    return (content.slice(0, start) + content.slice(end + close.length)).trim()
  }

  // LM Studio vision content part shapes
  private buildMessages(
    payload: ChatSendPayload
  ): Array<{ role: string; content: string | ContentPart[] }> {
    const msgs: Array<{ role: string; content: string | ContentPart[] }> = []

    // ── System prompt: explicit + document injections ────────────
    const systemParts: string[] = []
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt)

    const docInjections = (payload.attachments ?? [])
      .filter((a) => a.kind === 'document' && a.inject)
      .map((a) => a.inject!)
    if (docInjections.length > 0) systemParts.push(docInjections.join('\n\n'))

    if (systemParts.length > 0) {
      msgs.push({ role: 'system', content: systemParts.join('\n\n') })
    }

    // ── History trim ─────────────────────────────────────────────
    // Assistant responses can be very large (ECharts JSON, Mermaid source,
    // long explanations). Replaying the full unbounded history on every turn
    // eventually overflows the model's context window, causing LM Studio to
    // return a silent empty completion. We keep only the last HISTORY_WINDOW
    // messages (always including the current user message at the end).
    const HISTORY_WINDOW = 20  // ~10 exchange pairs; adjust if needed
    const allMsgs = payload.messages.filter((m) => m.role !== 'divider')
    const trimmed = allMsgs.length > HISTORY_WINDOW
      ? allMsgs.slice(allMsgs.length - HISTORY_WINDOW)
      : allMsgs

    if (allMsgs.length > HISTORY_WINDOW) {
      console.log(
        `[ChatService] ✂️  History trimmed: ${allMsgs.length} → ${trimmed.length} messages ` +
        `(HISTORY_WINDOW=${HISTORY_WINDOW})`
      )
    }

    // ── Image attachments go on the last user message ────────────
    const images = (payload.attachments ?? [])
      .filter((a) => a.kind === 'image' && a.dataUrl)

    const lastIdx = trimmed.length - 1

    for (let i = 0; i < trimmed.length; i++) {
      const m = trimmed[i]

      if (images.length > 0 && m.role === 'user' && i === lastIdx) {
        const parts: ContentPart[] = [{ type: 'text', text: m.content }]
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } })
        }
        msgs.push({ role: m.role, content: parts })
      } else {
        // Strip think blocks from assistant history — past reasoning chains are
        // pure overhead: they consume thousands of tokens per turn but contribute
        // nothing to the next response.  Only the final answer is kept.
        const content = m.role === 'assistant'
          ? this.stripThinkBlocks(m.content)
          : m.content
        msgs.push({ role: m.role, content })
      }
    }

    return msgs
  }

  private buildStats(
    startTime:   number,
    firstTokenAt: number | null,
    totalTokens:  number,
    aborted:      boolean
  ): GenerationStats {
    const totalMs = Date.now() - startTime
    const ttft    = firstTokenAt !== null ? firstTokenAt - startTime : totalMs
    const elapsed = Math.max(totalMs / 1000, 0.001)

    return {
      ttft,
      tokensPerSec: Math.round((totalTokens / elapsed) * 10) / 10,
      totalMs,
      totalTokens,
      aborted,
    }
  }
}

export const chatService = new ChatService()
