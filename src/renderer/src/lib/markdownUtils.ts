/**
 * markdownUtils — pure string-manipulation helpers for the chat renderer
 *
 * Kept free of React, DOM, and Electron imports so they can be unit-tested
 * in a plain Node environment with Vitest.
 */

const DEBUG = (import.meta as Record<string, unknown> & { env?: { DEV_MODE?: boolean } }).env?.DEV_MODE === true

// ----------------------------------------------------------------
// <think> tag parser
// ----------------------------------------------------------------
export interface ParsedContent {
  thought:    string   // text inside <think>
  answer:     string   // text after </think>
  isThinking: boolean  // true while <think> is still open (streaming)
}

/**
 * parseThinkBlocks
 *
 * Parses a raw model response string that may contain a Qwen3-style
 * `<think>…</think>` reasoning block.
 *
 * Four cases:
 *  1. Fully closed:        `<think>…</think>answer`  → thought + answer, isThinking=false
 *  2. Still open, streaming: `<think>partial`         → thought so far, answer='', isThinking=true
 *  3. Still open, stream ENDED: think block truncated by max_tokens — surface
 *     the thought content as the answer so the user sees something, not blank.
 *  4. No think tags:       `plain response`            → thought='', answer=raw, isThinking=false
 *
 * IMPORTANT — uses lastIndexOf, not a regex with non-greedy matching.
 *
 * Qwen models frequently mention `</think>` *inside their own thought* while
 * reasoning about how to format the response (e.g. "The format is:
 * <think>…</think>answer"). A non-greedy regex would split at the FIRST
 * occurrence, causing the remainder of the thought to leak into the answer
 * area and the real closing tag to appear as literal rendered text.
 *
 * Using lastIndexOf ensures we always split at the LAST `</think>` in the
 * output, which is the actual end-of-thought marker the model emitted.
 *
 * @param raw         Raw model output string
 * @param streamEnded Pass true when streaming has finished — enables truncated
 *                    think-block recovery (Case 3)
 */
/**
 * cleanAnswerEcho
 *
 * Qwen3-series models sometimes put their ENTIRE response (reasoning + draft answer)
 * inside <think> and then repeat the same content verbatim after </think>.
 * parseThinkBlocks faithfully returns thought=P1+P2, answer=P1+P2, so:
 *   • The accordion shows both the reasoning (P1) AND the answer draft (P2)
 *   • The chat shows the full repeated content including P1 (the internal reasoning)
 *
 * This function detects that pattern and strips the internal-monologue paragraphs (P1)
 * from the start of rawAnswer, leaving only the user-facing answer (P2).
 *
 * TRIGGER: thought and rawAnswer must share the same first ≥80 characters.
 *   • This fires  for the echo pattern: both start with "The user is asking…"
 *   • This is SAFE for normal Qwen3 (reasoning ≠ answer prefix — no common start)
 *   • This is SAFE for Agentic AI / search drafts where answer starts differently
 *     from the numbered-list reasoning in thought
 *
 * After the trigger, internal-monologue paragraphs are removed from the answer start.
 * A paragraph is "internal monologue" if it begins with a first-person or meta-commentary
 * pattern showing the model talking to itself rather than the user.
 */
const IMO_PATTERNS: RegExp[] = [
  /^The user (is|was|has been|asked|wants)\b/i,
  /^I (found|should|will|need|can see|have|am going|notice|think|believe|want)\b/i,
  /^Since the current date\b/i,
  /^However,? since\b/i,
  /^Let me (analyze|think|check|look|synthesize|consider|pull|gather)\b/i,
  /^Based on (?:the|my|this|these) (?:search results?|context|information|analysis),? I\b/i,
  /^Looking at (?:the|this|these)\b/i,
  /^After (?:analyzing|reviewing|checking)\b/i,
]

function cleanAnswerEcho(rawAnswer: string, thought: string): string {
  if (!rawAnswer || !thought) return rawAnswer

  // Gate: only act when thought starts with the same first PROBE chars as rawAnswer.
  // Using startsWith (not includes) is crucial — it prevents false-positives when the
  // answer text merely appears somewhere *within* a longer thought.
  const PROBE = 80
  const probe = rawAnswer.trimStart().slice(0, PROBE)
  if (probe.length < PROBE) return rawAnswer                 // answer too short to be sure
  if (!thought.trimStart().startsWith(probe)) return rawAnswer  // no echo — bail fast

  // Echo detected. Strip leading internal-monologue paragraphs from rawAnswer.
  const paras = rawAnswer.trimStart().split(/\n\n+/)
  let firstUserPara = 0
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i].trim()
    if (p === '' || IMO_PATTERNS.some(rx => rx.test(p))) {
      firstUserPara = i + 1
    } else {
      break
    }
  }

  if (firstUserPara === 0 || firstUserPara >= paras.length) return rawAnswer
  const clean = paras.slice(firstUserPara).join('\n\n').trimStart()
  return clean.length >= 20 ? clean : rawAnswer
}

