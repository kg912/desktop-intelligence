/**
 * FileProcessorService v2 routing tests — Phase 1
 *
 * Tests the inline/indexed classification added in the dual-write phase.
 * Uses stub embedFn; never downloads the real model.
 *
 * Separate from FileProcessorService.test.ts (which guards v1 regressions).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { loadSqliteVec, _resetForTests } from '../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../EmbeddingService'

// ── In-memory DB ───────────────────────────────────────────────────────────────

let db: Database.Database

function buildTestDb(): Database.Database {
  const d = new Database(':memory:')
  d.pragma('foreign_keys = ON')
  loadSqliteVec(d)
  d.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL, chat_id TEXT, content TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'indexed', content_hash TEXT, token_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS doc_inline_text (
      doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      doc_name TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      section_title TEXT, content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_chat ON rag_chunks(chat_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, content='rag_chunks', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS rag_chunks_ai
      AFTER INSERT ON rag_chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
      END;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chat_id text partition key, embedding float[${EMBEDDING_DIM}]
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
      doc_id UNINDEXED, chat_id UNINDEXED, doc_name UNINDEXED,
      content, chunk_index UNINDEXED
    );
  `)
  return d
}

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Context window = 32768 → INLINE_BUDGET = 16384 tokens
vi.mock('../SettingsStore', () => ({
  readSettings: () => ({ contextLength: 32768 }),
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp') } }))

// Mock pdf-parse so we can control extracted text
let mockPdfText = 'sample text'
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor(_opts: unknown) {}
    async getText() { return { text: mockPdfText } }
  },
}))

// Stub embedFn injected via RagIngestionService
const stubEmbedFn = vi.fn(async (text: string): Promise<number[]> => {
  let h = 0
  for (let i = 0; i < Math.min(text.length, 64); i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  const arr = new Array<number>(EMBEDDING_DIM).fill(0).map((_, i) => Math.sin(h * (i + 1) * 0.001))
  const n = Math.sqrt(arr.reduce((s, v) => s + v * v, 0))
  return arr.map(v => v / n)
})

vi.mock('../rag/RagIngestionService', async (importOriginal) => {
  const original = await importOriginal<typeof import('../rag/RagIngestionService')>()
  return {
    ingest: (params: Parameters<typeof original.ingest>[0]) =>
      original.ingest({ ...params, embedFn: stubEmbedFn }),
  }
})

// RAGService no longer used by FileProcessorService (v1 path removed in Phase 2)

// fs mock (only readFileSync needed for FileProcessorService)
vi.mock('fs', () => ({
  readFileSync: vi.fn((_path: string, encoding?: string) => {
    if (encoding === 'utf-8' || encoding === 'utf8') return mockPdfText
    return Buffer.from(mockPdfText)
  }),
}))

beforeEach(() => {
  _resetForTests()
  db = buildTestDb()
})

afterEach(() => {
  db.close()
})

// Provide the test DB to DatabaseService
vi.mock('../DatabaseService', () => ({ getDB: () => db }))

import { processFile } from '../FileProcessorService'
import { countTokens } from '../tokenUtils'

// ── Helper ─────────────────────────────────────────────────────────────────────

function makePayload(fileName: string): Parameters<typeof processFile>[0] {
  return {
    filePath: `/tmp/${fileName}`,
    fileName,
    mimeType: 'text/plain',
    size: mockPdfText.length,
    chatId: 'chat-routing-test',
  }
}

// ── Inline routing (small doc) ─────────────────────────────────────────────────

describe('FileProcessorService v2 routing — inline (small doc)', () => {
  it('~2k-token doc → mode=inline, doc_inline_text row written', async () => {
    // Build a text with ~2000 tokens (well under INLINE_BUDGET of 16384)
    mockPdfText = 'Short document with roughly two thousand tokens of content. '.repeat(140)
    const tc = countTokens(mockPdfText)
    expect(tc).toBeLessThan(16384)

    const result = await processFile(makePayload('small.pdf'))

    // Phase 2: inject is always null — context delivered via RagRetrievalService
    expect(result.inject).toBeNull()
    expect(result.kind).toBe('document')

    // v2 inline row
    const inlineRows = db.prepare('SELECT * FROM doc_inline_text').all() as { doc_id: string; text: string }[]
    expect(inlineRows.length).toBeGreaterThanOrEqual(1)
    const inlineRow = inlineRows[inlineRows.length - 1]  // most recent
    expect(inlineRow.text).toContain('Short document')

    // documents row has mode=inline (exactly one row per upload — no v1 paired row)
    const docRow = db.prepare('SELECT mode FROM documents WHERE id = ?').get(inlineRow.doc_id) as { mode: string } | undefined
    expect(docRow?.mode).toBe('inline')

    // No rag_chunks for inline doc
    expect((db.prepare(`SELECT COUNT(*) AS n FROM rag_chunks WHERE doc_id = ?`).get(inlineRow.doc_id) as { n: number }).n).toBe(0)
  })
})

// ── Indexed routing (large doc) ────────────────────────────────────────────────

describe('FileProcessorService v2 routing — indexed (large doc)', () => {
  it('large doc (>INLINE_BUDGET tokens) → mode=indexed, rag_chunks populated', async () => {
    // Build text with > 16384 tokens (> INLINE_BUDGET for 32768 context).
    // Each sentence is ~15 tokens and ~77 chars → 5.1 chars/token.
    // Need 16384 × 5.1 × 1.2 safety margin = ~100k chars.
    const sentence = 'This is a sentence containing about ten words with varied vocabulary content. '
    const repeats = Math.ceil(110_000 / sentence.length)
    mockPdfText = sentence.repeat(repeats)
    const tc = countTokens(mockPdfText)
    expect(tc).toBeGreaterThan(16384)

    const result = await processFile(makePayload('large.pdf'))

    // Phase 2: inject is always null
    expect(result.inject).toBeNull()
    expect(result.kind).toBe('document')

    // Verify the large doc didn't end up in inline text
    const docsRow = db.prepare("SELECT id FROM documents WHERE mode = 'indexed' ORDER BY ts DESC LIMIT 1").get() as { id: string } | undefined
    if (docsRow) {
      const inlineForDoc = db.prepare('SELECT 1 FROM doc_inline_text WHERE doc_id = ?').get(docsRow.id)
      expect(inlineForDoc).toBeUndefined()
    }

    // v2 rag_chunks rows populated
    const ragCount = (db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number }).n
    expect(ragCount).toBeGreaterThan(0)
  })
})
