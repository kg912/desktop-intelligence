/**
 * RagChunker — pure chunking functions for RAG v2.
 *
 * No DB, no Electron, no service imports.
 * Every function here is independently unit-testable.
 */

// ── Exported constants ────────────────────────────────────────────────────────

/** Target token count for each chunk (±15% tolerance, except final chunk). */
export const CHUNK_TOKENS = 400

/** Overlap between consecutive chunks in tokens (carried into the next chunk's start). */
export const CHUNK_OVERLAP_TOKENS = 60

// ── Internal constants ────────────────────────────────────────────────────────

/** Average chars/token for English prose with cl100k_base. Used only for position estimates. */
const AVG_CHARS_PER_TOKEN = 3.5

/** Estimated character width of one target chunk. */
const TARGET_CHARS = Math.floor(CHUNK_TOKENS * AVG_CHARS_PER_TOKEN)   // 1400

/** Estimated character width of the overlap region. */
const OVERLAP_CHARS = Math.floor(CHUNK_OVERLAP_TOKENS * AVG_CHARS_PER_TOKEN) // 210

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  content:      string
  chunkIndex:   number
  charStart:    number
  charEnd:      number
  sectionTitle: string | null
}

// ── Heading detection ─────────────────────────────────────────────────────────

const MARKDOWN_HEADING_RE = /^#{1,6}\s+(.+)$/
/** Numbered heading: "1.", "2.3)", "4.1.2." etc., short line (≤80 chars), has content after whitespace. */
const NUMBERED_HEADING_RE = /^\d+(\.\d+)*[.)]\s+\S/

interface HeadingEntry {
  charPos: number
  title:   string
}

function extractHeadings(text: string): HeadingEntry[] {
  const headings: HeadingEntry[] = []
  let pos = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const mdMatch = MARKDOWN_HEADING_RE.exec(line)
    if (mdMatch) {
      headings.push({ charPos: pos, title: mdMatch[1].trim() })
    } else if (line.length <= 80 && NUMBERED_HEADING_RE.test(line)) {
      headings.push({ charPos: pos, title: line.trim() })
    }
    pos += line.length + 1  // +1 for the '\n' separator
  }
  return headings
}

/** Return the nearest heading that starts at or before `charPos`, or null. */
function getSectionTitle(headings: HeadingEntry[], charPos: number): string | null {
  let title: string | null = null
  for (const h of headings) {
    if (h.charPos <= charPos) title = h.title
    else break
  }
  return title
}

// ── Safe character position (no broken surrogate pairs) ───────────────────────

/**
 * Adjust `pos` backwards by one code unit if it would split a surrogate pair.
 * Handles emoji (U+1F000+) and other supplementary characters encoded as UTF-16
 * surrogate pairs in JavaScript strings.
 */
function safePos(text: string, pos: number): number {
  if (pos <= 0) return 0
  if (pos >= text.length) return text.length
  // High surrogate at pos-1 followed by low surrogate at pos → would split the pair
  const code = text.charCodeAt(pos - 1)
  if (code >= 0xD800 && code <= 0xDBFF) return pos - 1
  return pos
}

// ── Split point search ────────────────────────────────────────────────────────

/**
 * Find the best position to end a chunk, targeting approximately `TARGET_CHARS`
 * beyond `start`, preferring (in order):
 *   1. Paragraph boundary (\n\n)
 *   2. Single newline
 *   3. Sentence boundary ([.!?] followed by whitespace)
 *   4. Word boundary (whitespace)
 *   5. Hard cut (safe surrogate position)
 *
 * The search window is ±`WINDOW_RATIO` of `TARGET_CHARS` around the target position.
 */
const WINDOW_RATIO = 0.20   // 20% of TARGET_CHARS on each side

