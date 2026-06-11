/**
 * RagIngestionService — token_count regression test (Phase 2 F1 fix).
 *
 * Phase 1 bug: ingest() wrote 0 for token_count with a stale comment
 * "token_count updated below" (the update was never implemented).
 * Phase 2 fix: callers pass tokenCount in IngestParams; ingest() uses it directly.
 *
 * This test guards against regression.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ensureVecLoaded, _resetForTests } from '../../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../../EmbeddingService'
import { countTokens } from '../../tokenUtils'

let db: Database.Database

function stubEmbed(_text: string): Promise<number[]> {
  return Promise.resolve(new Array<number>(EMBEDDING_DIM).fill(0).map((_, i) => Math.sin(i + 1)))
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
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chat_id text partition key, embedding float[${EMBEDDING_DIM}]
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))

import { ingest } from '../RagIngestionService'

describe('RagIngestionService — token_count persistence (F1 fix)', () => {
  it('token_count is persisted correctly when caller passes tokenCount', async () => {
    const text = 'This is a sample document with some content for token counting. '.repeat(20)
    const expectedTokens = countTokens(text)
    expect(expectedTokens).toBeGreaterThan(0)

    const docId = 'doc-tokcount-1'
    // Pre-insert documents row (as FileProcessorService does)
    db.prepare(
      `INSERT INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'hash-tok-1', 0)`
    ).run(docId, 'tok.pdf', Date.now(), 'chat-tok')

    await ingest({
      docId, chatId: 'chat-tok', fileName: 'tok.pdf', text,
      tokenCount: expectedTokens,
      embedFn: stubEmbed,
    })

    const row = db.prepare('SELECT token_count FROM documents WHERE id = ?').get(docId) as
      { token_count: number } | undefined
    expect(row?.token_count).toBe(expectedTokens)
  })

  it('token_count falls back to lazy-computed value when caller omits tokenCount', async () => {
    const text = 'Fallback token count test. '.repeat(10)

    const docId = 'doc-tokcount-2'
    db.prepare(
      `INSERT INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'hash-tok-2', 0)`
    ).run(docId, 'tok2.pdf', Date.now(), 'chat-tok2')

    await ingest({
      docId, chatId: 'chat-tok2', fileName: 'tok2.pdf', text,
      // tokenCount omitted — ingest() must compute it
      embedFn: stubEmbed,
    })

    const row = db.prepare('SELECT token_count FROM documents WHERE id = ?').get(docId) as
      { token_count: number } | undefined
    // Should be non-zero
    expect(row?.token_count).toBeGreaterThan(0)
  })
})
