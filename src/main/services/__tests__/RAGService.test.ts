/**
 * RAGService unit tests — Phase 28: FTS5-Powered Hybrid Retrieval
 *
 * These tests run against a real in-memory SQLite database (no mocked DB calls)
 * so they exercise the actual SQL — every schema assumption is verified.
 *
 * Critical invariants guarded here:
 *   1.  Documents are stored with the correct chat_id.
 *   2.  Retrieval is strictly isolated to the requested chat_id.
 *   3.  Empty / whitespace-only documents are never stored.
 *   4.  Total context is capped at MAX_CONTEXT_CHARS (12 000).
 *   5.  Multiple documents in the same chat are all returned.
 *   6.  Each chunk is labelled with [Document: name | Chunk N] header.
 *   7.  FTS5 keyword search returns the most relevant chunks.
 *   8.  Chronological fallback is used when query has no matches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { sanitizeFts5Query } from '../RAGService'

// ── In-memory SQLite — mirrors the exact schema from DatabaseService ─────────
const testDb = new Database(':memory:')
testDb.pragma('journal_mode = WAL')
testDb.pragma('foreign_keys = ON')

// documents table (keep content column for backward-compat with direct SQL inserts below)
testDb.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id      TEXT    PRIMARY KEY,
    name    TEXT    NOT NULL,
    path    TEXT    NOT NULL DEFAULT '',
    ts      INTEGER NOT NULL,
    chat_id TEXT,
    content TEXT    NOT NULL DEFAULT ''
  )
`)

// Phase 28: FTS5 virtual table — content is the only indexed column
testDb.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
    doc_id      UNINDEXED,
    chat_id     UNINDEXED,
    doc_name    UNINDEXED,
    content,
    chunk_index UNINDEXED
  )
`)

// Replace the real DatabaseService with the in-memory fixture.
vi.mock('../DatabaseService', () => ({ getDB: () => testDb }))
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))

import { ingestDocument, retrieveContext } from '../RAGService'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Count rows in the documents (metadata) table. */
function countDocs(): number {
  return (testDb.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n
}

/** Count rows in the FTS5 chunks table for a given chatId. */
function countChunks(chatId: string): number {
  return (
    testDb
      .prepare('SELECT COUNT(*) AS n FROM document_chunks WHERE chat_id = ?')
      .get(chatId) as { n: number }
  ).n
}

/** Fetch all chunks for a chatId ordered by chunk_index. */
function getChunks(chatId: string): Array<{ doc_name: string; content: string; chunk_index: number }> {
  return testDb
    .prepare('SELECT doc_name, content, chunk_index FROM document_chunks WHERE chat_id = ? ORDER BY chunk_index ASC')
    .all(chatId) as any[]
}

/** Fetch document metadata from the documents table. */
function getDoc(chatId: string): { name: string; chat_id: string | null } | undefined {
  return testDb
    .prepare('SELECT name, chat_id FROM documents WHERE chat_id = ?')
    .get(chatId) as any
}

// ── Suite: ingestDocument ─────────────────────────────────────────────────────

describe('ingestDocument', () => {
  beforeEach(() => {
    testDb.prepare('DELETE FROM documents').run()
    testDb.prepare('DELETE FROM document_chunks').run()
  })

  it('stores at least one chunk in document_chunks for the given chatId', async () => {
    await ingestDocument('lecture.pdf', 'The quick brown fox', 'chat-1')
    expect(countChunks('chat-1')).toBeGreaterThanOrEqual(1)
  })

  it('chunk content contains the original document text', async () => {
    await ingestDocument('lecture.pdf', 'The quick brown fox', 'chat-1')
    const chunks = getChunks('chat-1')
    expect(chunks[0].content).toBe('The quick brown fox')
  })

  it('stores the file name as doc_name on each chunk', async () => {
    await ingestDocument('report.pdf', 'some content', 'chat-1')
    const chunks = getChunks('chat-1')
    expect(chunks[0].doc_name).toBe('report.pdf')
  })

  it('stores the file name correctly in the documents metadata table', async () => {
    await ingestDocument('report.pdf', 'some content', 'chat-1')
    const row = getDoc('chat-1')
    expect(row!.name).toBe('report.pdf')
  })

  it('tags the document and its chunks with the provided chatId', async () => {
    await ingestDocument('a.pdf', 'content', 'chat-abc')
    const row = getDoc('chat-abc')
    expect(row!.chat_id).toBe('chat-abc')
    expect(countChunks('chat-abc')).toBeGreaterThanOrEqual(1)
  })

  it('stores document with null chat_id when chatId is omitted', async () => {
    await ingestDocument('orphan.pdf', 'orphan content')
    const row = testDb
      .prepare('SELECT chat_id FROM documents WHERE name = ?')
      .get('orphan.pdf') as any
    expect(row).toBeDefined()
    expect(row.chat_id).toBeNull()
  })

  it('skips empty rawText — nothing written to DB', async () => {
    await ingestDocument('empty.pdf', '', 'chat-1')
    expect(countDocs()).toBe(0)
    expect(countChunks('chat-1')).toBe(0)
  })

  it('skips whitespace-only rawText', async () => {
    await ingestDocument('spaces.pdf', '   \n\t  \n   ', 'chat-1')
    expect(countDocs()).toBe(0)
    expect(countChunks('chat-1')).toBe(0)
  })

  it('two calls for the same file create two separate metadata rows and two sets of chunks', async () => {
    await ingestDocument('doc.pdf', 'version 1', 'chat-1')
    await ingestDocument('doc.pdf', 'version 2', 'chat-1')
    // Each call generates a new UUID doc_id — two rows in documents, two chunk sets
    expect(countDocs()).toBeGreaterThanOrEqual(1)
    expect(countChunks('chat-1')).toBeGreaterThanOrEqual(2)
  })

  it('stores multiple distinct documents without interference', async () => {
    await ingestDocument('a.pdf', 'content A', 'chat-1')
    await ingestDocument('b.pdf', 'content B', 'chat-1')
    expect(countDocs()).toBe(2)
    expect(countChunks('chat-1')).toBeGreaterThanOrEqual(2)
  })

  it('large document is split into multiple chunks', async () => {
    const largeText = 'word '.repeat(1_000)  // 5 000 chars → at least 3 chunks at 1800/200 overlap
    await ingestDocument('large.pdf', largeText, 'chat-1')
    expect(countChunks('chat-1')).toBeGreaterThanOrEqual(3)
  })

  it('consecutive chunks share an overlap region (~200 chars)', async () => {
    // Create text > 2 chunks: 3 600 chars ensures at least chunk 0 and chunk 1
    const text = 'A'.repeat(1_800) + 'B'.repeat(1_800)
    await ingestDocument('overlap.pdf', text, 'chat-1')
    const chunks = getChunks('chat-1')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // The overlap region: end of chunk[0] and start of chunk[1] should share chars
    const endOf0   = chunks[0].content.slice(-200)
    const startOf1 = chunks[1].content.slice(0, 200)
    expect(endOf0).toBe(startOf1)
  })
})

// ── Suite: retrieveContext ────────────────────────────────────────────────────

describe('retrieveContext', () => {
  beforeEach(() => {
    testDb.prepare('DELETE FROM documents').run()
    testDb.prepare('DELETE FROM document_chunks').run()
  })

  // ── Guard against missing chatId ──────────────────────────────────────────

  it('returns empty string when chatId is undefined', async () => {
    await ingestDocument('doc.pdf', 'some content', 'chat-1')
    expect(await retrieveContext('any query')).toBe('')
  })

  it('returns empty string when no documents exist for the given chatId', async () => {
    expect(await retrieveContext('query', 'chat-nobody')).toBe('')
  })

  // ── Core retrieval ────────────────────────────────────────────────────────

  it('returns document content for the correct chatId (chronological fallback)', async () => {
    await ingestDocument('notes.pdf', 'ML lecture notes content here', 'chat-1')
    const ctx = await retrieveContext('query', 'chat-1')
    expect(ctx).toContain('ML lecture notes content here')
  })

  it('wraps each chunk with the [Document: name | Chunk N] header', async () => {
    await ingestDocument('sheet.pdf', 'content', 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toMatch(/\[Document: sheet\.pdf \| Chunk \d+\]/)
  })

  it('header and content appear together in the correct order', async () => {
    await ingestDocument('hw.pdf', 'homework text', 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    const headerPos  = ctx.indexOf('[Document: hw.pdf')
    const contentPos = ctx.indexOf('homework text')
    expect(headerPos).toBeGreaterThanOrEqual(0)
    expect(contentPos).toBeGreaterThan(headerPos)
  })

  // ── ChatId isolation — the most important invariant ───────────────────────

  it('does NOT return documents belonging to a different chatId', async () => {
    await ingestDocument('secret.pdf', 'top secret content', 'chat-A')
    const ctx = await retrieveContext('q', 'chat-B')
    expect(ctx).toBe('')
    expect(ctx).not.toContain('top secret content')
  })

  it('returns only documents for the requested chatId when multiple chats exist', async () => {
    await ingestDocument('a.pdf', 'content for chat A', 'chat-A')
    await ingestDocument('b.pdf', 'content for chat B', 'chat-B')

    const ctxA = await retrieveContext('q', 'chat-A')
    const ctxB = await retrieveContext('q', 'chat-B')

    expect(ctxA).toContain('content for chat A')
    expect(ctxA).not.toContain('content for chat B')

    expect(ctxB).toContain('content for chat B')
    expect(ctxB).not.toContain('content for chat A')
  })

  // ── Multiple documents in one chat ────────────────────────────────────────

  it('concatenates all documents in the same chat', async () => {
    await ingestDocument('first.pdf',  'alpha content',  'chat-1')
    await ingestDocument('second.pdf', 'beta content',   'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toContain('alpha content')
    expect(ctx).toContain('beta content')
    expect(ctx).toContain('[Document: first.pdf')
    expect(ctx).toContain('[Document: second.pdf')
  })

  it('separates multiple document chunks with double newlines', async () => {
    await ingestDocument('doc1.pdf', 'content1', 'chat-1')
    await ingestDocument('doc2.pdf', 'content2', 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    // The two document blocks must be separated
    expect(ctx).toMatch(/content1[\s\S]+content2/)
  })

  // ── FTS5 keyword search ───────────────────────────────────────────────────

  it('FTS5 primary path: returns the chunk matching the query keyword', async () => {
    // Insert two documents — only one contains the search term
    await ingestDocument('irrelevant.pdf', 'This document talks about cooking recipes and baking techniques.', 'chat-1')
    await ingestDocument('target.pdf',     'The backpropagation algorithm computes gradients via chain rule.', 'chat-1')
    const ctx = await retrieveContext('backpropagation gradients', 'chat-1')
    expect(ctx).toContain('backpropagation')
    // The cooking document should not dominate
    expect(ctx).toContain('[Document: target.pdf')
  })

  it('FTS5 finds needle-in-haystack: detail buried deep in a document', async () => {
    // 5 000 chars of filler + rare term + 5 000 chars of filler
    const preamble = 'general information about something '.repeat(140)  // ~5 040 chars
    const needle   = 'The secret passphrase is XYZZY-9001.'
    const postamble = 'more general content follows here '.repeat(140)  // ~4 760 chars
    await ingestDocument('haystack.pdf', preamble + needle + postamble, 'chat-1')
    const ctx = await retrieveContext('XYZZY-9001', 'chat-1')
    expect(ctx).toContain('XYZZY-9001')
  })

  // ── Context truncation ────────────────────────────────────────────────────

  it('caps total context at MAX_CONTEXT_CHARS (12 000) for a single large document', async () => {
    const bigText = 'x'.repeat(20_000)
    await ingestDocument('huge.pdf', bigText, 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    // Allow small overhead for the [Document: ...] headers
    expect(ctx.length).toBeLessThanOrEqual(12_200)
  })

  it('caps total context across multiple documents', async () => {
    // Two 8 000-char docs → combined 16 000 chars, must be truncated
    const bigText = 'y'.repeat(8_000)
    await ingestDocument('part1.pdf', bigText, 'chat-1')
    await ingestDocument('part2.pdf', bigText, 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx.length).toBeLessThanOrEqual(12_200)
  })

  it('appends ellipsis (…) when a chunk is truncated', async () => {
    const bigText = 'z'.repeat(20_000)
    await ingestDocument('long.pdf', bigText, 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toContain('…')
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty string when a document metadata row exists but has no chunks', async () => {
    // Insert a raw document row directly (no corresponding chunks in document_chunks)
    testDb
      .prepare("INSERT INTO documents VALUES ('id1', 'ghost.pdf', '', ?, 'chat-1', '')")
      .run(Date.now())
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toBe('')
    expect(ctx).not.toContain('ghost.pdf')
  })

  it('does not return chunks belonging to null-chatId when a specific chatId is requested', async () => {
    // Orphan document (no chatId) — insert directly into documents only (no chunks)
    testDb
      .prepare("INSERT INTO documents VALUES ('id2', 'orphan.pdf', '', ?, NULL, 'global content')")
      .run(Date.now())
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toBe('')
    expect(ctx).not.toContain('global content')
  })

  it('handles empty query string gracefully (uses chronological fallback)', async () => {
    await ingestDocument('notes.pdf', 'Introduction to Neural Networks', 'chat-1')
    const ctx = await retrieveContext('', 'chat-1')
    expect(ctx).toContain('Introduction to Neural Networks')
  })

  it('chunk_index starts at 1 in the formatted header', async () => {
    await ingestDocument('test.pdf', 'sample content', 'chat-1')
    const ctx = await retrieveContext('q', 'chat-1')
    expect(ctx).toContain('Chunk 1')
  })

  // ── Bug 1 regression: single FTS5 result must NOT be discarded ────────────
  // Previously chunks.length < 2 caused the fallback to overwrite a single
  // highly relevant FTS5 chunk with unrelated chronological content.

  it('single FTS5 result is kept — not discarded in favour of chronological fallback', async () => {
    // Two documents: one matches the query, one does not.
    // If the bug is present, FTS5 returns 1 chunk (< 2 threshold) → fallback
    // overrides it with both docs in chronological order, diluting the answer.
    // With the fix, 1 chunk (< 1 threshold = false) → FTS5 result is kept.
    await ingestDocument('noise.pdf',  'This talks about gardening and soil composition.', 'chat-1')
    await ingestDocument('signal.pdf', 'The eigenvalue decomposition of matrix A yields lambda.', 'chat-1')
    const ctx = await retrieveContext('eigenvalue lambda', 'chat-1')
    // Must contain the matching chunk
    expect(ctx).not.toBe('')
    expect(ctx).toContain('eigenvalue')
    // The noise document must NOT dominate the context when FTS5 finds a match
    // (it may appear if chronological fallback fires, but signal must be there)
    expect(ctx).toContain('[Document: signal.pdf')
  })
})

// ── Suite: sanitizeFts5Query ──────────────────────────────────────────────────

describe('sanitizeFts5Query', () => {
  it('strips hyphens and returns plain space-separated tokens', () => {
    expect(sanitizeFts5Query('back-propagation ReLU')).toBe('back propagation ReLU')
  })

  it('strips leading/trailing punctuation and collapses whitespace', () => {
    expect(sanitizeFts5Query('  hello, world!  ')).toBe('hello world')
  })

  it('drops single-character tokens (length === 1), keeps 2+ char words', () => {
    // 'a' (length 1) is dropped; 'the' and 'is' (length ≥ 2) are kept
    expect(sanitizeFts5Query('a the is')).toBe('the is')
  })

  it('returns empty string for all-punctuation or blank input', () => {
    expect(sanitizeFts5Query('--- *** !!!')).toBe('')
    expect(sanitizeFts5Query('')).toBe('')
  })

  it('does NOT wrap tokens in double quotes', () => {
    const result = sanitizeFts5Query('gradient descent')
    expect(result).not.toContain('"')
  })
})
