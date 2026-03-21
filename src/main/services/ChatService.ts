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

// Vision content parts (OpenAI-compatible multimodal format)
type ContentPart =
  | { type: 'text';      text:       string }
  | { type: 'image_url'; image_url: { url: string } }

// Rough token estimator — Qwen tokenizer averages ~3.6 chars/token for English.
// Good enough for the telemetry display; we don't need exact counts here.
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6)

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

    const builtMessages = this.buildMessages(payload)
    console.log('🚀 FINAL LM STUDIO PAYLOAD:', JSON.stringify(builtMessages, null, 2))

    const body = JSON.stringify({
      // modelId is supplied by the frontend via ChatSendPayload.model,
      // with DEFAULT_MODEL_ID as the fallback applied in handlers.ts.
      model:       modelId,
      messages:    builtMessages,
      stream:      true,
      temperature: 0.7,
      max_tokens:  4096,
    })

    const startTime = Date.now()
    let firstTokenAt: number | null = null
    let totalTokens  = 0
    let buffer       = ''

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
      while (true) {
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

    // ── Image attachments go on the last user message ────────────
    const images = (payload.attachments ?? [])
      .filter((a) => a.kind === 'image' && a.dataUrl)

    const lastIdx = payload.messages.length - 1

    for (let i = 0; i < payload.messages.length; i++) {
      const m = payload.messages[i]

      if (images.length > 0 && m.role === 'user' && i === lastIdx) {
        const parts: ContentPart[] = [{ type: 'text', text: m.content }]
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } })
        }
        msgs.push({ role: m.role, content: parts })
      } else {
        msgs.push({ role: m.role, content: m.content })
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
