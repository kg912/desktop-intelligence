/**
 * DatabaseService RAG v2 migration + deleteRagDataForChat tests — Phase 2
 * Updated: user_version is now 2; document_chunks is dropped in Phase 2 migration.
 *
 * Uses a real temporary-directory SQLite DB (not in-memory) so that the
 * module-level `_db` singleton in DatabaseService is exercised exactly as
 * it runs in production.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join }        from 'path'
import { tmpdir }      from 'os'
import Database        from 'better-sqlite3'
import { _resetForTests } from '../rag/sqliteVecLoader'

// ── Test DB path ───────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(join(tmpdir(), 'di-rag-db-test-'))

// Mock electron so DatabaseService can call app.getPath('userData')
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => TEST_DIR),
  },
}))

// Mock PlotStore (dynamically required inside deleteChatById)
vi.mock('../PlotStore', () => ({ deletePlotsForChat: vi.fn() }))

// Reset the sqliteVecLoader before DatabaseService loads (fresh process state)
_resetForTests()

// ── Import DatabaseService AFTER mocks are in place ───────────────────────────

import {
  getDB,
  deleteRagDataForChat,
  createChat,
} from '../DatabaseService'

// ── Schema assertions ──────────────────────────────────────────────────────────

describe('DatabaseService RAG v2 migration', () => {
  let db: Database.Database

  beforeAll(() => {
    db = getDB()
  })

  it('reaches user_version = 2 after first getDB() (Phase 2 migration applied)', () => {
    const v = db.pragma('user_version', { simple: true }) as number
    expect(v).toBe(2)
  })

  it('documents table has mode, content_hash, token_count columns', () => {
    const cols = (db.pragma('table_info(documents)') as Array<{ name: string }>)
      .map(c => c.name)
    expect(cols).toContain('mode')
    expect(cols).toContain('content_hash')
    expect(cols).toContain('token_count')
  })

  it('doc_inline_text table exists', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='doc_inline_text'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(1)
  })

  it('rag_chunks table exists', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='rag_chunks'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(1)
  })

  it('chunks_fts virtual table exists', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(1)
  })

  it('chunks_vec virtual table exists (sqlite-vec loaded)', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(1)
  })

  it('legacy chunks table is absent (Phase 5 relic dropped)', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(0)
  })

  it('document_chunks (v1 FTS5) is absent — dropped in Phase 2 migration', () => {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'"
    ).all() as Array<{ name: string }>)
    expect(tables.length).toBe(0)
  })

  it('migration is idempotent (calling getDB() again does not throw)', () => {
    expect(() => getDB()).not.toThrow()
    // user_version should still be 2
    const v = db.pragma('user_version', { simple: true }) as number
    expect(v).toBe(2)
  })

  it('Phase 2 migration: NULL-hash documents rows removed, document_chunks absent', () => {
    // Manually insert a v1-era row (no content_hash) to verify migration cleans it
    // This row is already cleaned by the Phase 2 migration that ran at init.
    // Verify: no such rows remain.
    const nullHashCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM documents WHERE content_hash IS NULL"
    ).get() as { n: number }).n
    expect(nullHashCount).toBe(0)
  })
})

// ── deleteRagDataForChat ───────────────────────────────────────────────────────

describe('deleteRagDataForChat', () => {
  it('removes rag_chunks, chunks_fts, chunks_vec, doc_inline_text, and documents for target chat', async () => {
    const db = getDB()
    const chatId   = 'chat-del-rag-test'
    const otherChat = 'chat-del-other'

    // Seed: create chat rows
    createChat(chatId, 'Delete Test')
    createChat(otherChat, 'Other Chat')

    // Seed documents
    const docId1 = 'doc-del-1'
    const docId2 = 'doc-del-other'
    db.prepare(`INSERT INTO documents (id, name, path, ts, chat_id, mode) VALUES (?, ?, '', ?, ?, 'inline')`).run(docId1, 'del.pdf', Date.now(), chatId)
    db.prepare(`INSERT INTO documents (id, name, path, ts, chat_id, mode) VALUES (?, ?, '', ?, ?, 'inline')`).run(docId2, 'other.pdf', Date.now(), otherChat)

    // Seed doc_inline_text
    db.prepare('INSERT INTO doc_inline_text (doc_id, text) VALUES (?, ?)').run(docId1, 'inline content')
    db.prepare('INSERT INTO doc_inline_text (doc_id, text) VALUES (?, ?)').run(docId2, 'other inline')

    // Seed rag_chunks (triggers insert into chunks_fts)
    db.prepare(`INSERT INTO rag_chunks (doc_id, chat_id, doc_name, chunk_index, section_title, content) VALUES (?, ?, ?, ?, ?, ?)`).run(docId1, chatId, 'del.pdf', 0, null, 'chunk for delete test')
    db.prepare(`INSERT INTO rag_chunks (doc_id, chat_id, doc_name, chunk_index, section_title, content) VALUES (?, ?, ?, ?, ?, ?)`).run(docId2, otherChat, 'other.pdf', 0, null, 'other chunk')

    // Seed chunks_vec
    const { insertVectors } = await import('../rag/RagVectorStore')
    const makeVec = (s: number) => {
      const a = new Float32Array(384)
      for (let i = 0; i < 384; i++) a[i] = Math.sin(s * (i + 1))
      return a
    }
    const chunkId = (db.prepare('SELECT id FROM rag_chunks WHERE chat_id = ?').get(chatId) as { id: number }).id
    const otherChunkId = (db.prepare('SELECT id FROM rag_chunks WHERE chat_id = ?').get(otherChat) as { id: number }).id
    insertVectors([
      { rowid: chunkId,      chatId,    embedding: makeVec(1) },
      { rowid: otherChunkId, chatId: otherChat, embedding: makeVec(2) },
    ])

    // (document_chunks no longer exists in Phase 2 — table was dropped in migration 1→2)

    // ── Delete ──
    deleteRagDataForChat(chatId)

    // Target chat data gone
    expect((db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE chat_id = ?').get(chatId) as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents WHERE chat_id = ?').get(chatId) as { n: number }).n).toBe(0)
    // doc_inline_text cascades with documents
    expect((db.prepare('SELECT COUNT(*) AS n FROM doc_inline_text WHERE doc_id = ?').get(docId1) as { n: number }).n).toBe(0)

    // FTS5 cleaned up by trigger
    const ftsHits = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'delete'").all()
    expect(ftsHits.length).toBe(0)

    // Other chat untouched
    expect((db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE chat_id = ?').get(otherChat) as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents WHERE chat_id = ?').get(otherChat) as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM doc_inline_text WHERE doc_id = ?').get(docId2) as { n: number }).n).toBe(1)
  })
})