export function parseThinkBlocks(raw: string, streamEnded = false): ParsedContent {
  if (DEBUG) {
    console.log('[DEBUG parseThinkBlocks] input len:', raw.length,
      '| hasOpen:', raw.includes('<think>'),
      '| hasClose:', raw.includes('</think>'),
      '| lastCloseIdx:', raw.lastIndexOf('</think>'),
      '| streamEnded:', streamEnded)
  }

  // ── Gemma 4 channel-block format detection ─────────────────────────────────
  // Gemma 4 uses <|channel>thought\n…<channel|> instead of <think>…</think>.
  // Detection is purely content-based — no model-name check required.
  const GEMMA_OPEN  = '<|channel>thought\n'
  const GEMMA_CLOSE = '<channel|>'

  if (raw.includes(GEMMA_OPEN)) {
    const gOpenIdx  = raw.indexOf(GEMMA_OPEN)
    const gCloseIdx = raw.lastIndexOf(GEMMA_CLOSE)

    // Case 1 — fully closed Gemma block
    if (gCloseIdx !== -1 && gOpenIdx < gCloseIdx) {
      const thought   = raw.slice(gOpenIdx + GEMMA_OPEN.length, gCloseIdx).trim()
      const rawAnswer = raw.slice(gCloseIdx + GEMMA_CLOSE.length).replace(/^\s*/, '')
      // Empty-block guard — thinking was disabled; don't show an empty accordion
      if (!thought) return { thought: '', answer: rawAnswer, isThinking: false }
      const answer = cleanAnswerEcho(rawAnswer, thought)
      return { thought, answer, isThinking: false }
    }

    // Case 2 — block still open AND streaming in progress
    if (!streamEnded) {
      return { thought: raw.slice(gOpenIdx + GEMMA_OPEN.length), answer: '', isThinking: true }
    }

    // Case 3 — block still open but stream ENDED (truncated by max_tokens)
    const thought = raw.slice(gOpenIdx + GEMMA_OPEN.length).trim()
    return { thought, answer: thought, isThinking: false }
  }

  // ── Qwen3-style <think>…</think> ───────────────────────────────────────────
  const OPEN  = '<think>'
  const CLOSE = '</think>'

  const openIdx  = raw.indexOf(OPEN)
  const closeIdx = raw.lastIndexOf(CLOSE)   // ← LAST occurrence, not first

  // Case 1 — fully closed block (both tags present, open comes before close)
  if (openIdx !== -1 && closeIdx !== -1 && openIdx < closeIdx) {
    const thought = raw.slice(openIdx + OPEN.length, closeIdx).trim()
    // Strip leading whitespace from the answer (newline after </think> is common)
    const rawAnswer = raw.slice(closeIdx + CLOSE.length).replace(/^\s*/, '')
    // Remove internal-monologue echo paragraphs the model repeated after </think>
    const answer = cleanAnswerEcho(rawAnswer, thought)
    if (DEBUG) console.log('[DEBUG parseThinkBlocks] Case 1 (closed): thoughtLen=', thought.length, 'answerLen=', answer.length)
    return { thought, answer, isThinking: false }
  }

  // Case 2 — block still open AND streaming is still in progress
  if (openIdx !== -1 && !streamEnded) {
    if (DEBUG) console.log('[DEBUG parseThinkBlocks] Case 2 (open+streaming): thoughtLen=', raw.slice(openIdx + OPEN.length).length)
    return { thought: raw.slice(openIdx + OPEN.length), answer: '', isThinking: true }
  }

  // Case 3 — block still open but stream has ENDED (think block truncated by max_tokens)
  // Surface the thought content as the answer so the user sees something, not a blank card.
  if (openIdx !== -1 && streamEnded) {
    const thought = raw.slice(openIdx + OPEN.length).trim()
    if (DEBUG) console.log('[DEBUG parseThinkBlocks] Case 3 (open+ended): thoughtLen=', thought.length)
    return { thought, answer: thought, isThinking: false }
  }

  // Case 4 — no think tags — plain response
  if (DEBUG) console.log('[DEBUG parseThinkBlocks] Case 4 (plain): answerLen=', raw.length)
  return { thought: '', answer: raw, isThinking: false }
}


// ----------------------------------------------------------------
// Currency dollar pre-escaper
// ----------------------------------------------------------------

/**
 * escapeCurrencyDollars
 *
 * Replaces `$` signs that introduce a currency amount (i.e. immediately
 * followed by a digit) with `\$` so remark-math ignores them. This lets
 * `singleDollarTextMath` remain enabled while preventing price strings
 * like `$164.65`, `$1,200`, and `$0.99` from being fed to KaTeX.
 *
 * Math expressions such as `$K$`, `$\pi_k$`, and `$\mathbf{x}$` are
 * unaffected because they start with a letter or backslash, not a digit.
 *
 * Pure function — safe to call in a React useMemo.
 */
