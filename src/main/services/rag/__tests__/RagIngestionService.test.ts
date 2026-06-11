/**
 * RagIngestionService unit tests — Phase 1
 *
 * Uses a real in-memory DB with the sqlite-vec extension.
 * embedFn is always a deterministic stub — never downloads the real model.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ensureVecLoaded, _resetForTests } from '../../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../../EmbeddingService'

// ── Fixtures ───────────────────────────────────────────────────────────────────

let db: Database.Database

/** Deterministic embedding stub: hash-seeded unit vector. */
function stubEmbed(text: string): Promise<number[]> {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  const arr = new Array<number>(EMBEDDING_DIM)
  let norm = 0
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    arr[i] = Math.sin(h * (i + 1))
    norm += arr[i] * arr[i]
  }
  norm = Math.sqrt(norm)
  return Promise.resolve(arr.map(v => v / norm))
}

function countRows(table: string, where = ''): number {
  const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? ' WHERE ' + where : ''}`
  return (db.prepare(sql).get() as { n: number }).n
}

beforeAll(() => {
  _resetForTests()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  ensureVecLoaded(db)  // sets _vecAvailable = true for the duration of this test file

  // Build the full v2 schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL,
      chat_id TEXT,
      content TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'indexed',
      content_hash TEXT,
      token_count INTEGER
    );

    CREATE TABLE IF NOT EXISTS doc_inline_text (
      doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY,
      doc_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      doc_name TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      section_title TEXT,
      content TEXT NOT NULL
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
      chat_id text partition key,
      embedding float[${EMBEDDING_DIM}]
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))

import { ingest } from '../RagIngestionService'

// ── Helper: insert a documents row so ingest can UPDATE it ────────────────────
function insertDocRow(docId: string, chatId: string | null, fileName: string): void {
  db.prepare(
    `INSERT INTO documents (id, name, path, ts, chat_id) VALUES (?, ?, '', ?, ?)`
  ).run(docId, fileName, Date.now(), chatId)
}

// ── ingest: happy path ─────────────────────────────────────────────────────────

describe('RagIngestionService.ingest — happy path', () => {
  it('returns status=ingested with correct counts', async () => {
    const docId = 'doc-happy-1'
    const chatId = 'chat-happy'
    insertDocRow(docId, chatId, 'happy.pdf')

    const longText = 'Machine learning is a subfield of artificial intelligence. '.repeat(300)
    const result = await ingest({ docId, chatId, fileName: 'happy.pdf', text: longText, embedFn: stubEmbed })

    expect(result.status).toBe('ingested')
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(result.vectorCount).toBe(result.chunkCount)  // vec available
  })

  it('rowid alignment: every rag_chunks id has a matching chunks_vec rowid', async () => {
    const docId  = 'doc-align'
    const chatId = 'chat-align'
    insertDocRow(docId, chatId, 'align.pdf')

    const text = 'Vector alignment test. '.repeat(300)
    const result = await ingest({ docId, chatId, fileName: 'align.pdf', text, embedFn: stubEmbed })
    expect(result.status).toBe('ingested')

    const chunkIds = (db.prepare('SELECT id FROM rag_chunks WHERE doc_id = ?').all(docId) as { id: number }[])
      .map(r => r.id)
    const vecIds = (db.prepare("SELECT rowid FROM chunks_vec WHERE chat_id = ?").all(chatId) as { rowid: number }[])
      .map(r => r.rowid)

    for (const id of chunkIds) {
      expect(vecIds).toContain(id)
    }
  })

  it('chunks_fts MATCH finds a term from a middle chunk (FTS5 triggers fired)', async () => {
    const docId  = 'doc-fts'
    const chatId = 'chat-fts'
    insertDocRow(docId, chatId, 'fts.pdf')

    // Build text where UNIQUE_WORD appears only in the second chunk
    const prefix = 'Common words repeated many times. '.repeat(100)
    const unique  = 'XYZUNIQTOKEN is a special term found only here. '
    const suffix  = 'More common words repeated again. '.repeat(100)
    const text = prefix + unique + suffix

    await ingest({ docId, chatId, fileName: 'fts.pdf', text, embedFn: stubEmbed })

    const hits = db.prepare(
      "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'XYZUNIQTOKEN' LIMIT 10"
    ).all() as { rowid: number }[]
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Duplicate hash dedup ────────────────────────────────────────────────────────

describe('RagIngestionService.ingest — dedup', () => {
  it('same hash + same chat → status=duplicate, no new rows', async () => {
    const chatId = 'chat-dedup'
    const text   = 'Unique content for dedup test. '.repeat(200)

    // First upload
    const docId1 = 'doc-dedup-1'
    insertDocRow(docId1, chatId, 'dup.pdf')
    const r1 = await ingest({ docId: docId1, chatId, fileName: 'dup.pdf', text, embedFn: stubEmbed })
    expect(r1.status).toBe('ingested')

    const chunksBefore = countRows('rag_chunks', `doc_id = '${docId1}'`)

    // Second upload — same text, same chat
    const docId2 = 'doc-dedup-2'
    insertDocRow(docId2, chatId, 'dup.pdf')
    const r2 = await ingest({ docId: docId2, chatId, fileName: 'dup.pdf', text, embedFn: stubEmbed })
    expect(r2.status).toBe('duplicate')
    expect(r2.chunkCount).toBe(0)

    // No new rag_chunks rows from the second ingest
    expect(countRows('rag_chunks', `doc_id = '${docId1}'`)).toBe(chunksBefore)
    expect(countRows('rag_chunks', `doc_id = '${docId2}'`)).toBe(0)
    // The phantom documents row for docId2 should be cleaned up
    expect(countRows('documents', `id = '${docId2}'`)).toBe(0)
  })

  it('same hash in a DIFFERENT chat → status=ingested (not a duplicate)', async () => {
    const text   = 'Cross-chat dedup check content. '.repeat(200)

    const docId1 = 'doc-xc-1'
    insertDocRow(docId1, 'chat-xc-1', 'file.pdf')
    const r1 = await ingest({ docId: docId1, chatId: 'chat-xc-1', fileName: 'file.pdf', text, embedFn: stubEmbed })
    expect(r1.status).toBe('ingested')

    const docId2 = 'doc-xc-2'
    insertDocRow(docId2, 'chat-xc-2', 'file.pdf')
    const r2 = await ingest({ docId: docId2, chatId: 'chat-xc-2', fileName: 'file.pdf', text, embedFn: stubEmbed })
    expect(r2.status).toBe('ingested')
  })
})

// ── Empty text ─────────────────────────────────────────────────────────────────

describe('RagIngestionService.ingest — empty', () => {
  it('empty text → status=empty, no DB writes', async () => {
    const docId = 'doc-empty'
    insertDocRow(docId, 'chat-empty', 'empty.pdf')
    const result = await ingest({ docId, chatId: 'chat-empty', fileName: 'empty.pdf', text: '', embedFn: stubEmbed })
    expect(result.status).toBe('empty')
    expect(countRows('rag_chunks', `doc_id = '${docId}'`)).toBe(0)
    expect(countRows('documents', `id = '${docId}'`)).toBe(0)  // cleaned up
  })

  it('whitespace-only text → status=empty', async () => {
    const docId = 'doc-ws'
    insertDocRow(docId, 'chat-ws', 'ws.pdf')
    const result = await ingest({ docId, chatId: 'chat-ws', fileName: 'ws.pdf', text: '   \n\t  ', embedFn: stubEmbed })
    expect(result.status).toBe('empty')
  })
})

// ── Embed failure ──────────────────────────────────────────────────────────────

describe('RagIngestionService.ingest — embed failure', () => {
  it('embed throws → rag_chunks committed, chunks_vec empty, vectorCount=0', async () => {
    const docId  = 'doc-embedfail'
    const chatId = 'chat-embedfail'
    insertDocRow(docId, chatId, 'fail.pdf')

    const text = 'Some reasonable text for ingestion. '.repeat(200)
    let callCount = 0
    const failingEmbed: typeof stubEmbed = async (t) => {
      callCount++
      if (callCount > 2) throw new Error('mock embed failure')
      return stubEmbed(t)
    }

    const result = await ingest({ docId, chatId, fileName: 'fail.pdf', text, embedFn: failingEmbed })
    expect(result.status).toBe('ingested')
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(result.vectorCount).toBe(0)  // no vectors due to early failure

    // rag_chunks should have rows
    expect(countRows('rag_chunks', `doc_id = '${docId}'`)).toBe(result.chunkCount)
    // chunks_vec should have NO rows for this chat
    const vecCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM chunks_vec WHERE chat_id = '${chatId}'`
    ).get() as { n: number }).n
    expect(vecCount).toBe(0)
  })
})
