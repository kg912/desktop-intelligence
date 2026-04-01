/**
 * tokenUtils — shared token counting
 *
 * Lazy-initialised cl100k_base encoder (tiktoken) with a char-ratio fallback
 * in case the WASM binary fails to load in the Electron environment.
 *
 * Qwen's BPE tokeniser averages ~3.6 chars/token for English — the fallback
 * is accurate enough for budget decisions (within ~15 % of true count).
 *
 * Exported as a plain synchronous function so callers need no await.
 */

type CountFn = (text: string) => number

let _countTokens: CountFn | null = null

export function countTokens(text: string): number {
  if (!_countTokens) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { get_encoding } = require('tiktoken')
      const enc = get_encoding('cl100k_base')
      _countTokens = (t: string): number => enc.encode(t).length
    } catch {
      // Fallback — Qwen's BPE averages ~3.6 chars/token for English
      _countTokens = (t: string): number => Math.ceil(t.length / 3.6)
    }
  }
  return _countTokens(text)
}

/** Sum token costs for an array of messages (includes +4 per-message overhead). */
export function countMessagesTokens(
  messages: Array<{ content: string | unknown }>
): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    return sum + countTokens(text) + 4
  }, 0)
}