export function escapeCurrencyDollars(md: string): string {
  return md
    // \$(?=\d) — dollar sign whose next char is a digit
    .replace(/\$(?=\d)/g, '\\$')
    // Ensure $$ display blocks are preceded by a newline when inline with text.
    // Only fires when a space/tab immediately precedes $$ (distinguishes text
    // separator from math content chars like digits/letters before closing $$).
    // Note: $$$$ in replacement string = literal $$ (each $$ → single $).
    .replace(/([ \t])\$\$/g, '$1\n$$$$')
    // Ensure $$ display blocks are followed by a newline when inline with text.
    .replace(/\$\$([ \t])/g, '$$$$\n$1')
}

// ----------------------------------------------------------------
// Code-block classifier
// ----------------------------------------------------------------

/**
 * CodeBlockKind
 *
 * Determines how the renderer should display a fenced code block:
 *  - 'inline'   → no language tag; render as a plain `<code>` span
 *  - 'mermaid'  → diagram syntax; hand off to the Mermaid SVG renderer
 *  - 'echarts'  → ECharts JSON option object; rendered as an interactive plot
 *  - 'matplotlib' → Python matplotlib script; executed server-side, result shown as PNG image
 *  - 'code'       → everything else; syntax-highlight with highlight.js
 */
export type CodeBlockKind = 'inline' | 'mermaid' | 'echarts' | 'matplotlib' | 'svg' | 'code'

/**
 * classifyCodeBlock
 *
 * Pure function — takes the language string extracted from a markdown fence
 * (e.g. "python", "mermaid", "echarts", undefined) and returns the rendering
 * strategy.
 *
 * Case-insensitive for the language name so `Mermaid` and `MERMAID` both work.
 * `plot` is accepted as an alias for `echarts` so the model can write either.
 */
export function classifyCodeBlock(lang: string | undefined): CodeBlockKind {
  if (!lang) return 'inline'
  const lower = lang.toLowerCase()
  if (lower === 'mermaid') return 'mermaid'
  if (lower === 'echarts' || lower === 'plot') return 'echarts'
  if (lower === 'matplotlib') return 'matplotlib'
  if (lower === 'svg') return 'svg'
  return 'code'
}

// ----------------------------------------------------------------
// Mermaid diagram validator
// ----------------------------------------------------------------

/**
 * MERMAID_START_KEYWORDS
 *
 * The canonical set of top-level Mermaid diagram type declarations.
 * Used to validate that a fenced ```mermaid block actually contains
 * valid-looking Mermaid syntax before handing it to the renderer,
 * preventing a cryptic mermaid.js error from appearing in the UI.
 *
 * Reference: https://mermaid.js.org/intro/
 */
export const MERMAID_START_KEYWORDS = [
  'graph',
  'flowchart',
  'sequencediagram',
  'classDiagram',
  'statediagram',
  'statediagram-v2',
  'erdiagram',
  'gantt',
  'pie',
  'requirementdiagram',
  'gitgraph',
  'mindmap',
  'timeline',
  'quadrantchart',
  'xychart-beta',
  'sankey-beta',
  'block-beta',
  'architecture-beta',
  'journey',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
] as const

/**
 * isValidMermaidSyntax
 *
 * Returns true if the trimmed first line of a code block starts with a
 * recognised Mermaid diagram type keyword (case-insensitive).
 * Returns false for empty strings or unrecognised syntax — in that case
 * the renderer should fall back to a plain text code block.
 */
export function isValidMermaidSyntax(code: string): boolean {
  const firstLine = code.trim().split('\n')[0].trim().toLowerCase()
  if (!firstLine) return false
  return MERMAID_START_KEYWORDS.some((kw) => firstLine.startsWith(kw.toLowerCase()))
}

// ----------------------------------------------------------------
// User content preprocessor
// ----------------------------------------------------------------

/**
 * prepareUserContent
 *
 * Transforms a raw textarea string before it reaches ReactMarkdown in the
 * user bubble.  Single newlines typed via Shift+Enter are converted to
 * CommonMark hard line breaks (two trailing spaces before \n) so they
 * render as <br> instead of collapsing into a single paragraph.
 *
 * Fenced code blocks (``` … ```) are detected and their content is left
 * completely untouched — remark parses fences AFTER hard-break processing,
 * so modifying fence lines would break code block detection.
 */
export function prepareUserContent(raw: string): string {
  if (!raw) return raw
  const lines = raw.split('\n')
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    if (/^\s*`{3,}/.test(line)) {
      if (!inFence) {
        // Opening fence: inject a blank line before it so CommonMark
        // recognises it as a block-level fence, not a paragraph continuation.
        out.push('')
      }
      inFence = !inFence
      out.push(line)  // fence delimiter — never add trailing spaces
      continue
    }
    if (inFence) {
      out.push(line)  // inside fence — never modify
      continue
    }
    // Outside fence: append two spaces for CommonMark hard line break
    out.push(line.endsWith('  ') ? line : line + '  ')
  }
  return out.join('\n')
}
