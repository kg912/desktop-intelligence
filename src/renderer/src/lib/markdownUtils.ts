/**
 * markdownUtils — pure string-manipulation helpers for the chat renderer
 *
 * Kept free of React, DOM, and Electron imports so they can be unit-tested
 * in a plain Node environment with Vitest.
 */

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
 * Three cases:
 *  1. Fully closed:   `<think>…</think>answer`  → thought + answer, isThinking=false
 *  2. Still open:     `<think>partial thought`   → thought so far, answer='', isThinking=true
 *  3. No think tags:  `plain response`            → thought='', answer=raw, isThinking=false
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
 */
export function parseThinkBlocks(raw: string): ParsedContent {
  const OPEN  = '<think>'
  const CLOSE = '</think>'

  const openIdx  = raw.indexOf(OPEN)
  const closeIdx = raw.lastIndexOf(CLOSE)   // ← LAST occurrence, not first

  // Case 1 — fully closed block (both tags present, open comes before close)
  if (openIdx !== -1 && closeIdx !== -1 && openIdx < closeIdx) {
    const thought = raw.slice(openIdx + OPEN.length, closeIdx).trim()
    // Strip leading whitespace from the answer (newline after </think> is common)
    const answer  = raw.slice(closeIdx + CLOSE.length).replace(/^\s*/, '')
    return { thought, answer, isThinking: false }
  }

  // Case 2 — block still open (streaming the thought right now)
  if (openIdx !== -1) {
    return { thought: raw.slice(openIdx + OPEN.length), answer: '', isThinking: true }
  }

  // Case 3 — no think tags — plain response
  return { thought: '', answer: raw, isThinking: false }
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
export type CodeBlockKind = 'inline' | 'mermaid' | 'echarts' | 'matplotlib' | 'code'

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
