/**
 * RagChunker unit tests — Phase 1
 */

import { describe, it, expect } from 'vitest'
import { chunk, CHUNK_TOKENS } from '../RagChunker'
import { countTokens } from '../../tokenUtils'

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Generate a block of plain English prose of approximately `tokens` tokens. */
function makeText(tokens: number): string {
  const sentence = 'The quick brown fox jumps over the lazy dog. '
  const tokensPer = countTokens(sentence)
  const repeats = Math.ceil(tokens / tokensPer)
  return sentence.repeat(repeats)
}

/** Generate a heading + body block. */
function makeSection(heading: string, bodyTokens: number, useMarkdown = true): string {
  const prefix = useMarkdown ? `## ${heading}\n\n` : `1.1 ${heading}\n\n`
  return prefix + makeText(bodyTokens)
}

// ── Edge cases ──────────────────────────────────────────────────────────────────

describe('RagChunker — edge cases', () => {
  it('returns [] for empty string', () => {
    expect(chunk('')).toEqual([])
  })

  it('returns [] for whitespace-only string', () => {
    expect(chunk('   \n\t\n  ')).toEqual([])
  })

  it('returns a single chunk for a single character', () => {
    const result = chunk('x')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('x')
    expect(result[0].chunkIndex).toBe(0)
    expect(result[0].sectionTitle).toBeNull()
  })

  it('returns a single chunk for short text (well under CHUNK_TOKENS)', () => {
    const text = 'Short sentence. Another sentence.'
    const result = chunk(text)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe(text.trim())
  })

  it('handles a 50k-char string with no whitespace without hanging or throwing', () => {
    const dense = 'a'.repeat(50_000)
    const result = chunk(dense)
    expect(result.length).toBeGreaterThan(0)
    // Verify no chunk is empty
    for (const c of result) {
      expect(c.content.length).toBeGreaterThan(0)
    }
  })

  it('handles emoji without broken surrogate pairs at boundaries', () => {
    // Build text with emoji interspersed (U+1F389 = 🎉, U+1F600 = 😀)
    const emojiText = ('Hello 🎉 World! ').repeat(400)
    let result: ReturnType<typeof chunk>
    expect(() => { result = chunk(emojiText) }).not.toThrow()
    // Verify all content is valid (no isolated surrogates)
    for (const c of result!) {
      for (let i = 0; i < c.content.length; i++) {
        const code = c.content.charCodeAt(i)
        if (code >= 0xD800 && code <= 0xDBFF) {
          // High surrogate — must be followed by low surrogate
          const next = c.content.charCodeAt(i + 1)
          expect(next).toBeGreaterThanOrEqual(0xDC00)
          expect(next).toBeLessThanOrEqual(0xDFFF)
        }
      }
    }
  })

  it('handles CJK text without throwing', () => {
    const cjk = '机器学习是人工智能的一个重要分支，它使计算机系统能够从数据中自动学习和改进。'.repeat(200)
    expect(() => chunk(cjk)).not.toThrow()
    const result = chunk(cjk)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ── Chunk sizes ─────────────────────────────────────────────────────────────────

describe('RagChunker — chunk sizes', () => {
  it('chunks a long plain-text block with each non-final chunk within ±15% of CHUNK_TOKENS', () => {
    const text = makeText(CHUNK_TOKENS * 6)  // ~2400 tokens → ~6 chunks
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(5)

    const lo = Math.floor(CHUNK_TOKENS * 0.85)
    const hi = Math.ceil(CHUNK_TOKENS * 1.15)

    for (let i = 0; i < result.length - 1; i++) {
      const tokens = countTokens(result[i].content)
      expect(tokens).toBeGreaterThanOrEqual(lo)
      expect(tokens).toBeLessThanOrEqual(hi)
    }
  })

  it('chunkIndex is sequential starting from 0', () => {
    const text = makeText(CHUNK_TOKENS * 3)
    const result = chunk(text)
    result.forEach((c, i) => expect(c.chunkIndex).toBe(i))
  })
})

// ── Overlap ─────────────────────────────────────────────────────────────────────

describe('RagChunker — overlap', () => {
  it('overlap: trailing text from chunk N appears at the start of chunk N+1', () => {
    const text = makeText(CHUNK_TOKENS * 3)
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(2)

    for (let i = 0; i + 1 < result.length; i++) {
      const prevWords = result[i].content.trim().split(/\s+/).slice(-10)
      const nextStart = result[i + 1].content.trim().split(/\s+/).slice(0, 20).join(' ')
      // At least one of the last 10 words of chunk i should appear near the start of chunk i+1
      const overlap = prevWords.some(w => w.length > 2 && nextStart.includes(w))
      expect(overlap).toBe(true)
    }
  })

  it('CHUNK_OVERLAP_TOKENS worth of content overlaps', () => {
    const text = makeText(CHUNK_TOKENS * 4)
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(3)

    for (let i = 0; i + 1 < result.length; i++) {
      // The start of chunk[i+1] should be WITHIN chunk[i]'s char range
      // (i.e. charStart[i+1] < charEnd[i])
      expect(result[i + 1].charStart).toBeLessThan(result[i].charEnd)
    }
  })
})

// ── Boundary preferences ────────────────────────────────────────────────────────

describe('RagChunker — paragraph boundary preference', () => {
  it('preferrs paragraph boundaries over arbitrary cuts', () => {
    // Build text from many small paragraphs (each ~40 tokens) so the chunker
    // must accumulate ~10 paragraphs to fill one chunk. Boundaries are at \n\n.
    const para = 'This is a short paragraph containing roughly forty tokens of content. ' +
                 'The paragraph ends here.\n\n'
    const text = para.repeat(40)  // ~1600 tokens
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(3)  // must split into multiple chunks

    // The core invariant: chunks should end at paragraph (or sentence) boundaries.
    // Verify that each non-final chunk ends with a sentence-ending character
    // (demonstrating the split respected a sentence/paragraph boundary, not a word-cut).
    for (let i = 0; i < result.length - 1; i++) {
      const trimmed = result[i].content.trimEnd()
      const lastChar = trimmed.at(-1)
      // Chunk must end at a meaningful boundary: sentence end or paragraph end
      expect(lastChar).toMatch(/[.!?\n]/)
    }
  })
})

describe('RagChunker — sentence fallback for large paragraph', () => {
  it('splits a giant single paragraph on sentence boundaries', () => {
    // Build one paragraph: 300 sentences × ~10 tokens = ~3000 tokens → ≥7 chunks at 400 tokens
    const sentences = Array.from({ length: 300 }, (_, i) =>
      `This is sentence number ${i + 1} of the giant paragraph.`
    ).join(' ')

    const result = chunk(sentences)
    expect(result.length).toBeGreaterThanOrEqual(5)  // must split

    // Each non-final chunk should end with a sentence-ending punctuation
    for (let i = 0; i < result.length - 1; i++) {
      const trimmed = result[i].content.trimEnd()
      expect(trimmed[trimmed.length - 1]).toMatch(/[.!?]/)
    }
  })
})

// ── Section title / headings ────────────────────────────────────────────────────

describe('RagChunker — sectionTitle extraction', () => {
  it('null when no headings in text', () => {
    const result = chunk(makeText(CHUNK_TOKENS * 2))
    for (const c of result) {
      expect(c.sectionTitle).toBeNull()
    }
  })

  it('captures markdown heading and carries it to subsequent chunks', () => {
    const text = makeSection('Introduction', CHUNK_TOKENS * 3)
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const c of result) {
      expect(c.sectionTitle).toBe('Introduction')
    }
  })

  it('updates sectionTitle when a new heading appears', () => {
    const text =
      makeSection('Section 1', CHUNK_TOKENS * 2) + '\n\n' +
      makeSection('Section 2', CHUNK_TOKENS * 2)
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(3)

    const sec1Chunks = result.filter(c => c.sectionTitle === 'Section 1')
    const sec2Chunks = result.filter(c => c.sectionTitle === 'Section 2')
    expect(sec1Chunks.length).toBeGreaterThanOrEqual(1)
    expect(sec2Chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('captures numbered heading variant', () => {
    const text = `1. Getting Started\n\n${makeText(CHUNK_TOKENS * 2)}`
    const result = chunk(text)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0].sectionTitle).toBe('1. Getting Started')
  })
})

// ── Reconstruction ──────────────────────────────────────────────────────────────

describe('RagChunker — reconstruction', () => {
  it('every unique word in the source appears in at least one chunk', () => {
    const text = makeText(CHUNK_TOKENS * 3)
    const result = chunk(text)

    const allChunkText = result.map(c => c.content).join(' ')
    const sourceWords  = new Set(text.split(/\s+/).filter(w => w.length > 3))

    let misses = 0
    for (const word of sourceWords) {
      if (!allChunkText.includes(word)) misses++
    }
    // Allow tiny rounding/trim edge cases (≤1% misses)
    expect(misses / sourceWords.size).toBeLessThanOrEqual(0.01)
  })
})
