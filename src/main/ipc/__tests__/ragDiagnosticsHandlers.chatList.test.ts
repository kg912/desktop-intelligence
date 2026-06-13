/**
 * ragDiagnosticsHandlers — Phase 5 tests
 *
 * Tests for listDocChatsFromDB (rag:list-doc-chats) and assembleRagConfig
 * (rag:get-config) using an in-memory SQLite database, following the same
 * fixture pattern as RagEvalService.test.ts and RagRetrievalService.test.ts.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { listDocChatsFromDB, assembleRagConfig } from '../ragDiagnosticsHandlers'
import { CHUNK_TOKENS, CHUNK_OVERLAP_TOKENS } from '../../services/rag/RagChunker'
import { EMBEDDING_DIM } from '../../services/EmbeddingService'
import { FINAL_K, CONTEXT_TOKEN_BUDGET } from '../../services/rag/RagRetrievalService'

// ── Electron stub (ipcMain / app not needed for pure helper tests) ─────────────

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_p: string) => '/tmp'),
    getVersion: () => '0.0.0',
  },
  ipcMain: { handle: vi.fn() },
}))

// ── In-memory DB setup ────────────────────────────────────────────────────────

let db: Database.Database

beforeAll(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE chats (
      id         TEXT    PRIMARY KEY,
      title      TEXT    NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE documents (
      id           TEXT    PRIMARY KEY,
      name         TEXT    NOT NULL,
      path         TEXT    NOT NULL DEFAULT '',
      ts           INTEGER NOT NULL,
      chat_id      TEXT,
      mode         TEXT    NOT NULL DEFAULT 'indexed',
      content_hash TEXT,
      token_count  INTEGER,
      content      TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE rag_chunks (
      id          INTEGER PRIMARY KEY,
      doc_id      TEXT    NOT NULL,
      chat_id     TEXT    NOT NULL,
      doc_name    TEXT    NOT NULL,
      chunk_index INTEGER NOT NULL,
      section_title TEXT,
      content     TEXT    NOT NULL
    );

    CREATE TABLE chat_messages (
      id         TEXT    PRIMARY KEY,
      chat_id    TEXT    NOT NULL,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let chatSeq = 0
let docSeq  = 0
let chunkSeq = 0
let msgSeq  = 0

function insertChat(opts: {
  title?: string
  updatedAt?: number
}): string {
  const id = `chat-${++chatSeq}`
  const now = opts.updatedAt ?? Date.now()
  db.prepare(
    `INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
  ).run(id, opts.title ?? 'New Chat', now, now)
  return id
}

function insertDoc(chatId: string, opts: { mode?: string } = {}): string {
  const id   = `doc-${++docSeq}`
  const mode = opts.mode ?? 'indexed'
  db.prepare(
    `INSERT INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
     VALUES (?, ?, '', ?, ?, ?, 'h', 0)`
  ).run(id, `file-${id}.pdf`, Date.now(), chatId, mode)
  return id
}

function insertChunk(docId: string, chatId: string): void {
  const id = ++chunkSeq
  db.prepare(
    `INSERT INTO rag_chunks (id, doc_id, chat_id, doc_name, chunk_index, section_title, content)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, docId, chatId, `file-${docId}.pdf`, id, `chunk content ${id}`)
}

function insertUserMessage(chatId: string, content: string, createdAt?: number): void {
  const id = `msg-${++msgSeq}`
  db.prepare(
    `INSERT INTO chat_messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`
  ).run(id, chatId, content, createdAt ?? Date.now())
}

// ── listDocChatsFromDB ────────────────────────────────────────────────────────

describe('listDocChatsFromDB', () => {

  it('excludes chats that have no document rows', () => {
    insertChat({ title: 'Doc-free chat' })           // no documents
    const chatWithDoc = insertChat({ title: 'Has a doc' })
    const doc = insertDoc(chatWithDoc)
    insertChunk(doc, chatWithDoc)

    const result = listDocChatsFromDB(db)
    const ids = result.map(r => r.chatId)
    expect(ids).toContain(chatWithDoc)
    // Doc-free chats must not appear — every returned chat must have ≥1 doc
    result.forEach(r => {
      const docCount = (db.prepare('SELECT COUNT(*) AS n FROM documents WHERE chat_id = ?').get(r.chatId) as { n: number }).n
      expect(docCount).toBeGreaterThan(0)
    })
  })

  it('returns correct docCount, indexedDocCount, and totalChunks', () => {
    const chatId = insertChat({ title: 'Counts test' })
    const d1 = insertDoc(chatId, { mode: 'indexed' })
    const d2 = insertDoc(chatId, { mode: 'indexed' })
    insertDoc(chatId, { mode: 'inline' })               // inline → not counted in indexedDocCount
    insertChunk(d1, chatId)
    insertChunk(d1, chatId)   // 2 chunks for d1
    insertChunk(d2, chatId)   // 1 chunk for d2
    // inline doc has no chunks

    const result = listDocChatsFromDB(db)
    const entry = result.find(r => r.chatId === chatId)
    expect(entry).toBeDefined()
    expect(entry!.docCount).toBe(3)
    expect(entry!.indexedDocCount).toBe(2)
    expect(entry!.totalChunks).toBe(3)
  })

  it('applies title fallback for "New Chat" placeholder — uses first user message', () => {
    const chatId = insertChat({ title: 'New Chat' })
    const doc = insertDoc(chatId)
    insertChunk(doc, chatId)
    insertUserMessage(chatId, 'Explain the transformer architecture in detail', 1000)

    const result = listDocChatsFromDB(db)
    const entry = result.find(r => r.chatId === chatId)
    expect(entry).toBeDefined()
    expect(entry!.title).toBe('Explain the transformer architecture in detail')
  })

  it('truncates long first-message fallback titles at 60 chars with ellipsis', () => {
    const longMsg = 'A'.repeat(80)
    const chatId  = insertChat({ title: 'New Chat' })
    const doc     = insertDoc(chatId)
    insertChunk(doc, chatId)
    insertUserMessage(chatId, longMsg, 2000)

    const result = listDocChatsFromDB(db)
    const entry  = result.find(r => r.chatId === chatId)
    expect(entry).toBeDefined()
    expect(entry!.title).toBe('A'.repeat(60) + '…')
  })

  it('falls back to chatId when title is "New Chat" and no messages exist', () => {
    const chatId = insertChat({ title: 'New Chat' })
    const doc    = insertDoc(chatId)
    insertChunk(doc, chatId)
    // No messages inserted

    const result = listDocChatsFromDB(db)
    const entry  = result.find(r => r.chatId === chatId)
    expect(entry).toBeDefined()
    expect(entry!.title).toBe(chatId)
  })

  it('orders by updated_at descending (most-recently active chat first)', () => {
    const older  = insertChat({ title: 'Older',  updatedAt: 1_000_000 })
    const newer  = insertChat({ title: 'Newer',  updatedAt: 9_000_000 })
    const middle = insertChat({ title: 'Middle', updatedAt: 5_000_000 })
    for (const cid of [older, newer, middle]) {
      const d = insertDoc(cid)
      insertChunk(d, cid)
    }

    const result = listDocChatsFromDB(db)
    const relevant = result.filter(r => [older, newer, middle].includes(r.chatId))
    expect(relevant[0].chatId).toBe(newer)
    expect(relevant[1].chatId).toBe(middle)
    expect(relevant[2].chatId).toBe(older)
  })
})

// ── assembleRagConfig ─────────────────────────────────────────────────────────

describe('assembleRagConfig', () => {
  it('returns an object with all expected keys', async () => {
    const cfg = await assembleRagConfig()
    const keys = [
      'CHUNK_TOKENS', 'CHUNK_OVERLAP_TOKENS',
      'FINAL_K', 'FINAL_K_RERANKED',
      'K_LEXICAL', 'K_VECTOR', 'RRF_K',
      'VEC_DISTANCE_FLOOR', 'CONTEXT_TOKEN_BUDGET',
      'EMBEDDING_MODEL_ID', 'EMBEDDING_DIM',
      'RERANKER_MODEL_ID',
    ]
    for (const k of keys) {
      expect(cfg).toHaveProperty(k)
    }
  })

  it('CHUNK_TOKENS and CHUNK_OVERLAP_TOKENS match the exported constants', async () => {
    const cfg = await assembleRagConfig()
    expect(cfg.CHUNK_TOKENS).toBe(CHUNK_TOKENS)
    expect(cfg.CHUNK_OVERLAP_TOKENS).toBe(CHUNK_OVERLAP_TOKENS)
  })

  it('EMBEDDING_DIM matches the exported constant', async () => {
    const cfg = await assembleRagConfig()
    expect(cfg.EMBEDDING_DIM).toBe(EMBEDDING_DIM)
  })

  it('FINAL_K and CONTEXT_TOKEN_BUDGET match the exported constants', async () => {
    const cfg = await assembleRagConfig()
    expect(cfg.FINAL_K).toBe(FINAL_K)
    expect(cfg.CONTEXT_TOKEN_BUDGET).toBe(CONTEXT_TOKEN_BUDGET)
  })

  it('model IDs are non-empty strings', async () => {
    const cfg = await assembleRagConfig()
    expect(typeof cfg.EMBEDDING_MODEL_ID).toBe('string')
    expect(cfg.EMBEDDING_MODEL_ID.length).toBeGreaterThan(0)
    expect(typeof cfg.RERANKER_MODEL_ID).toBe('string')
    expect(cfg.RERANKER_MODEL_ID.length).toBeGreaterThan(0)
  })
})
