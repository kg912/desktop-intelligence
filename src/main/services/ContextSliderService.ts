/**
 * ContextSliderService — Main process
 *
 * Protects the M-series GPU from OOM by enforcing a hard token budget.
 *
 * Budget: 6 000 tokens (system + RAG context + chat history combined)
 *
 * When over budget:
 *   1. Split history at 50 %
 *   2. Send old half to LM Studio for summarisation (non-streaming, 15 s timeout)
 *   3. Replace old half with a single [Summary of previous context: ...] message
 *
 * Token counting uses tiktoken (cl100k_base) with a character-ratio fallback
 * in case the WASM binary fails to load in the Electron environment.
 */

import { net }           from 'electron'
import type { WireMessage } from '../../shared/types'

const TOKEN_BUDGET = 6_000
const LMS_URL      = 'http://localhost:1234/v1/chat/completions'

// ── Token counter (lazy-init to avoid startup cost) ───────────────
type CountFn = (text: string) => number

let _countTokens: CountFn | null = null

function countTokens(text: string): number {
  if (!_countTokens) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { get_encoding } = require('tiktoken')
      const enc              = get_encoding('cl100k_base')
      _countTokens = (t: string): number => enc.encode(t).length
    } catch {
      // Fallback — Qwen's BPE averages ~3.6 chars/token for English
      _countTokens = (t: string): number => Math.ceil(t.length / 3.6)
    }
  }
  return _countTokens(text)
}

function countMessagesTokens(messages: WireMessage[]): number {
  // +4 per message = role overhead (matches OpenAI's counting method)
  return messages.reduce((sum, m) => sum + countTokens(m.content) + 4, 0)
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Returns either the original messages array (within budget) or
 * a condensed version where the oldest 50 % has been summarised.
 * Never throws — falls back to simple truncation on summary failure.
 */
export async function slideIfNeeded(
  messages:     WireMessage[],
  systemPrompt: string,
  modelId:      string
): Promise<WireMessage[]> {
  const sysTokens = countTokens(systemPrompt)
  const msgTokens = countMessagesTokens(messages)
  const total     = sysTokens + msgTokens

  if (total <= TOKEN_BUDGET) return messages

  const splitAt = Math.floor(messages.length * 0.5)
  if (splitAt < 2) return messages   // not enough history to condense

  const toSummarise = messages.slice(0, splitAt)
  const toKeep      = messages.slice(splitAt)

  try {
    const summary = await generateSummary(toSummarise, modelId)
    const summaryMsg: WireMessage = {
      role:    'system',
      content: `[Summary of previous context:\n${summary}]`,
    }
    return [summaryMsg, ...toKeep]
  } catch {
    // Summarisation failed or timed out — just discard old messages
    return toKeep
  }
}

// ── Internal ──────────────────────────────────────────────────────

async function generateSummary(
  messages: WireMessage[],
  modelId:  string
): Promise<string> {
  const convo = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n')

  type CompletionResponse = {
    choices?: Array<{ message?: { content?: string } }>
  }

  const result = await Promise.race<CompletionResponse>([
    net.fetch(LMS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      modelId,
        stream:     false,
        max_tokens: 512,
        messages: [
          {
            role:    'system',
            content: 'Summarise the following conversation as dense, precise bullet points. '
                   + 'Preserve all key technical details, decisions, and context. Be concise.',
          },
          { role: 'user', content: convo },
        ],
      }),
    } as RequestInit).then((r) => r.json()),

    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('summary timeout')), 15_000)
    ),
  ])

  return result.choices?.[0]?.message?.content ?? '[Could not generate summary]'
}