function findChunkEnd(text: string, start: number): number {
  const remaining = text.length - start
  if (remaining === 0) return text.length

  // Fast char-based "last chunk" check — avoids expensive countTokens on large text.
  // TARGET_CHARS is based on 3.5 chars/token (English prose average).
  // For the last chunk, include everything if the remainder fits in one chunk;
  // "fits" here means remaining ≤ TARGET_CHARS × 1.15 (allows up to +15% oversize).
  if (remaining <= Math.floor(TARGET_CHARS * 1.15)) return text.length

  const targetPos = start + TARGET_CHARS
  const window    = Math.max(80, Math.floor(TARGET_CHARS * WINDOW_RATIO))
  const from      = Math.max(start + 1, targetPos - window)
  const to        = Math.min(text.length, targetPos + window)

  // 1. Paragraph boundary (last \n\n in window)
  const ppIdx = text.lastIndexOf('\n\n', to)
  if (ppIdx >= from) return safePos(text, ppIdx + 2)

  // 2. Newline
  const nlIdx = text.lastIndexOf('\n', to)
  if (nlIdx >= from) return safePos(text, nlIdx + 1)

  // 3. Sentence boundary — search backward from `to`
  for (let i = Math.min(to, text.length - 1); i >= from; i--) {
    const c = text[i - 1]
    if ((c === '.' || c === '!' || c === '?') && i < text.length && /[ \t\n\r]/.test(text[i])) {
      return safePos(text, i + 1)
    }
  }

  // 4. Word boundary
  for (let i = Math.min(to, text.length - 1); i >= from; i--) {
    if (/[ \t]/.test(text[i - 1])) return safePos(text, i)
  }

  // 5. Hard cut
  return safePos(text, Math.min(targetPos, text.length))
}

/**
 * Find the start position for the next chunk, providing approximately
 * `OVERLAP_CHARS` of overlap with the previous chunk.
 * Aligns to a word boundary by skipping forward past any partial word.
 */
function findNextStart(text: string, prevEnd: number): number {
  const rawStart = Math.max(0, prevEnd - OVERLAP_CHARS)
  if (rawStart === 0) return 0

  let pos = rawStart
  // If rawStart is inside a word, advance to the start of the next word
  while (pos < prevEnd && pos < text.length && !/[\s]/.test(text[pos])) {
    pos++
  }
  // Skip leading whitespace
  while (pos < prevEnd && pos < text.length && /[\s]/.test(text[pos])) {
    pos++
  }

  // Fallback: if we went too far, use the raw start (surrogate-safe)
  if (pos >= prevEnd) return safePos(text, rawStart)
  return safePos(text, pos)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Split `text` into overlapping chunks of approximately CHUNK_TOKENS tokens,
 * aligned to paragraph / sentence / word boundaries.
 *
 * Properties:
 * - Returns [] for empty or whitespace-only input.
 * - Never throws on pathological input (dense text with no whitespace, emoji, CJK).
 * - Chunk sizes land within ±15% of CHUNK_TOKENS for normal prose.
 * - Each chunk after the first begins with approximately CHUNK_OVERLAP_TOKENS
 *   worth of text from the end of the previous chunk.
 * - sectionTitle carries the nearest preceding markdown or numbered heading.
 */
export function chunk(text: string): ChunkResult[] {
  if (!text || text.trim().length === 0) return []

  const headings = extractHeadings(text)
  const results: ChunkResult[] = []
  let pos = 0

  while (pos < text.length) {
    const endPos = findChunkEnd(text, pos)

    // Safety: ensure we always advance at least one character to prevent infinite loops
    const actualEnd = endPos > pos
      ? endPos
      : safePos(text, Math.min(pos + TARGET_CHARS, text.length))

    const rawContent = text.slice(pos, actualEnd)
    const content    = rawContent.trim()

    if (content) {
      results.push({
        content,
        chunkIndex:   results.length,
        charStart:    pos,
        charEnd:      actualEnd,
        sectionTitle: getSectionTitle(headings, pos),
      })
    }

    if (actualEnd >= text.length) break

    const nextPos = findNextStart(text, actualEnd)
    // Safety: always move forward
    pos = nextPos > pos ? nextPos : actualEnd
  }

  return results
}
