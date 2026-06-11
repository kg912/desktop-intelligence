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
import { ensureVecLoaded, isVecAvailable } from './rag/sqliteVecLoader'
import { EMBEDDING_DIM } from './EmbeddingService'

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

  // Context compaction: stores the summary text without touching message rows.
  // When set, ChatService injects this as the full history on the next request,
  // then clears it so subsequent messages use the real history again.
  try {
    _db.exec(`ALTER TABLE chats ADD COLUMN compacted_summary TEXT`)
  } catch { /* column already exists */ }

  // v2.1.0: MessageBlock JSON for the append-only block streaming architecture.
  // Nullable — old messages without blocks use the legacy toolCallJson + content fallback.
  try {
    _db.exec(`ALTER TABLE chat_messages ADD COLUMN blocks TEXT`)
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

  // Per-chat system instructions
  try {
    _db.exec(`ALTER TABLE chats ADD COLUMN system_instructions TEXT`)
  } catch { /* column already exists */ }

  // ── RAG v2 Phase 1 — load sqlite-vec extension (before migration) ────────────
  // Must run on every launch so that if the extension was unavailable on a prior
  // launch (e.g. cold boot before asarUnpack resolved), we pick it up now.
  // Failure is non-fatal (D10): sets isVecAvailable() = false, FTS5-only retrieval.
  ensureVecLoaded(_db)

  // ── RAG v2 Phase 1 — schema migration (user_version 0 → 1) ─────────────────
  const dbVersion = _db.pragma('user_version', { simple: true }) as number
  if (dbVersion < 1) {
    // 3b. Drop the Phase 5 "chunks" relic (dead code, no FK dependants)
    _db.exec('DROP TABLE IF EXISTS chunks')

    // 3c. Add v2 columns to existing documents table
    try { _db.exec(`ALTER TABLE documents ADD COLUMN mode TEXT NOT NULL DEFAULT 'indexed'`) } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE documents ADD COLUMN content_hash TEXT`) }                  catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE documents ADD COLUMN token_count INTEGER`) }                catch { /* already exists */ }

    // 3d. v2 inline-text and chunk tables
    _db.exec(`
      CREATE TABLE IF NOT EXISTS doc_inline_text (
        doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        text   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rag_chunks (
        id            INTEGER PRIMARY KEY,
        doc_id        TEXT    NOT NULL,
        chat_id       TEXT    NOT NULL,
        doc_name      TEXT    NOT NULL,
        chunk_index   INTEGER NOT NULL,
        section_title TEXT,
        content       TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rag_chunks_chat ON rag_chunks(chat_id);
    `)

    // 3e. External-content FTS5 for rag_chunks + canonical sync triggers
    try {
      _db.exec(`
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

        CREATE TRIGGER IF NOT EXISTS rag_chunks_au
          AFTER UPDATE ON rag_chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
            INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
          END;
      `)
    } catch (err) {
      console.error('[DB] chunks_fts / trigger creation failed (FTS5 unavailable?):', err)
    }

    // 3f. Best-effort cleanup of stale hnswlib index file (VectorStoreService is dead code)
    try {
      const fsModule = require('fs') as typeof import('fs')
      const vectorsHnsw = path.join(app.getPath('userData'), 'vectors.hnsw')
      if (typeof fsModule.rmSync === 'function' && typeof fsModule.existsSync === 'function') {
        if (fsModule.existsSync(vectorsHnsw)) {
          fsModule.rmSync(vectorsHnsw, { force: true })
          console.log('[DB] Removed stale vectors.hnsw file.')
        }
      }
    } catch { /* non-fatal */ }

    // 3g. Seal migration
    _db.exec('PRAGMA user_version = 1')
    console.log('[DB] RAG v2 Phase 1 migration complete (user_version → 1).')
  }

  // 3h. Create chunks_vec OUTSIDE the version gate — runs on every launch so
  // the table is created if vec became available after a prior failed launch.
  if (isVecAvailable()) {
    try {
      _db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          chat_id text partition key,
          embedding float[${EMBEDDING_DIM}]
        )
      `)
    } catch (err) {
      console.error('[DB] chunks_vec creation failed (sqlite-vec available but table failed):', err)
    }
  }

  // ── RAG v2 Phase 2 — cutover migration (user_version 1 → 2) ────────────────
  // After this point v1 retrieval is gone: drop document_chunks, purge dead v1
  // document rows, and wipe all v2 RAG data so that Phase 2 starts from a clean,
  // consistently-normalised state (vectors ingested in Phase 1 may not be L2-
  // normalised if the model was loaded cold; re-ingest fixes this cleanly).
  const dbVersion2 = _db.pragma('user_version', { simple: true }) as number
  if (dbVersion2 < 2) {
    // a. Drop v1 FTS5 table
    _db.exec('DROP TABLE IF EXISTS document_chunks')

    // b. Remove v1-era documents rows (no content_hash = written before v2)
    _db.exec('DELETE FROM documents WHERE content_hash IS NULL')

    // c. Wipe all v2 RAG data for a clean, normalised re-start
    //    (per O1: per-chat docs are ephemeral; re-upload is one drag-and-drop)
    _db.exec('DELETE FROM rag_chunks')   // triggers clean chunks_fts
    _db.exec('DELETE FROM doc_inline_text')
    _db.exec('DELETE FROM documents')
    if (isVecAvailable()) {
      try { _db.exec('DELETE FROM chunks_vec') } catch { /* non-fatal */ }
    }

    // d. Seal
    _db.exec('PRAGMA user_version = 2')
    console.log('[DB] RAG v2 Phase 2 migration complete (user_version → 2). All stale RAG data wiped for clean re-ingest.')
  }

  return _db
}

// ── Chat CRUD ────────────────────────────────────────────────────

export function getAllChats(): Chat[] {
  const rows = getDB()
    .prepare('SELECT id, title, created_at, updated_at, system_instructions FROM chats ORDER BY updated_at DESC')
    .all() as Array<{ id: string; title: string; created_at: number; updated_at: number; system_instructions: string | null }>
  return rows.map((r) => ({
    id:                 r.id,
    title:              r.title,
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
    systemInstructions: r.system_instructions ?? null,
  }))
}

export function createChat(id: string, title: string): Chat {
  const now = Date.now()
  getDB()
    .prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, now, now)
  return { id, title, createdAt: now, updatedAt: now, systemInstructions: null }
}

export function getChatMessages(chatId: string): StoredMessage[] {
  const rows = getDB()
    .prepare(
      'SELECT role, content, attachments_json, toolcall_json, blocks FROM chat_messages WHERE chat_id = ? ORDER BY created_at ASC'
    )
    .all(chatId) as Array<{
      role:             'user' | 'assistant' | 'system'
      content:          string
      attachments_json: string | null
      toolcall_json:    string | null
      blocks:           string | null
    }>
  return rows.map((r) => ({
    role:            r.role,
    content:         r.content,
    attachmentsJson: r.attachments_json,
    toolCallJson:    r.toolcall_json,
    blocksJson:      r.blocks,
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
  toolCallJson:    string | null = null,
  blocksJson:      string | null = null
): void {
  const now = Date.now()
  getDB()
    .prepare(
      `INSERT OR IGNORE INTO chat_messages
         (id, chat_id, role, content, created_at, attachments_json, toolcall_json, blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, chatId, role, content, now, attachmentsJson, toolCallJson, blocksJson)
  getDB()
    .prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
    .run(now, chatId)
}

