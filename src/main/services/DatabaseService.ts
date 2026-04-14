/**
 * DatabaseService — Main process
 *
 * Singleton better-sqlite3 database.
 * Tables:
 *   documents / chunks  — Phase 5 RAG
 *   chats / chat_messages — Phase 6 conversation history
 *   plot_store — Image RAG: stores matplotlib chart PNGs + metadata
 *
 * Lazy-initialised on first access (requires app to be ready).
 *
 * Anti-regression notes (Phase 8):
 *   • documents.chat_id column added via ALTER TABLE migration (try/catch guarded).
 *     Documents ingested before this migration will have chat_id = NULL and will
 *     therefore be excluded from per-chat RAG retrieval — correct isolation behaviour.
 *   • No other existing queries are affected; only ingestDocument and retrieveContext
 *     use the new column.
 */

import Database from 'better-sqlite3'
import { app }  from 'electron'
import path     from 'path'
import type { Chat, StoredMessage } from '../../shared/types'

let _db: Database.Database | null = null

export function getDB(): Database.Database {
  if (_db) return _db

  const dbPath = path.join(app.getPath('userData'), 'desktop-intelligence.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous  = NORMAL')
  _db.pragma('foreign_keys = ON')

  _db.exec(`
    -- ── RAG: Ingested documents ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS documents (
      id   TEXT    PRIMARY KEY,
      name TEXT    NOT NULL,
      path TEXT    NOT NULL DEFAULT '',
      ts   INTEGER NOT NULL
    );

    -- ── RAG: Text chunks ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS chunks (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id  TEXT    NOT NULL,
      content TEXT    NOT NULL,
      idx     INTEGER NOT NULL,
      vec_id  INTEGER NOT NULL DEFAULT 0
    );

    -- ── Chat sessions ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS chats (
      id         TEXT    PRIMARY KEY,
      title      TEXT    NOT NULL DEFAULT 'New Chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ── Messages per chat ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         TEXT    PRIMARY KEY,
      chat_id    TEXT    NOT NULL,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    -- ── Image RAG: stored matplotlib plots ────────────────────────
    CREATE TABLE IF NOT EXISTS plot_store (
      id         TEXT    PRIMARY KEY,
      chat_id    TEXT    NOT NULL,
      code       TEXT    NOT NULL,
      image_path TEXT    NOT NULL,
      caption    TEXT    NOT NULL DEFAULT '',
      ts         INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `)

  // ── Migrations (try/catch guards duplicate-column errors) ────────
  try {
    _db.exec(`ALTER TABLE documents ADD COLUMN chat_id TEXT`)
  } catch { /* column already exists */ }

  // Phase 9: attachment metadata on chat messages
  try {
    _db.exec(`ALTER TABLE chat_messages ADD COLUMN attachments_json TEXT`)
  } catch { /* column already exists */ }

  // Phase 11: full document text stored directly in SQLite (replaces hnswlib/vector approach)
  try {
    _db.exec(`ALTER TABLE documents ADD COLUMN content TEXT NOT NULL DEFAULT ''`)
  } catch { /* column already exists */ }

  // Tool call JSON (web search query + sources) for assistant messages
  try {
    _db.exec(`ALTER TABLE chat_messages ADD COLUMN toolcall_json TEXT`)
  } catch { /* column already exists */ }

  // Phase 28: FTS5-powered chunk table for hybrid "needle in a haystack" retrieval.
  // Replaces the brute-force full-document context injection with BM25-ranked keyword
  // search across overlapping 1800-char chunks.  documents.content is kept for backward
  // compatibility but new ingests write to document_chunks only.
  // Columns:
  //   doc_id      — FK to documents.id (not indexed — metadata only)
  //   chat_id     — owning chat session (not indexed — used for WHERE filter)
  //   doc_name    — filename for display (not indexed — avoids JOIN on retrieval)
  //   content     — the chunk text (INDEXED — the only FTS5-searchable column)
  //   chunk_index — position within the document (not indexed — for ordering)
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
        doc_id      UNINDEXED,
        chat_id     UNINDEXED,
        doc_name    UNINDEXED,
        content,
        chunk_index UNINDEXED
      )
    `)
  } catch (err) {
    console.error('[DB] FTS5 table creation failed — FTS5 may not be compiled into this SQLite build:', err)
  }

  return _db
}

// ── Chat CRUD ────────────────────────────────────────────────────

export function getAllChats(): Chat[] {
  const rows = getDB()
    .prepare('SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC')
    .all() as Array<{ id: string; title: string; created_at: number; updated_at: number }>
  return rows.map((r) => ({
    id:        r.id,
    title:     r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export function createChat(id: string, title: string): Chat {
  const now = Date.now()
  getDB()
    .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, now, now)
  return { id, title, createdAt: now, updatedAt: now }
}

export function getChatMessages(chatId: string): StoredMessage[] {
  const rows = getDB()
    .prepare(
      'SELECT role, content, attachments_json, toolcall_json FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC'
    )
    .all(chatId) as Array<{
      role:             'user' | 'assistant' | 'system'
      content:          string
      attachments_json: string | null
      toolcall_json:    string | null
    }>
  return rows.map((r) => ({
    role:            r.role,
    content:         r.content,
    attachmentsJson: r.attachments_json,
    toolCallJson:    r.toolcall_json,
  }))
}

/**
 * Persists a single message and bumps the chat's updated_at timestamp.
 * INSERT OR IGNORE guards against duplicate message IDs on retry.
 * attachmentsJson — JSON-encoded attachment metadata for user messages; null otherwise.
 */
export function saveMessage(
  chatId:          string,
  id:              string,
  role:            string,
  content:         string,
  attachmentsJson: string | null = null,
  toolCallJson:    string | null = null
): void {
  const now = Date.now()
  getDB()
    .prepare(
      `INSERT OR IGNORE INTO chat_messages
         (id, chat_id, role, content, created_at, attachments_json, toolcall_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, chatId, role, content, now, attachmentsJson, toolCallJson)
  getDB()
    .prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
    .run(now, chatId)
}

export function deleteChatById(chatId: string): void {
  // Delete plot PNG files from disk before removing the DB row.
  // The plot_store FK has ON DELETE CASCADE so rows auto-delete,
  // but we must clean up the actual files on disk separately.
  try {
    const { deletePlotsForChat } = require('./PlotStore') as typeof import('./PlotStore')
    deletePlotsForChat(chatId)
  } catch (err) {
    console.warn('[DB] deletePlotsForChat failed (non-fatal):', err)
  }
  getDB().prepare('DELETE FROM chats WHERE id = ?').run(chatId)
}
