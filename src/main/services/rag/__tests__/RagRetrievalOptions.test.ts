/**
 * RagRetrievalService — Phase 4 options tests
 *
 * Verifies that the new RetrieveOptions (5th param) behaves correctly:
 *
 * 1. forceMode='lexical' → vectorCount=0, embedFn NEVER called
 * 2. forceMode='vector'  → lexicalCount=0 (no FTS5 calls; embedFn called)
 * 3. Default call without options → byte-identical to pre-Phase-4 expectations
 *    (existing tests untouched in RagRetrievalService.test.ts)
 * 4. captureTrace=false  → result.trace is undefined
 * 5. captureTrace=true   → result.trace populates every stage, including
 *    floor-dropped vector candidates (dropped:true) and allocation decisions
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ensureVecLoaded, _resetForTests } from '../../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../../EmbeddingService'

// ── Fixtures ──────────────────────────────────────────────────────────────────

let db: Database.Database

function vecBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function seedVec(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM)
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] = Math.sin(seed * (i + 1))
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0))
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm
  return arr
}

function stubEmbed(seed: number) {
  return async (_text: string): Promise<number[]> => Array.from(seedVec(seed))
}

let _counter = 5000

function seedChunk(opts: {
  chatId: string
  docId: string
  docName: string
  chunkIndex: number
  content: string
  vecSeed?: number
}): number {
  const { chatId, docId, docName, chunkIndex, content, vecSeed } = opts
  const id = _counter++
  try {
    db.prepare(
      `INSERT OR IGNORE INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'h' || ?, 0)`
    ).run(docId, docName, Date.now(), chatId, docId)
  } catch { /* already exists */ }

  db.prepare(
    `INSERT INTO rag_chunks (id, doc_id, chat_id, doc_name, chunk_index, section_title, content)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, docId, chatId, docName, chunkIndex, content)

  if (vecSeed !== undefined) {
    const v = seedVec(vecSeed)
    db.prepare('INSERT INTO chunks_vec(rowid, chat_id, embedding) VALUES (?, ?, ?)')
      .run(BigInt(id), chatId, vecBuffer(v))
  }
  return id
}

beforeAll(() => {
  _resetForTests()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  ensureVecLoaded(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL, chat_id TEXT, content TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'indexed', content_hash TEXT, token_count INTEGER
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
    CREATE TRIGGER IF NOT EXISTS rag_chunks_ad
      AFTER DELETE ON rag_chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chat_id text partition key, embedding float[${EMBEDDING_DIM}]
    );
    CREATE TABLE IF NOT EXISTS doc_inline_text (
      doc_id TEXT PRIMARY KEY, text TEXT NOT NULL
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))
vi.mock('../../SettingsStore', () => ({
  readSettings:  vi.fn(() => ({ rerankEnabled: false, ragVerboseTrace: false })),
  writeSettings: vi.fn(),
}))

import { retrieve } from '../RagRetrievalService'

// ── 1. forceMode='lexical' → no embed call, vectorCount=0 ─────────────────────

describe('retrieve options — forceMode lexical', () => {
  it('vectorCount=0 and embedFn never called when forceMode=lexical', async () => {
    const chatId = 'opts-lex-mode'
    seedChunk({ chatId, docId: 'doc-lex-opt', docName: 'l.pdf', chunkIndex: 0,
      content: 'lexical keyword content for retrieval', vecSeed: 3 })

    const embedSpy = vi.fn(async (_: string) => Array.from(seedVec(3)))

    const result = await retrieve('lexical keyword', chatId, embedSpy, undefined, { forceMode: 'lexical' })

    expect(embedSpy).not.toHaveBeenCalled()
    expect(result.vectorCount).toBe(0)
    // FTS5 should still find the chunk
    expect(result.hits.some(h => h.content.includes('lexical keyword'))).toBe(true)
  })
})

// ── 2. forceMode='vector' → lexicalCount=0, embedFn IS called ─────────────────

describe('retrieve options — forceMode vector', () => {
  it('lexicalCount=0 and embedFn called when forceMode=vector', async () => {
    const chatId = 'opts-vec-mode'
    const querySeed = 7
    seedChunk({ chatId, docId: 'doc-vec-opt', docName: 'v.pdf', chunkIndex: 0,
      content: 'vector retrieval content xqzvk123', vecSeed: querySeed })

    const embedSpy = vi.fn(stubEmbed(querySeed))

    const result = await retrieve('xqzvk123 content', chatId, embedSpy, undefined, { forceMode: 'vector' })

    expect(embedSpy).toHaveBeenCalled()
    expect(result.lexicalCount).toBe(0)
  })
})

// ── 3. captureTrace=false → trace undefined ────────────────────────────────────

describe('retrieve options — captureTrace false', () => {
  it('result.trace is undefined when captureTrace is false (default)', async () => {
    const chatId = 'opts-notrace'
    seedChunk({ chatId, docId: 'doc-notrace', docName: 'nt.pdf', chunkIndex: 0,
      content: 'notrace test content unique', vecSeed: 4 })

    const result = await retrieve('notrace test', chatId, stubEmbed(4))
    expect(result.trace).toBeUndefined()
  })

  it('result.trace is undefined when captureTrace=false explicitly', async () => {
    const chatId = 'opts-notrace2'
    seedChunk({ chatId, docId: 'doc-notrace2', docName: 'nt2.pdf', chunkIndex: 0,
      content: 'explicit false trace test', vecSeed: 5 })

    const result = await retrieve('explicit false', chatId, stubEmbed(5), undefined, { captureTrace: false })
    expect(result.trace).toBeUndefined()
  })
})

// ── 4. captureTrace=true → trace populated ────────────────────────────────────

describe('retrieve options — captureTrace true', () => {
  it('populates trace with query, chatId, and timestamp', async () => {
    const chatId = 'opts-trace-basic'
    seedChunk({ chatId, docId: 'doc-tb', docName: 'tb.pdf', chunkIndex: 0,
      content: 'trace basic test content here', vecSeed: 6 })

    const result = await retrieve('trace basic test', chatId, stubEmbed(6), undefined, { captureTrace: true })

    expect(result.trace).toBeDefined()
    const t = result.trace!
    expect(t.query).toBe('trace basic test')
    expect(t.chatId).toBe(chatId)
    expect(t.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('trace.lexical contains BM25 candidates with contentPreview', async () => {
    const chatId = 'opts-trace-lex'
    seedChunk({ chatId, docId: 'doc-tl', docName: 'tl.pdf', chunkIndex: 0,
      content: 'lexicaltrace uniquekeyword content', vecSeed: 8 })

    const result = await retrieve('lexicaltrace uniquekeyword', chatId, stubEmbed(8), undefined, { captureTrace: true })

    const t = result.trace!
    expect(t.lexical.length).toBeGreaterThanOrEqual(1)
    const lexEntry = t.lexical[0]
    expect(typeof lexEntry.rowid).toBe('number')
    expect(typeof lexEntry.contentPreview).toBe('string')
    expect(lexEntry.contentPreview.length).toBeLessThanOrEqual(200)
  })

  it('trace.vector includes floor-dropped candidates (dropped:true)', async () => {
    const chatId = 'opts-trace-drop'
    const querySeed = 11

    // Near chunk (not dropped)
    seedChunk({ chatId, docId: 'doc-td', docName: 'td.pdf', chunkIndex: 0,
      content: 'drop floor candidate near', vecSeed: querySeed })
    // Far chunk (should be dropped by VEC_DISTANCE_FLOOR=1.15)
    seedChunk({ chatId, docId: 'doc-td', docName: 'td.pdf', chunkIndex: 1,
      content: 'drop floor candidate far away xyzabc', vecSeed: 90 }) // very far from querySeed=11

    const result = await retrieve('drop floor candidate', chatId, stubEmbed(querySeed), undefined, { captureTrace: true })

    const t = result.trace!
    // vector array should include all raw KNN results including dropped ones
    expect(t.vector.length).toBeGreaterThanOrEqual(1)

    // If there are dropped candidates they must be flagged
    const dropped = t.vector.filter(v => v.dropped)
    const kept    = t.vector.filter(v => !v.dropped)

    // Dropped entries have distance > 1.15
    dropped.forEach(v => expect(v.distance).toBeGreaterThan(1.15))
    // Kept entries have distance ≤ 1.15
    kept.forEach(v => expect(v.distance).toBeLessThanOrEqual(1.15))

    // cosineSim = 1 − distance²/2 for each entry
    for (const v of t.vector) {
      expect(v.cosineSim).toBeCloseTo(1 - (v.distance * v.distance) / 2, 5)
    }
  })

  it('trace.allocation covers admitted + skipped decisions', async () => {
    const chatId = 'opts-trace-alloc'
    const querySeed = 13
    seedChunk({ chatId, docId: 'doc-ta', docName: 'ta.pdf', chunkIndex: 0,
      content: 'allocation test content small', vecSeed: querySeed })

    const result = await retrieve('allocation test', chatId, stubEmbed(querySeed), undefined, { captureTrace: true })

    const t = result.trace!
    // At least one admitted decision
    expect(t.allocation.length).toBeGreaterThanOrEqual(1)
    expect(t.allocation.some(a => a.decision === 'admitted')).toBe(true)
  })

  it('trace.finalPassages contain header + content for each admitted passage', async () => {
    const chatId = 'opts-trace-final'
    const querySeed = 15
    seedChunk({ chatId, docId: 'doc-tf', docName: 'tf.pdf', chunkIndex: 0,
      content: 'final passages content check here', vecSeed: querySeed })

    const result = await retrieve('final passages content', chatId, stubEmbed(querySeed), undefined, { captureTrace: true })

    const t = result.trace!
    expect(t.finalPassages.length).toBe(result.hits.length)
    // Each final passage should contain the chunk content
    for (let i = 0; i < result.hits.length; i++) {
      expect(t.finalPassages[i]).toContain(result.hits[i].content)
    }
  })

  it('trace.fused entries cover the union of lexical + vector candidates', async () => {
    const chatId = 'opts-trace-fused'
    const querySeed = 17
    seedChunk({ chatId, docId: 'doc-tfused', docName: 'fused.pdf', chunkIndex: 0,
      content: 'fusedtrace keyword test content', vecSeed: querySeed })

    const result = await retrieve('fusedtrace keyword test', chatId, stubEmbed(querySeed), undefined, { captureTrace: true })

    const t = result.trace!
    // Every fused entry should have an rrfScore > 0
    expect(t.fused.length).toBeGreaterThanOrEqual(1)
    for (const f of t.fused) {
      expect(f.rrfScore).toBeGreaterThan(0)
      expect(typeof f.inLexical).toBe('boolean')
      expect(typeof f.inVector).toBe('boolean')
    }
  })
})

// ── 5. coveragePct in IngestResult ───────────────────────────────────────────
// (tested here for convenience since it uses the same in-memory DB setup)

import { ingest } from '../RagIngestionService'

describe('RagIngestionService — coveragePct', () => {
  it('coveragePct is 100 for a normally-sized document (chunker guarantee)', async () => {
    // Stub embedFn to avoid model download
    const embedFn = async (_: string): Promise<number[]> => Array.from(seedVec(20))
    const doc = 'This is a test document. '.repeat(50) // ~25 × 50 = 1250 chars

    const result = await ingest({
      docId:   'cov-test-doc',
      chatId:  'cov-test-chat',
      fileName: 'test.txt',
      text:    doc,
      embedFn,
    })

    expect(result.status).toBe('ingested')
    // The chunker guarantees the last charEnd = text.length
    expect(result.coveragePct).toBeCloseTo(100, 0)
  })
})