// ── Context Compaction helpers ───────────────────────────────────
// The summary is stored in chats.compacted_summary rather than replacing
// message rows.  This preserves the visible conversation history in the UI;
// only the wire payload sent to LM Studio on the NEXT request is affected.
// ChatService reads the summary, injects it as the full history, then calls
// clearCompactedSummary so subsequent messages resume using real history.

export function setCompactedSummary(chatId: string, summary: string): void {
  getDB()
    .prepare(`UPDATE chats SET compacted_summary = ?, updated_at = ? WHERE id = ?`)
    .run(summary, Date.now(), chatId)
}

export function getCompactedSummary(chatId: string): string | null {
  const row = getDB()
    .prepare(`SELECT compacted_summary FROM chats WHERE id = ?`)
    .get(chatId) as { compacted_summary: string | null } | undefined
  return row?.compacted_summary ?? null
}

export function clearCompactedSummary(chatId: string): void {
  getDB()
    .prepare(`UPDATE chats SET compacted_summary = NULL WHERE id = ?`)
    .run(chatId)
}

/**
 * Delete all RAG data (v1 + v2) associated with a chat session.
 * Called from deleteChatById before removing the chats row.
 *
 * v2: deletes rag_chunks (triggers clean chunks_fts via external-content sync),
 *     chunks_vec embeddings, doc_inline_text, and documents rows.
 * v1: also deletes document_chunks (Phase 28 FTS5 — v1 never cleaned up on delete;
 *     this is the first-ever cleanup for v1 data, fixing the orphan-row leak).
 */
export function deleteRagDataForChat(chatId: string): void {
  const db = getDB()

  // v2: delete rag_chunks rows — AFTER INSERT trigger auto-deletes chunks_fts rows
  try {
    db.prepare('DELETE FROM rag_chunks WHERE chat_id = ?').run(chatId)
  } catch (err) {
    console.warn('[DB] deleteRagDataForChat: rag_chunks delete failed (non-fatal):', err)
  }

  // v2: delete vec embeddings if sqlite-vec is available (inline SQL — avoids circular require)
  if (isVecAvailable()) {
    try {
      db.prepare('DELETE FROM chunks_vec WHERE chat_id = ?').run(chatId)
    } catch (err) {
      console.warn('[DB] deleteRagDataForChat: chunks_vec delete failed (non-fatal):', err)
    }
  }

  // v1: delete FTS5 document_chunks rows (v1 path, never cleaned before this)
  try {
    db.prepare('DELETE FROM document_chunks WHERE chat_id = ?').run(chatId)
  } catch (err) {
    console.warn('[DB] deleteRagDataForChat: document_chunks delete failed (non-fatal):', err)
  }

  // v2 + v1: delete documents rows (CASCADE deletes doc_inline_text via FK)
  try {
    db.prepare('DELETE FROM documents WHERE chat_id = ?').run(chatId)
  } catch (err) {
    console.warn('[DB] deleteRagDataForChat: documents delete failed (non-fatal):', err)
  }
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

  // Delete RAG data (v1 document_chunks + v2 rag_chunks/vectors/inline) for this chat.
  // Must run before DELETE FROM chats because documents has no FK to chats.
  try {
    deleteRagDataForChat(chatId)
  } catch (err) {
    console.warn('[DB] deleteRagDataForChat failed (non-fatal):', err)
  }

  getDB().prepare('DELETE FROM chats WHERE id = ?').run(chatId)
}

export function getChatSystemInstructions(chatId: string): string | null {
  const row = getDB()
    .prepare(`SELECT system_instructions FROM chats WHERE id = ?`)
    .get(chatId) as { system_instructions: string | null } | undefined
  return row?.system_instructions ?? null
}

export function setChatSystemInstructions(chatId: string, text: string): void {
  const value = text.trim() || null
  getDB()
    .prepare(`UPDATE chats SET system_instructions = ?, updated_at = ? WHERE id = ?`)
    .run(value, Date.now(), chatId)
}
