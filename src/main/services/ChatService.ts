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
import type { GenerationStats, ChatSendPayload, WireMessage } from '../../shared/types'
import { readSettings } from './SettingsStore'
import { braveSearch, formatSearchResults, resolveBraveApiKey } from './BraveSearchService'
import { BASE_SYSTEM_PROMPT } from './SystemPromptService'
import { countTokens } from './tokenUtils'

const LMS_COMPLETIONS = 'http://localhost:1234/v1/chat/completions'

// Debug logging — only active in dev builds (npm run package:dev sets DEV_MODE=true).
// __DEV_MODE__ is a compile-time constant injected by Rollup define — see globals.d.ts.
const DEBUG = __DEV_MODE__

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
const REPETITION_WINDOW = 3   // consecutive identical lines to trigger abort
const REPETITION_MAX_LEN = 200 // only track lines up to this length (ignore long prose)

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

TOOL CALL FORMAT: When you decide to search, use the structured tool_calls mechanism only. Do NOT:
- Emit multiple queries as a JSON array
- Wrap the tool call in a code block (\`\`\`brave_web_search ... \`\`\`)
- Emit raw XML like <tool_call>...</tool_call>
One search per response. If you need information on multiple topics, pick the most important one.
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
    'courses', 'course', 'best course', 'recommend', 'recommendation',
    'where can i', 'how do i get', 'how can i learn', 'where to learn',
    'available now', 'sign up', 'enrol', 'enroll', 'certification', 'certificate',
    'bootcamp', 'tutorial', 'tutorials', 'learn online',
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

  if (words.length <= 3 && properNouns.length === 0) return false

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
  const DELAY_MS = 16
  const cleanedContent = stripLeadingThinkClose(content)
  for (let i = 0; i < cleanedContent.length; i += CHUNK_SIZE) {
    if (signal.aborted) break
    sendFn(IPC_CHANNELS.CHAT_STREAM_CHUNK, cleanedContent.slice(i, i + CHUNK_SIZE))
    await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS))
  }
}

/**
 * Attempts to parse a raw tool call from content text.
 * Fallback for models that emit tool calls as text rather than structured tool_calls.
 *
 * Handles all observed formats:
 *   Format A — XML arg_key/arg_value:
 *     <tool_call>brave_web_search<arg_key>query</arg_key><arg_value>...</arg_value></tool_call>
 *   Format B — unquoted key=value:
 *     <tool_call>brave_web_search query=the query here count=5</tool_call>
 *   Format C — quoted key="value":
 *     <tool_call>brave_web_search query="the query here"</tool_call>
 *   Format D — JSON object after tool name:
 *     <tool_call>brave_web_search {"query": "the query"}</tool_call>
 *
 * Returns null if no recognisable tool call is found.
 */
function parseRawToolCall(content: string): { name: string; args: Record<string, string> } | null {
  // Format F: pipe-delimited format used by Gemma 4 and similar models
  // <|tool_call>call:brave_web_search{queries:["...","..."]}<tool_call|>
  const pipeMatch = content.match(/<\|tool_call>([\s\S]*?)<tool_call\|>/)
  if (pipeMatch) {
    const inner = pipeMatch[1].trim()
    // Strip the "call:" prefix to get the function name
    const callMatch = inner.match(/^call:(\w+)(.*)$/s)
    if (callMatch) {
      const name = callMatch[1].trim()
      const argsStr = callMatch[2].trim()
      try {
        const parsed = JSON.parse(argsStr)
        if (typeof parsed === 'object' && parsed !== null) {
          const args: Record<string, string> = {}
          // Normalise: "queries" array → take first element as "query"
          if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
            args['query'] = String(parsed.queries[0])
          } else if (typeof parsed.query === 'string') {
            args['query'] = parsed.query
          }
          // Pass through any other string fields
          for (const [k, v] of Object.entries(parsed)) {
            if (k !== 'queries' && k !== 'query') args[k] = String(v)
          }
          if (args['query']) return { name, args }
        }
      } catch { /* not valid JSON — fall through */ }
    }
  }

  const match = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null

  const inner = match[1].trim()

  // Format E: Qwen structured format
  const funcMatch = inner.match(/<function=([^>]+)>([\s\S]*?)(?:<\/function>|$)/)
  if (funcMatch) {
    const name = funcMatch[1].trim()
    const argsContent = funcMatch[2]
    const args: Record<string, string> = {}
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)(?:<\/parameter>|$)/g
    let pm: RegExpExecArray | null
    while ((pm = paramRegex.exec(argsContent)) !== null) {
      args[pm[1].trim()] = pm[2].trim()
    }
    if (Object.keys(args).length > 0) return { name, args }
  }

  const nameMatch = inner.match(/^(\w+)/)
  if (!nameMatch) return null
  const name = nameMatch[1]
  const rest = inner.slice(name.length).trim()

  const args: Record<string, string> = {}
  let m: RegExpExecArray | null

  // Format A: XML arg_key/arg_value tags
  const xmlPattern = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  while ((m = xmlPattern.exec(rest)) !== null) {
    args[m[1]] = m[2].trim()
  }
  if (Object.keys(args).length > 0) return { name, args }

  // Format C: quoted key="value" pairs (before unquoted to avoid partial match)
  const quotedPattern = /(\w+)="([^"]*)"/g
  while ((m = quotedPattern.exec(rest)) !== null) {
    args[m[1]] = m[2]
  }
  if (Object.keys(args).length > 0) return { name, args }

  // Format B: unquoted key=value pairs
  const unquotedPattern = /(\w+)=([^=\s"]+(?:\s+(?!\w+=)[^=\s"]+)*)/g
  while ((m = unquotedPattern.exec(rest)) !== null) {
    args[m[1]] = m[2].trim()
  }
  if (Object.keys(args).length > 0) return { name, args }

  // Format D: JSON object
  try {
    const parsed = JSON.parse(rest)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        args[k] = String(v)
      }
      if (Object.keys(args).length > 0) return { name, args }
    }
  } catch { /* not JSON */ }

  return { name, args }
}

/**
 * Extracts a search query from code-fence tool calls or bare JSON arrays.
 *
 * Handles:
 *   - ```BRAVE_WEB_SEARCH\n[{"query":"..."}, ...]\n```
 *   - ```brave_web_search\n{"query":"..."}\n```
 *   - Bare JSON array in content: [{"query":"..."}, ...]
 *
 * Returns the first query string found, or null.
 */
function extractQueryFromCodeFenceToolCall(content: string): string | null {
  // Match fenced code blocks with tool-related language tags
  const fencePattern = /```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)\n([\s\S]*?)```/i
  const fenceMatch = content.match(fencePattern)
  const raw = fenceMatch ? fenceMatch[1].trim() : content.trim()

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0]
      if (typeof first === 'object' && first !== null && typeof first.query === 'string') {
        return first.query
      }
    }
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as Record<string, unknown>).query === 'string') {
      return (parsed as Record<string, string>).query
    }
  } catch { /* not JSON */ }

  return null
}

/**
 * Mid-stream tool call detection logic.
 * Handles extracting tool queries from incomplete or incorrectly formatted tags during SSE stream decoding.
 * Returns the detected query and the cleaned buffer to retract.
 */
function detectMidStreamToolCall(buffer: string): { query: string; cleanedBuffer: string } | null {
  // Case 1: Closed <tool_call> tag (e.g. standard fallback)
  if (buffer.includes('</tool_call>')) {
    const raw = parseRawToolCall(buffer)
    const q = raw?.args?.['query']
    if (q) {
      return {
        query: q,
        cleanedBuffer: buffer.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim(),
      }
    }
  }

  // Case 2: Unclosed <tool_call> (often emitted at stream end or mid-stream before stop token)
  const unclosedMatch = buffer.match(/<tool_call>([\s\S]+)$/i)
  if (unclosedMatch) {
    const inner = unclosedMatch[1].trim()
    // It's likely a complete JSON object if it ends with } or a completed format C string ="..." or a completed Qwen parameter tag
    if (inner.endsWith('}') || inner.includes('="') || inner.includes('</parameter>')) {
      const fakeClosed = buffer + '</tool_call>'
      const raw = parseRawToolCall(fakeClosed)
      const q = raw?.args?.['query']
      if (q) {
        return {
          query: q,
          cleanedBuffer: buffer.replace(/<tool_call>[\s\S]*$/i, '').trim(),
        }
      }
    }
  }

  // Case 5: Closed pipe-delimited tag <|tool_call>...<tool_call|>
  if (buffer.includes('<tool_call|>')) {
    const raw = parseRawToolCall(buffer)
    const q = raw?.args?.['query']
    if (q) {
      return {
        query: q,
        cleanedBuffer: buffer.replace(/<\|tool_call>[\s\S]*?<tool_call\|>/gi, '').trim(),
      }
    }
  }

  // Case 6: Unclosed pipe-delimited tag — stream ended before <tool_call|>
  const unclosedPipeMatch = buffer.match(/<\|tool_call>([\s\S]+)$/i)
  if (unclosedPipeMatch) {
    const inner = unclosedPipeMatch[1].trim()
    // Looks complete if it ends with ] or } (JSON closed)
    if (inner.endsWith(']') || inner.endsWith('}')) {
      const fakeClosed = buffer + '<tool_call|>'
      const raw = parseRawToolCall(fakeClosed)
      const q = raw?.args?.['query']
      if (q) {
        return {
          query: q,
          cleanedBuffer: buffer.replace(/<\|tool_call>[\s\S]*$/i, '').trim(),
        }
      }
    }
  }

  // Case 3: Closed code fence (```brave_web_search)
  const fenceQuery = extractQueryFromCodeFenceToolCall(buffer)
  if (fenceQuery) {
    return {
      query: fenceQuery,
      cleanedBuffer: buffer.replace(/```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)[\s\S]*?```/gi, '').trim(),
    }
  }

  // Case 4: Unclosed code fence
  const unclosedFenceMatch = buffer.match(/```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)\n([\s\S]+)$/i)
  if (unclosedFenceMatch) {
    const inner = unclosedFenceMatch[1].trim()
    if (inner.endsWith('}') || inner.endsWith(']')) {
      const fakeClosed = buffer + '\n```'
      const fq = extractQueryFromCodeFenceToolCall(fakeClosed)
      if (fq) {
        return {
          query: fq,
          cleanedBuffer: buffer.replace(/```(?:brave_web_search|BRAVE_WEB_SEARCH|tool_call|TOOL_CALL)[\s\S]*$/i, '').trim(),
        }
      }
    }
  }

  return null
}

/**
 * Strips a leading orphaned </think> tag from content.
 * Happens when LM Studio processes the think block internally (non-streaming
 * Step 1 round) but the closing tag leaks into message.content.
 * Safe to apply to every chunk — only removes a tag at the very start.
 */
function stripLeadingThinkClose(content: string): string {
  // Only strip the closing tag and its immediately following whitespace.
  // Do NOT trimStart() — that would eat "\n\n" chunks (paragraph/code-block
  // separators sent as whitespace-only deltas), merging all text together.
  // Handles both Qwen3 </think> and Gemma 4 <channel|> orphaned close tags.
  return content
    .replace(/^<\/think>\s*/i, '')
    .replace(/^<channel\|>\s*/i, '')
}

// Vision content parts (OpenAI-compatible multimodal format)
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

// Rough token estimator — Qwen tokenizer averages ~3.6 chars/token for English.
// Good enough for the telemetry display; we don't need exact counts here.
const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6)

/**
 * Replaces matplotlib/python code fences in old assistant history messages
 * with a compact stub describing what the chart was.
 *
 * Motivation: the code blocks in old turns are not needed by the model on
 * the next turn — only the fact that a chart was generated matters.  Stubbing
 * them saves a significant number of tokens without losing conversational context.
 *
 * Exported for unit testing.
 */
export function stubMatplotlibBlocks(content: string): string {
  return content.replace(
    /```(?:python|matplotlib)\n([\s\S]*?)```/gi,
    (_match, code: string) => {
      // Extract a human-readable caption from the code
      const titleMatch = code.match(/plt\.(?:title|suptitle)\(\s*['"]([^'"]+)['"]/)
      const xlabelMatch = code.match(/plt\.xlabel\(\s*['"]([^'"]+)['"]/)
      const varMatch = code.match(/^(\w+)\s*=/m)
      const caption =
        titleMatch?.[1] ??
        xlabelMatch?.[1] ??
        (varMatch ? `chart of ${varMatch[1]}` : 'chart')
      return `[Previously generated matplotlib chart: "${caption}"]`
    }
  )
}

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
  thinkingMode: import('../../shared/types').ThinkingMode | undefined,
  model?: string
): Array<{ role: string; content: string | ContentPart[] }> {
  // Gemma models do not recognise /think or /no_think — they are Qwen/MLX-specific
  // soft-prompt tokens. Injecting them into Gemma messages causes them to be echoed
  // verbatim inside the <think> block, polluting the thought accordion with junk text.
  if (model?.toLowerCase().includes('gemma')) return messages

  const isFast = thinkingMode !== 'thinking'
  const prefix = isFast ? '/no_think\n' : '/think\n'
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')

  if (lastUserIdx === -1) return messages

  const result = [...messages]
  const msg = result[lastUserIdx]

  if (typeof msg.content === 'string') {
    result[lastUserIdx] = { ...msg, content: prefix + msg.content }
  } else if (Array.isArray(msg.content)) {
    const parts = [...msg.content] as ContentPart[]
    const textIdx = parts.findIndex((p) => p.type === 'text')
    if (textIdx !== -1) {
      const tp = parts[textIdx] as { type: 'text'; text: string }
      parts[textIdx] = { type: 'text', text: prefix + tp.text }
      result[lastUserIdx] = { ...msg, content: parts }
    }
  }

  return result
}

// ── executeSearchQueries ──────────────────────────────────────────────────────
// Runs one or more search queries sequentially, merges results, and returns a
// formatted context string for injection into Step 2. Sends WEB_SEARCH_STATUS
// IPC events so the renderer can show the search spinner and result pill.
async function executeSearchQueries(
  queries: string[],
  apiKey: string,
  sendFn: (channel: string, data: unknown) => void,
  primaryQuery: string
): Promise<string> {
  const deduped = [...new Set(queries.map(q => q.trim()).filter(q => q.length > 0))].slice(0, 3)
  sendFn(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'searching', query: primaryQuery })

  const allResults: Array<{ title: string; url: string; description: string }> = []
  const resultSections: string[] = []

  for (const query of deduped) {
    try {
      const results = await braveSearch(query, apiKey, 5)
      if (results.length > 0) {
        allResults.push(...results)
        const section = deduped.length > 1
          ? `## Results for: "${query}"\n${formatSearchResults(results)}`
          : formatSearchResults(results)
        resultSections.push(section)
        console.log(`[MCP] ✅ Search "${query}" returned ${results.length} results`)
      }
    } catch (err) {
      console.error(`[MCP] ❌ Search failed for "${query}":`, err)
    }
  }

  if (allResults.length === 0) {
    sendFn(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'error', query: primaryQuery, error: 'All searches returned no results' })
    return 'Web search returned no results. Answer from your training knowledge instead.'
  }

  // Dedup URLs, keep top 5 for the notification pill
  const seen = new Set<string>()
  const uniqueResults = allResults.filter(r => {
    if (seen.has(r.url)) return false
    seen.add(r.url)
    return true
  })

  sendFn(IPC_CHANNELS.WEB_SEARCH_STATUS, {
    phase: 'done',
    query: primaryQuery,
    resultCount: uniqueResults.length,
    results: uniqueResults.slice(0, 5).map(r => ({ title: r.title, url: r.url })),
  })

  return resultSections.join('\n\n')
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
    const appSettings = readSettings()
    const resolvedKey = resolveBraveApiKey()
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey)

    // ── Build base messages ────────────────────────────────────────
    const builtMessages = applyThinkingPrefix(this.buildMessages(payload), payload.thinkingMode, payload.model)
    console.log('🚀 FINAL LM STUDIO PAYLOAD:', JSON.stringify(builtMessages, null, 2))

    // For Step 1 (non-streaming tool detection), strip the <|think|> prefix from
    // the system message. Gemma 4 activates thinking via this system prompt token,
    // which overrides thinking:disabled in the payload and causes 30-50s silent waits.
    // builtMessages (with <|think|> intact) is still used for currentMessages → Step 2.
    const step1Messages = builtMessages.map((m, i) =>
      i === 0 && m.role === 'system' && typeof m.content === 'string'
        ? { ...m, content: (m.content as string).replace(/^<\|think\|>\n/, '') }
        : m
    )

    const isThinking = payload.thinkingMode === 'thinking'

    // ── Step 1 body — structured JSON decision ────────────────────────
    // Instead of open-ended tool_calls, we force a schema-constrained JSON
    // response. LM Studio honours response_format for Gemma 4 (confirmed).
    // The model must respond with exactly {"action":"search","queries":[...]}
    // or {"action":"answer"} — no free-form output, no runaway tool call loops.
    const step1Body = {
      model:       modelId,
      messages:    [
        // Prepend a terse decision-only system message so the model understands
        // it must output JSON, not a full answer.
        {
          role:    'system',
          content: 'You are a search decision agent. Respond ONLY with valid JSON.\n' +
                   'Use {"action":"search","queries":["..."]} when ANY part of the query needs current data:\n' +
                   '- Current events, news, prices, scores, weather\n' +
                   '- Courses, tools, products, or resources available RIGHT NOW\n' +
                   '- Recommendations for things to buy, enrol in, or use today\n' +
                   '- Anything where the answer could have changed in the last 6 months\n' +
                   'Use {"action":"answer"} ONLY when the entire query is about stable knowledge:\n' +
                   '- Definitions, concepts, theory, history, math, code logic\n' +
                   'IMPORTANT: If ANY part of the query is actionable or time-sensitive, choose search.',
        },
        // Include only the last user message — no history needed for this decision.
        ...step1Messages.filter(m => m.role === 'user').slice(-1),
      ],
      temperature: 0.1,
      max_tokens:  80,
      stream:      false,
      thinking:    { type: 'disabled' },
      ...(braveEnabled ? {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name:   'search_decision',
            strict: true,
            schema: {
              type:       'object',
              properties: {
                action:  { type: 'string', enum: ['search', 'answer'] },
                queries: { type: 'array', items: { type: 'string' }, maxItems: 3 },
              },
              required:             ['action'],
              additionalProperties: false,
            },
          },
        },
      } : {}),
    }

    const startTime = Date.now()
    let firstTokenAt: number | null = null
    let totalTokens = 0
    let buffer = ''
    let searchLoopCount = 0
    const MAX_SEARCH_LOOPS = appSettings.maxSearchLoops ?? 4
    console.log(`[ChatService] Max search loops: ${MAX_SEARCH_LOOPS} (read from settings)`)

    // Repetition detector state
    let lineBuffer = ''
    let lastLine = ''
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
    const shouldAttemptSearch = braveEnabled
      && !payload.hasDocuments          // never search when RAG docs are present
      && messageNeedsSearch(userMessageText)

    try {
      // ── Step 1: Non-streaming round for tool calls (only when shouldAttemptSearch) ──
      if (shouldAttemptSearch) {
        // 4c — Step 1 payload diagnostic
        if (DEBUG) {
          console.log('[DEBUG] Step 1 body:', JSON.stringify(step1Body, null, 2))
        }
        const r1 = await net.fetch(LMS_COMPLETIONS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(step1Body),
          signal,
        } as RequestInit)

        if (!r1.ok) throw new Error(`LM Studio ${r1.status}: ${await r1.text()}`)

        const r1data = await r1.json() as {
          choices?: Array<{
            finish_reason?: string
            message?: {
              content?: string | null
              reasoning_content?: string | null
              tool_calls?: Array<{
                id: string
                type: string
                function: { name: string; arguments: string }
              }>
            }
          }>
        }

        // 4d — Step 1 response diagnostic
        if (DEBUG) {
          console.log('[DEBUG] Step 1 response:', JSON.stringify(r1data, null, 2))
        }

        const choice = r1data.choices?.[0]
        const rawDecision = choice?.message?.content ?? ''

        // Parse the structured JSON decision from response_format
        let decision: { action: string; queries?: string[] } = { action: 'answer' }
        try {
          decision = JSON.parse(rawDecision)
        } catch {
          // response_format not honoured or malformed — treat as no-search
          console.warn('[Step1] Failed to parse decision JSON, falling through to Step 2:', rawDecision.slice(0, 100))
        }

        console.log('[Step1] Decision:', JSON.stringify(decision))

        if (decision.action === 'search') {
          const queries = (decision.queries ?? [])
            .map((q: string) => q.trim())
            .filter((q: string) => q.length > 0)
            .slice(0, 3)

          if (queries.length > 0) {
            const primaryQuery = queries[0]
            const searchResultText = await executeSearchQueries(queries, resolvedKey!, send, primaryQuery)

            const syntheticId = `call_${Date.now()}`
            currentMessages = [
              ...currentMessages,
              {
                role:       'assistant',
                content:    null as unknown as string,
                tool_calls: [{ id: syntheticId, type: 'function', function: { name: 'brave_web_search', arguments: JSON.stringify({ query: primaryQuery }) } }],
              } as { role: string; content: string },
              { role: 'tool', tool_call_id: syntheticId, content: searchResultText } as { role: string; content: string },
            ]
            toolCallRound = true
          }
        }
        // action === 'answer' → fall through to Step 2 streaming with no search injected
      }

      // ── Step 2: Final streaming request ────────────────────────────
      // Always runs. currentMessages includes the tool result if a search happened.
      // If Brave is disabled, this is the only request.
      //
      // Adaptive thinking budget: when search data was injected, use a smaller
      // budget (4000) — the model has real facts and shouldn't speculate at length.
      // Without a search round, allow the full 8000 for deep reasoning.
      while (searchLoopCount < MAX_SEARCH_LOOPS) {
        const step2ThinkingField = isThinking
          ? { thinking: { type: 'enabled', budget_tokens: toolCallRound ? 4000 : 8000 } }
          : { thinking: { type: 'disabled' } }

        const streamBody = JSON.stringify({
          model: modelId,
          messages: currentMessages,
          temperature: 0.7,
          max_tokens: isThinking ? 32768 : 16384,
          stop: STOP_SEQUENCES,
          ...step2ThinkingField,
          stream: true,
        })

        const response = await net.fetch(LMS_COMPLETIONS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody,
          signal: this.controller?.signal || signal,
        } as RequestInit)

        if (!response.ok) {
          const errText = await response.text()
          throw new Error(`LM Studio ${response.status}: ${errText}`)
        }

        if (!response.body) throw new Error('LM Studio returned no response body')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()

        let loopAborted = false
        let firstChunkProcessed = false
        let streamBuffer = ''
        let toolCallIntercepted = false
        let reasoningOpen = false

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

            let parsed: {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }>
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            }
            try { parsed = JSON.parse(data) } catch { continue }

            // Capture the server-authoritative token count when LM Studio sends it.
            // This overwrites the running estimate with the real figure from the final chunk.
            if (parsed.usage?.prompt_tokens) {
              totalTokens = parsed.usage.prompt_tokens
            }

            const deltaContent = parsed.choices?.[0]?.delta?.content ?? ''
            const deltaReasoning = parsed.choices?.[0]?.delta?.reasoning_content ?? ''

            // LM Studio 0.4.9+ routes Gemma 4 thinking tokens into reasoning_content rather
            // than content. Wrap them in <think>...</think> so the existing parseThinkBlocks
            // pipeline handles them identically to Qwen3 — no other code needs to change.
            // Qwen3/GLM never emit reasoning_content, so this branch never fires for them.
            let delta = ''
            if (deltaReasoning) {
              delta = reasoningOpen ? deltaReasoning : '<think>' + deltaReasoning
              reasoningOpen = true
            } else if (deltaContent) {
              delta = reasoningOpen ? '</think>' + deltaContent : deltaContent
              reasoningOpen = false
            }

            if (!delta) continue

            // 4a — first raw SSE delta diagnostic
            if (DEBUG && !firstChunkProcessed) {
              console.log('[DEBUG] First raw SSE delta:', JSON.stringify(delta))
            }

            if (firstTokenAt === null) firstTokenAt = Date.now()

            const cleanedDelta = firstChunkProcessed
              ? delta
              : stripLeadingThinkClose(delta)
            firstChunkProcessed = true
            if (!cleanedDelta) continue

            streamBuffer += cleanedDelta

            if (!toolCallIntercepted) {
              const detected = detectMidStreamToolCall(streamBuffer)
              if (detected) {
                const { query: midQuery, cleanedBuffer: cleanedSoFar } = detected
                let patchedCleaned = cleanedSoFar
                const openCount = (patchedCleaned.match(/<think>/gi) || []).length
                const closeCount = (patchedCleaned.match(/<\/think>/gi) || []).length
                if (openCount > closeCount) {
                  patchedCleaned += '\n</think>\n'
                }

                toolCallIntercepted = true
                console.log(`[MCP] \uD83D\uDD0D Brave Search (interception depth ${searchLoopCount + 1}): "${midQuery}"`)

                this.abort()
                loopAborted = true

                // Think-flash fix: send only the text that appeared BEFORE the
                // <think> block to the renderer.  patchedCleaned (which contains
                // the partial reasoning) is still used for currentMessages so the
                // model sees its own prior reasoning in the LM Studio context.
                const thinkStart = patchedCleaned.indexOf('<think>')
                const retractedClean = thinkStart > 0
                  ? patchedCleaned.slice(0, thinkStart).trim()
                  : thinkStart === 0 ? '' : patchedCleaned

                send(IPC_CHANNELS.CHAT_STREAM_RETRACT, retractedClean)
                send(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'searching', query: midQuery })

                let midStreamResult: string
                try {
                  const results = await braveSearch(midQuery, resolvedKey!, 5)
                  midStreamResult = formatSearchResults(results)
                  send(IPC_CHANNELS.WEB_SEARCH_STATUS, {
                    phase: 'done',
                    query: midQuery,
                    resultCount: results.length,
                    results: results.map(r => ({ title: r.title, url: r.url })),
                  })
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err)
                  midStreamResult = `Web search failed: ${errMsg}. Answer from training knowledge.`
                  send(IPC_CHANNELS.WEB_SEARCH_STATUS, { phase: 'error', query: midQuery, error: errMsg })
                }

                const toolCallId = `call_${Date.now()}`
                currentMessages = [
                  ...currentMessages,
                  {
                    role: 'assistant',
                    content: patchedCleaned || (null as unknown as string),
                    tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'brave_web_search', arguments: JSON.stringify({ query: midQuery }) } }],
                  } as { role: string; content: string },
                  { role: 'tool', tool_call_id: toolCallId, content: midStreamResult } as { role: string; content: string },
                ]

                this.controller = new AbortController()

                searchLoopCount++
                toolCallRound = true
                break // Break out of `for const raw`
              }
            }

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
                      `[ChatService] \uD83D\uDD01 Repetition detected \u2014 "${completedLine}" ` +
                      `repeated ${consecutiveCount} times. Aborting stream.`
                    )
                    this.abort()
                    loopAborted = true
                    break
                  }
                } else {
                  lastLine = completedLine
                  consecutiveCount = 1
                }
              }
            }
          }
        }

        // Exit outer loop if stream finished naturally or repetition aborted it
        if (!toolCallIntercepted) {
          // 4b — full accumulated stream content diagnostic
          if (DEBUG) {
            console.log('[DEBUG] Full stream content at end (length:', streamBuffer.length, '):')
            console.log('[DEBUG]', streamBuffer.slice(0, 500))
          }
          break
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

    // Search-limit guard: if the while loop was exhausted by MAX_SEARCH_LOOPS and
    // no tokens were streamed, the model kept attempting searches without producing
    // an answer. Surface a clear error rather than letting it silently hallucinate.
    if (searchLoopCount >= MAX_SEARCH_LOOPS && totalTokens === 0) {
      console.warn('[ChatService] ⚠️  Search limit reached — model attempted search again after limit')
      send(IPC_CHANNELS.CHAT_ERROR,
        'The search tool was called multiple times without producing an answer. ' +
        'Try rephrasing your question or disabling web search in Settings → MCP & Tools.'
      )
      const stats = this.buildStats(startTime, firstTokenAt, 0, true)
      send(IPC_CHANNELS.CHAT_STREAM_END, stats)
      return
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
    // Strip Qwen3-style <think>…</think> blocks
    const open = '<think>'
    const close = '</think>'
    let result = content
    const start = result.indexOf(open)
    if (start !== -1) {
      const end = result.lastIndexOf(close)
      if (end === -1) result = result.slice(0, start).trim()
      else result = (result.slice(0, start) + result.slice(end + close.length)).trim()
    }

    // Strip Gemma 4-style <|channel>thought\n…<channel|> blocks
    const gOpen = '<|channel>thought\n'
    const gClose = '<channel|>'
    const gStart = result.indexOf(gOpen)
    if (gStart !== -1) {
      const gEnd = result.lastIndexOf(gClose)
      if (gEnd === -1) result = result.slice(0, gStart).trim()
      else result = (result.slice(0, gStart) + result.slice(gEnd + gClose.length)).trim()
    }

    return result
  }

  private cleanAssistantHistory(content: string): string {
    // Strips any [System Note: ...] prefixes injected by orchestration loops
    return content.replace(/\[System Note:[\s\S]*?\]/gi, '').trim()
  }

  // LM Studio vision content part shapes
  private buildMessages(
    payload: ChatSendPayload
  ): Array<{ role: string; content: string | ContentPart[] }> {
    const msgs: Array<{ role: string; content: string | ContentPart[] }> = []

    // ── System prompt: explicit + document injections ────────────
    // Read brave settings so we can inject the correct web-search addendum
    const appSettings = readSettings()
    const resolvedKey = resolveBraveApiKey()
    const braveEnabled = !!(appSettings.braveSearchEnabled && resolvedKey)

    // Inject current date so models use the right year in search queries and
    // time-sensitive reasoning — training cutoff is no longer the reference.
    const _now = new Date()
    const DATE_INJECTION = `Current date and time: ${_now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })}, ${_now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}.`

    const systemParts: string[] = [BASE_SYSTEM_PROMPT, DATE_INJECTION]
    if (braveEnabled) systemParts.push(WEB_SEARCH_SYSTEM_ADDENDUM)
    if (!braveEnabled) systemParts.push(WEB_SEARCH_DISABLED_ADDENDUM)
    if (payload.systemPrompt) systemParts.push(payload.systemPrompt)

    // Gemma 4 thinking activation — Gemma does not support the `thinking:{type}`
    // payload field; instead it is activated by a <|think|> prefix in the system
    // prompt.  Detection is by model name (only route that is reliable here since
    // we don't yet have content to inspect).
    if (payload.thinkingMode === 'thinking' && payload.model?.toLowerCase().includes('gemma')) {
      systemParts[0] = '<|think|>\n' + systemParts[0]
    }

    if (systemParts.length > 0) {
      msgs.push({ role: 'system', content: systemParts.join('\n\n') })
    }

    // ── Token-budget trim ─────────────────────────────────────────
    // Replaces the old HISTORY_WINDOW = 20 message-count heuristic.
    //
    // Budget = context_window - max_output_tokens - system_tokens - overhead
    //
    // We walk messages newest→oldest, accumulate token estimates, and drop
    // messages that would push us over budget.  This guarantees the payload
    // always fits regardless of individual message sizes (e.g. long answers,
    // large code blocks, or matplotlib responses).
    const isThinkingMode = payload.thinkingMode === 'thinking'
    const maxOutputTokens = isThinkingMode ? 32768 : 16384
    const contextLength = appSettings.contextLength ?? 32768
    const systemTokenCount = countTokens(systemParts.join('\n\n'))
    const OVERHEAD = 512  // role formatting, stop tokens, misc.
    const historyBudget = Math.max(2000, contextLength - maxOutputTokens - systemTokenCount - OVERHEAD)

    const allMsgs = payload.messages.filter((m) => (m.role as string) !== 'divider')

    // Stub matplotlib code in old turns (beyond the 2 most recent pairs).
    // The code itself is not needed by the model on the next turn; the stub
    // caption preserves conversational context at a fraction of the token cost.
    const RECENT_PAIRS = 2
    const recentBoundary = Math.max(0, allMsgs.length - RECENT_PAIRS * 2)

    const lastUserIdx = allMsgs.map(m => m.role).lastIndexOf('user')
    const lastAssistantIdx = allMsgs.map(m => m.role).lastIndexOf('assistant')

    const processedMsgs = allMsgs.map((m, i) => {
      if (m.role === 'tool' && i < lastUserIdx) {
        return { ...m, content: '[Previous Search Results for query]' }
      }

      // Topic-anchoring fix: truncate assistant messages from previous search turns.
      // Step 1 runs with thinking:disabled and temperature:0.1 — it anchors heavily
      // to the most prominent text in context.  A 400–700 token MSFT analysis sitting
      // just before the new question causes the model to generate a tool call for the
      // old topic rather than the new one.  We keep only the first 150 chars as a
      // coherence stub; the full content of the MOST RECENT assistant message is
      // preserved so the model has its latest answer for context.
      const wm = m as unknown as WireMessage
      if (
        m.role === 'assistant' &&
        wm.tool_calls &&
        wm.tool_calls.length > 0 &&
        i < lastAssistantIdx
      ) {
        const contentStr = typeof m.content === 'string' ? m.content : ''
        const stub = contentStr.length > 150
          ? contentStr.slice(0, 150).trimEnd() + '… [previous answer truncated]'
          : contentStr
        return { ...m, content: stub }
      }

      if (m.role !== 'assistant') return m

      const stripped = this.cleanAssistantHistory(this.stripThinkBlocks(m.content as string))
      const content = i < recentBoundary ? stubMatplotlibBlocks(stripped) : stripped
      return { ...m, content: content || '' }
    })

    // Walk newest→oldest, keep messages within the budget.
    let tokenSum = 0
    const kept: typeof processedMsgs = []
    for (let i = processedMsgs.length - 1; i >= 0; i--) {
      const m = processedMsgs[i]
      const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const t = countTokens(contentStr) + 4  // +4 per-message role overhead
      if (tokenSum + t > historyBudget && kept.length > 0) {
        console.log(
          `[ChatService] ✂️ Budget trim: dropped messages 0–${i} ` +
          `(budget=${historyBudget}, accumulated=${tokenSum}, ctx=${contextLength})`
        )
        break
      }
      tokenSum += t
      kept.unshift(m)
    }

    // ── Image attachments go on the last user message ────────────
    const images = (payload.attachments ?? []).filter((a) => a.kind === 'image' && a.dataUrl)
    const lastIdx = kept.length - 1

    for (let i = 0; i < kept.length; i++) {
      const m = kept[i]
      const wm = m as unknown as WireMessage

      if (images.length > 0 && m.role === 'user' && i === lastIdx) {
        // Vision message — build multipart content, but still preserve any
        // tool_calls / tool_call_id that might be on this message.
        const parts: ContentPart[] = [{ type: 'text', text: m.content as string }]
        for (const img of images) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl! } })
        }
        const wireMsg: Record<string, unknown> = { role: m.role, content: parts }
        if (wm.tool_calls) wireMsg.tool_calls = wm.tool_calls
        if (wm.tool_call_id) wireMsg.tool_call_id = wm.tool_call_id
        msgs.push(wireMsg as { role: string; content: string | ContentPart[] })
      } else {
        // Standard message — preserve tool_calls and tool_call_id so LM Studio
        // sees a valid assistant→tool message pair.  Plain destructuring
        // ({ role, content }) silently drops these fields, producing an
        // invalid tool message whose tool_call_id references a non-existent
        // tool_calls entry on the preceding assistant message.
        const wireMsg: Record<string, unknown> = { role: m.role, content: m.content }
        if (wm.tool_calls) wireMsg.tool_calls = wm.tool_calls
        if (wm.tool_call_id) wireMsg.tool_call_id = wm.tool_call_id
        msgs.push(wireMsg as { role: string; content: string | ContentPart[] })
      }
    }

    return msgs
  }

  private buildStats(
    startTime: number,
    firstTokenAt: number | null,
    totalTokens: number,
    aborted: boolean
  ): GenerationStats {
    const totalMs = Date.now() - startTime
    const ttft = firstTokenAt !== null ? firstTokenAt - startTime : totalMs
    const elapsed = Math.max(totalMs / 1000, 0.001)

    return {
      ttft,
      tokensPerSec: Math.round((totalTokens / elapsed) * 10) / 10,
      totalMs,
      totalTokens,
      promptTokens: totalTokens,   // server figure when available (usage.prompt_tokens overwrites estimate)
      aborted,
    }
  }
}

export const chatService = new ChatService()
