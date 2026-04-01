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
import { readSettings } from './SettingsStore'
import { braveSearch, formatSearchResults, resolveBraveApiKey } from './BraveSearchService'
import { BASE_SYSTEM_PROMPT } from './SystemPromptService'

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

const BRAVE_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'brave_web_search',
    description:
      'Search the web for CURRENT or REAL-TIME information only. ' +
      'Use ONLY for: live data (prices, weather, scores), recent news/events, ' +
      'or when the user explicitly asks to search. ' +
      'Do NOT use for general knowledge, concepts, history, coding, math, or creative tasks.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Specific, concise search query for current/real-time information.',
        },
        count: {
          type: 'number',
          description: 'Number of results (1-10, default 5).',
        },
      },
      required: ['query'],
    },
  },
} as const

const WEB_SEARCH_SYSTEM_ADDENDUM = `
You have access to a real-time web search tool: brave_web_search. Use it selectively and only when it genuinely adds value.

USE the search tool when:
- The user explicitly asks you to search, look something up, or find current information
- The question requires data that changes frequently: stock prices, weather, live scores, election results, current news, product availability, today's events
- You need to verify a specific fact that may have changed since your training
- The user asks about something you don't know or aren't confident about — search rather than guess
- If you are not confident you know what something is (a product, company, paper, person, or event), search for it rather than guessing. Never invent an explanation for something you don't recognise.

DO NOT use the search tool for:
- Stable conceptual/theoretical knowledge (math, physics, established CS theory, history)
- Creative writing, coding help where you don't need current docs, math, analysis
- Historical facts that do not change
- Casual conversation

IMPORTANT EXCEPTION: Even if you think you know something, SEARCH if:
- It is a specific versioned product, library, framework, or course (content changes with releases)
- It is a company's current offering, pricing, or status
- It is a person's current role, recent work, or latest statements
When in doubt about whether your knowledge is current enough, search.

SELF-HONESTY RULE: Before answering from training knowledge, ask yourself: "Could this information have changed in the last year?" If yes, search first. Do not answer and then search when challenged — search proactively.

CRITICAL — DATA INTEGRITY:
- When you receive search results, only state facts, numbers, or data that are EXPLICITLY present in the search result snippets provided to you.
- Do NOT fill gaps in search results with data from your training memory. If the search results don't contain the exact current price, score, or figure the user asked for, say so explicitly and direct the user to the source URLs.
- If search results contain only links and titles but not the actual data value, say: "The search found these sources but the specific value wasn't in the snippets — check [URL] directly for the current figure."

After searching, cite your sources using the result titles and URLs.
When you do not search, answer directly from your training knowledge without mentioning the search tool.

When you have received web search results:
- Put ALL your analysis of the results inside <think>…</think>.
- Your response to the user must start with the answer directly — never with "Step 1: Analyse…" or similar.
- Keep your thinking block brief — the search results provide the key facts.
`.trim()

const WEB_SEARCH_DISABLED_ADDENDUM = `
Web search is currently disabled. You do not have access to real-time information.

If the user asks you to search the web or asks about current events or recent information:
1. Tell the user that web search is disabled and can be enabled in Settings → MCP & Tools.
2. Answer as best you can from your training knowledge, clearly noting your knowledge cutoff.
3. Suggest that the user can paste relevant content directly into the chat for you to analyse.

Never pretend to have searched when you have not.
`.trim()

/**
 * Returns true if the user message plausibly requires real-time web search.
 * Used to skip the non-streaming tool-call detection round for clearly
 * non-search queries, saving one LM Studio round-trip per message.
 *
 * Intentionally permissive — false positives (unnecessary Step 1 round) are
 * acceptable. False negatives (missing a search) produce hallucinations and
 * break the ToolCallNotification UI because the model then hallucinates
 * tool-call syntax as raw text that leaks into the markdown renderer.
 */
function messageNeedsSearch(userMessage: string): boolean {
  const msg = userMessage.toLowerCase()

  // Explicit search intent from the user
  const explicitTriggers = [
    'search', 'look up', 'look it up', 'find online', 'check online',
    "what's the latest", 'what is the latest', 'current', 'right now',
    'today', 'tonight', 'this week', 'this month', 'recent', 'recently',
    'latest', 'breaking', 'news', 'update', 'updated',
    'what is', 'who is', 'tell me about', 'explain what',
    'have you heard of', 'do you know about', 'what do you know about',
  ]
  if (explicitTriggers.some(t => msg.includes(t))) return true

  // Time-sensitive / real-time data signals
  const timeSensitive = [
    'price', 'stock', 'market', 'weather', 'forecast', 'score', 'result',
    'standings', 'live', 'happening', 'schedule', 'release date',
    'available', 'in stock', 'shipping', 'election', 'vote', 'poll',
    'earnings', 'revenue', 'gdp', 'inflation', 'rate', 'bitcoin', 'crypto',
    'launched', 'announced', 'released', 'dropped', 'just came out',
  ]
  if (timeSensitive.some(t => msg.includes(t))) return true

  if (/who (is|are|was|were) (the )?(current|new|latest|now)/.test(msg)) return true
  if (/what (is|are) (the )?(current|latest|new)/.test(msg)) return true

  // Unknown proper nouns — capitalised non-common words in short queries may be
  // named entities the model doesn't know (papers, products, companies, people).
  // No recency-signal gate: "What is Dhurandhar" should always trigger search.
  const COMMON_CAPS = new Set([
    'The', 'This', 'That', 'What', 'When', 'Where', 'Why', 'How', 'Who',
    'Can', 'Could', 'Would', 'Should', 'Does', 'Did', 'Has', 'Have', 'Will',
    'Is', 'Are', 'Was', 'Were', 'Do', 'And', 'But', 'Or', 'So', 'If',
    'I', 'My', 'We', 'You', 'It', 'He', 'She', 'They',
  ])
  const words = userMessage.trim().split(/\s+/)
  const properNouns = words.filter((w, i) =>
    i > 0 && /^[A-Z][a-zA-Z]{2,}/.test(w) && !COMMON_CAPS.has(w)
  )
  // Short query (≤8 words) containing a named proper noun → likely a definition search
  if (properNouns.length >= 1 && words.length <= 8) return true
  // "What/who is X" or "tell me about X" with a proper noun in longer queries
  if (
    /^(what|who|tell me about|explain|describe)\s+(is|are|was|were|the)\s+/i.test(msg) &&
    properNouns.length >= 1
  ) return true

  return false
}

/**
 * Sends `content` as a series of small chunks with a short delay between them.
 *
 * Purpose: when Step 1 (non-streaming) returns a direct answer without using a
 * tool call, the entire response would normally be sent as ONE chunk followed
 * immediately by CHAT_STREAM_END.  React batches those two state updates into a
 * single paint, so `isStreaming` never renders as `true` and the typewriter
 * cursor blink never appears.
 *
 * Sending in ~80-char chunks at ~16 ms intervals approximates a natural typing
 * speed (~100 tok/s) and ensures at least several render cycles with
 * `isStreaming=true`, restoring the animation.
 */
async function streamContentInChunks(
  content: string,
  sendFn: (channel: string, data: unknown) => void,
  signal: AbortSignal
): Promise<void> {
  const CHUNK_SIZE = 80
  const DELAY_MS   = 16
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    if (signal.aborted) break
    sendFn(IPC_CHANNELS.CHAT_STREAM_CHUNK, content.slice(i, i + CHUNK_SIZE))
    await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS))
  }
}

/**
 * Attempts to parse a raw tool call from content text.
 * Fallback for models that emit tool calls as text rather than structured tool_calls.
 * Format: <tool_call>toolName<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>
 * Returns null if no recognisable tool call is found.
 */
function parseRawToolCall(content: string): { name: string; args: Record<string, string> } | null {
  const match = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null

  const inner = match[1]
  const nameMatch = inner.match(/^(\w+)/)
  if (!nameMatch) return null

  const args: Record<string, string> = {}
  const keyPattern = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  let m: RegExpExecArray | null
  while ((m = keyPattern.exec(inner)) !== null) {
    args[m[1]] = m[2]
  }

  return { name: nameMatch[1], args }
}

/**
 * Strips a leading orphaned </think> tag from content.
 * Happens when LM Studio processes the think block internally (non-streaming
 * Step 1 round) but the closing tag leaks into message.content.
 * Safe to apply to every chunk — only removes a tag at the very start.
 */
function stripLeadingThinkClose(content: string): string {
  // Only strip the </think> tag and its immediately following whitespace.
  // Do NOT trimStart() — that would eat "\n\n" chunks (paragraph/code-block
  // separators sent as whitespace-only deltas), merging all text together.
  return content.replace(/^<\/think>\s*/i, '')
}

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

    // ── Read MCP settings ──────────────────────────────────────────
    const appSettings  = readSettings()
    const resolvedKey  = resolveBraveApiKey()
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey)

    // ── Build base messages ────────────────────────────────────────
    const builtMessages = applyThinkingPrefix(this.buildMessages(payload), payload.thinkingMode)
    console.log('🚀 FINAL LM STUDIO PAYLOAD:', JSON.stringify(builtMessages, null, 2))

    const isThinking = payload.thinkingMode === 'thinking'

    const toolsField = braveEnabled
      ? { tools: [BRAVE_SEARCH_TOOL], tool_choice: 'auto' }
      : {}

    // ── Step 1 body — always thinking DISABLED ────────────────────
    // Tool-detection only needs a yes/no on whether to call brave_web_search.
    // Running with thinking enabled burns 8000 tokens and causes ~11s TTFT
    // before the search even starts. Max 512 tokens is enough for a tool call.
    const step1Body = {
      model:       modelId,
      messages:    builtMessages,
      temperature: 0.1,
      max_tokens:  512,
      stop:        STOP_SEQUENCES,
      thinking:    { type: 'disabled' },
      stream:      false,
      ...toolsField,
    }

    const startTime = Date.now()
    let firstTokenAt: number | null = null
    let totalTokens  = 0
    let buffer       = ''

    // Repetition detector state
    let lineBuffer       = ''
    let lastLine         = ''
    let consecutiveCount = 0

    const send = (channel: string, data: unknown): void => {
      if (!wc.isDestroyed()) wc.send(channel, data)
    }

    let currentMessages = [...builtMessages]
    // Tracks whether a tool-call round completed (search result was injected).
    // Used to tune the Step 2 thinking budget: when search data is available
    // the model should reason less (the data provides the facts).
    let toolCallRound = false

    // Heuristic: only attempt the non-streaming tool-call round when the user message
    // plausibly requires real-time data. Conversational / knowledge questions skip it
    // entirely, saving one LM Studio round-trip per message.
    const userMessageText = (() => {
      const last = payload.messages.at(-1)
      if (!last) return ''
      return typeof last.content === 'string' ? last.content : ''
    })()
    const shouldAttemptSearch = braveEnabled && messageNeedsSearch(userMessageText)

    try {
      // ── Step 1: Non-streaming round for tool calls (only when shouldAttemptSearch) ──
      if (shouldAttemptSearch) {
        const r1 = await net.fetch(LMS_COMPLETIONS, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(step1Body),
          signal,
        } as RequestInit)

        if (!r1.ok) throw new Error(`LM Studio ${r1.status}: ${await r1.text()}`)

        const r1data = await r1.json() as {
          choices?: Array<{
            finish_reason?: string
            message?: {
              content?: string | null
              tool_calls?: Array<{
                id: string
                type: string
                function: { name: string; arguments: string }
              }>
            }
          }>
        }

        const choice = r1data.choices?.[0]

        if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
          const toolCall = choice.message.tool_calls[0]

          if (toolCall.function.name === 'brave_web_search') {
            let args: { query: string; count?: number }
            try { args = JSON.parse(toolCall.function.arguments) }
            catch { args = { query: toolCall.function.arguments } }

            console.log(`[MCP] 🔍 Brave Search: "${args.query}"`)
            send(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'searching', query: args.query })

            let searchResultText: string

            try {
              const results = await braveSearch(args.query, resolvedKey!, args.count ?? 5)
              searchResultText = formatSearchResults(results)
              console.log(`[MCP] ✅ Search returned ${results.length} results`)
              send(IPC_CHANNELS.WEB_SEARCH_STATUS, {
                phase:       'done',
                query:       args.query,
                resultCount: results.length,
                results:     results.map(r => ({ title: r.title, url: r.url })),
              })
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              console.error('[MCP] ❌ Search failed:', errMsg)

              let userFacingReason: string
              if (errMsg.includes('401'))
                userFacingReason = 'the API key is invalid or expired'
              else if (errMsg.includes('429'))
                userFacingReason = 'the search quota has been exhausted for this billing period'
              else if (errMsg.includes('ENOTFOUND') || errMsg.includes('network') || errMsg.includes('fetch'))
                userFacingReason = 'the network request failed (check your internet connection)'
              else
                userFacingReason = 'an unexpected error occurred'

              searchResultText = [
                `Web search failed: ${userFacingReason}.`,
                ``,
                `Instructions for this response:`,
                `1. Tell the user that web search failed and briefly state why (${userFacingReason}).`,
                `2. Answer as best you can from your training knowledge, noting it may not be current.`,
                `3. Suggest the user can paste relevant content directly into the chat for you to analyse.`,
                `4. If the issue is a quota or key problem, suggest they check Settings → MCP & Tools.`,
              ].join('\n')

              send(IPC_CHANNELS.WEB_SEARCH_STATUS, {
                phase: 'error',
                query: args.query,
                error: `Search failed: ${userFacingReason}`,
              })
            }

            console.log(`[MCP] 📋 Search result injected (${searchResultText.length} chars):`)
            console.log(searchResultText.slice(0, 500) + (searchResultText.length > 500 ? '...' : ''))
            currentMessages = [
              ...currentMessages,
              { role: 'assistant', content: null as unknown as string, tool_calls: choice.message.tool_calls } as { role: string; content: string },
              { role: 'tool', tool_call_id: toolCall.id, content: searchResultText } as { role: string; content: string },
            ]
            toolCallRound = true
          }
        } else if (choice?.message?.content && parseRawToolCall(choice.message.content)) {
          // Raw tool call in content — model-agnostic fallback for models that can't
          // emit structured tool_calls. Parse and execute the search.
          const raw = parseRawToolCall(choice.message.content)!

          if (raw.name === 'brave_web_search') {
            const query = raw.args['query'] ?? ''
            const count = raw.args['count'] ? parseInt(raw.args['count'], 10) : 5

            if (query) {
              console.log(`[MCP] 🔍 Brave Search (raw format): "${query}"`)
              send(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'searching', query })

              let searchResultText: string
              try {
                const results = await braveSearch(query, resolvedKey!, count)
                searchResultText = formatSearchResults(results)
                console.log(`[MCP] ✅ Search returned ${results.length} results (raw format)`)
                send(IPC_CHANNELS.WEB_SEARCH_STATUS, {
                  phase:       'done',
                  query,
                  resultCount: results.length,
                  results:     results.map(r => ({ title: r.title, url: r.url })),
                })
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err)
                console.error('[MCP] ❌ Search failed (raw format):', errMsg)
                searchResultText = 'Web search failed. Answer from your training knowledge instead.'
                send(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'error', query, error: 'Search failed' })
              }

              console.log(`[MCP] 📋 Search result injected (${searchResultText.length} chars, raw format):`)
              console.log(searchResultText.slice(0, 500) + (searchResultText.length > 500 ? '...' : ''))
              toolCallRound = true
              const syntheticId = `call_${Date.now()}`
              currentMessages = [
                ...currentMessages,
                {
                  role: 'assistant',
                  content: null as unknown as string,
                  tool_calls: [{
                    id: syntheticId, type: 'function',
                    function: { name: 'brave_web_search', arguments: JSON.stringify({ query, count }) },
                  }],
                } as { role: string; content: string },
                { role: 'tool', tool_call_id: syntheticId, content: searchResultText } as { role: string; content: string },
              ]
            }
          }
        } else if (choice?.message?.content) {
          // Model answered directly without a tool call.
          // Stream content in small chunks so React has time to render
          // `isStreaming=true` and the typewriter cursor blink is visible.
          // Sending a single large chunk + immediate STREAM_END causes React
          // to batch both updates into one paint, hiding the animation entirely.
          const cleaned = stripLeadingThinkClose(choice.message.content)
          await streamContentInChunks(cleaned, send, signal)
          const elapsed = Date.now() - startTime
          send(IPC_CHANNELS.CHAT_STREAM_END, { totalTokens: estimateTokens(cleaned), ttft: elapsed, tps: 0, totalMs: elapsed })
          return
        }
      }

      // ── Step 2: Final streaming request ────────────────────────────
      // Always runs. currentMessages includes the tool result if a search happened.
      // If Brave is disabled, this is the only request.
      //
      // Adaptive thinking budget: when search data was injected, use a smaller
      // budget (4000) — the model has real facts and shouldn't speculate at length.
      // Without a search round, allow the full 8000 for deep reasoning.
      const step2ThinkingField = isThinking
        ? { thinking: { type: 'enabled', budget_tokens: toolCallRound ? 4000 : 8000 } }
        : { thinking: { type: 'disabled' } }

      const streamBody = JSON.stringify({
        model:       modelId,
        messages:    currentMessages,
        temperature: 0.7,
        max_tokens:  isThinking ? 32768 : 16384,
        stop:        STOP_SEQUENCES,
        ...step2ThinkingField,
        stream:      true,
      })

      const response = await net.fetch(LMS_COMPLETIONS, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    streamBody,
        signal,
      } as RequestInit)

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(`LM Studio ${response.status}: ${errText}`)
      }

      if (!response.body) throw new Error('LM Studio returned no response body')

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()

      let loopAborted         = false
      let firstChunkProcessed = false
      while (true) {
        if (loopAborted) break
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

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

          if (firstTokenAt === null) firstTokenAt = Date.now()

          // Strip orphaned </think> only from the very first chunk — applying it to
          // every chunk would swallow the standalone "</think>" chunk that Qwen/GLM
          // emit, leaving the <think> block unclosed and triggering Case 3 recovery
          // (answer = thought), which causes content to appear in both the accordion
          // and the main chat body.
          const cleanedDelta = firstChunkProcessed
            ? delta
            : stripLeadingThinkClose(delta)
          firstChunkProcessed = true
          if (!cleanedDelta) continue

          totalTokens += estimateTokens(cleanedDelta)
          send(IPC_CHANNELS.CHAT_STREAM_CHUNK, cleanedDelta)

          lineBuffer += cleanedDelta
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
      const stats: GenerationStats = this.buildStats(
        startTime, firstTokenAt, totalTokens, true
      )
      send(IPC_CHANNELS.CHAT_STREAM_END, stats)
      return
    } finally {
      this.controller = null
    }

    if (totalTokens === 0 && firstTokenAt === null) {
      console.warn('[ChatService] ⚠️  Empty response from LM Studio — possible context overflow or stop-sequence collision')
      send(IPC_CHANNELS.CHAT_ERROR,
        'The model returned an empty response. This usually means the conversation context is too long. ' +
        'Try starting a new chat, or switch to Fast mode for lighter queries.'
      )
    }

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
    // Read brave settings so we can inject the correct web-search addendum
    const appSettings  = readSettings()
    const resolvedKey  = resolveBraveApiKey()
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey)

    // Inject current date so models use the right year in search queries and
    // time-sensitive reasoning — training cutoff is no longer the reference.
    const _now = new Date()
    const DATE_INJECTION = `Current date and time: ${_now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })}, ${_now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}.`

    const systemParts: string[] = [BASE_SYSTEM_PROMPT, DATE_INJECTION]
    if (braveEnabled)         systemParts.push(WEB_SEARCH_SYSTEM_ADDENDUM)
    if (!braveEnabled)        systemParts.push(WEB_SEARCH_DISABLED_ADDENDUM)
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
    const allMsgs = payload.messages.filter((m) => (m.role as string) !== 'divider')
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
