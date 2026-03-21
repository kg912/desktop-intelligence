/**
 * RAGService — Main process
 *
 * Orchestrates the full RAG pipeline:
 *
 *  ingestDocument(fileName, rawText, chatId?)
 *    → chunk text (500-token blocks, 50-token overlap)
 *    → embed each chunk via EmbeddingService
 *    → persist chunks to SQLite (with chat_id tag) + vector IDs to HNSWLib
 *
 *  retrieveContext(query, chatId?, k=5)
 *    → embed query
 *    → search HNSWLib for k nearest chunks (global ANN pass)
 *    → fetch chunk text from SQLite, filtered to chatId when provided
 *    → return formatted context string for injection as dedicated system message
 *
 * Anti-regression notes (Phase 8):
 *   • ingestDocument gains an optional chatId parameter — all existing call-sites
 *     that omit it continue to work (documents stored with chat_id = NULL).
 *   • retrieveContext gains an optional chatId parameter — when omitted the query
 *     falls back to the original unfiltered behaviour (no callers omit it after Phase 8).
 *   • The HNSWLib index is still a flat global index; per-chat scoping is enforced
 *     in the SQL layer via a JOIN on documents.chat_id after the ANN pass.
 */

import { v4 as uuid }     from 'uuid'
import { getDB }          from './DatabaseService'
import { embed }          from './EmbeddingService'
import { addVectors, searchNN } from './VectorStoreService'

// ── Chunking parameters ───────────────────────────────────────────
// 500-token target × ~4 chars/token = 2000 chars per chunk
// 50-token overlap  × ~4 chars/token =  200 chars overlap
const CHUNK_CHARS   = 500 * 4
const OVERLAP_CHARS =  50 * 4
const STEP          = CHUNK_CHARS - OVERLAP_CHARS

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const chunk = text.slice(start, start + CHUNK_CHARS).trim()
    if (chunk.length > 0) chunks.push(chunk)
    start += STEP
  }
  return chunks
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Chunk, embed, and store a document.
 * Safe to call multiple times with the same fileName — each call
 * creates a fresh document entry with its own UUID.
 */
export async function ingestDocument(
  fileName: string,
  rawText:  string,
  chatId?:  string
): Promise<void> {
  console.log(`[RAG] 🔄 ingestDocument: fileName="${fileName}" chatId=${chatId ?? 'null'} rawTextLen=${rawText?.length ?? 0}`)

  if (!rawText || rawText.trim().length === 0) {
    console.warn(`[RAG] ⚠️  rawText is empty for "${fileName}" — skipping ingest. Nothing will be retrievable.`)
    return
  }

  const db    = getDB()
  const docId = uuid()

  db.prepare(
    `INSERT OR REPLACE INTO documents (id, name, path, ts, chat_id) VALUES (?, ?, '', ?, ?)`
  ).run(docId, fileName, Date.now(), chatId ?? null)

  const chunks = chunkText(rawText)
  console.log(`[RAG] 📦 Chunks created: ${chunks.length} for "${fileName}"`)
  if (chunks.length === 0) return

  // Embed all chunks in parallel
  const vectors = await Promise.all(chunks.map((c) => embed(c)))

  // Insert chunks, collect SQLite rowids
  const insertChunk = db.prepare(
    `INSERT INTO chunks (doc_id, content, idx, vec_id) VALUES (?, ?, ?, 0)`
  )
  const rowids: number[] = []

  const insertTx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const r = insertChunk.run(docId, chunks[i], i)
      rowids.push(r.lastInsertRowid as number)
    }
  })
  insertTx()

  // Use the SQLite rowid as the hnswlib vector ID — 1-to-1 mapping
  await addVectors(rowids, vectors)
  console.log(`💾 VECTORS INSERTED INTO HNSWLIB: ${chunks.length} (fileName="${fileName}" chatId=${chatId ?? 'null'})`)

  // Back-fill vec_id so retrieval can round-trip through the DB
  const setVecId = db.prepare(`UPDATE chunks SET vec_id = ? WHERE id = ?`)
  const updateTx = db.transaction(() => {
    for (const rowid of rowids) setVecId.run(rowid, rowid)
  })
  updateTx()
}

/**
 * Embed the query, find the top-k most similar chunks scoped to chatId,
 * and return a formatted context block for injection as a dedicated
 * system message immediately before the user's last turn.
 *
 * Strategy:
 *   1. Global ANN pass on HNSWLib to get candidate chunk IDs.
 *   2. SQL re-query with JOIN on documents.chat_id to enforce per-chat isolation.
 *      Chunks whose parent document has a different (or NULL) chat_id are discarded.
 *
 * Returns '' if no chunks exist for this chat or the index is empty.
 */
export async function retrieveContext(
  query:   string,
  chatId?: string,
  k = 5
): Promise<string> {
  const db  = getDB()
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n
  if (cnt === 0) return ''

  const qvec      = await embed(query)
  // Request more candidates than needed so the chatId SQL filter has enough
  // to work with even after discarding chunks from other chats.
  const neighbors = await searchNN(qvec, Math.min(k * 3, cnt))
  if (neighbors.length === 0) return ''

  const ids          = neighbors.map((n) => n.id)
  const placeholders = ids.map(() => '?').join(',')

  // When a chatId is provided, enforce strict per-chat isolation via JOIN.
  // When omitted (legacy / no-context calls), fall back to unfiltered behaviour.
  let rows: { content: string }[]
  if (chatId) {
    rows = db
      .prepare(
        `SELECT c.content
         FROM   chunks c
         JOIN   documents d ON c.doc_id = d.id
         WHERE  c.id IN (${placeholders})
           AND  d.chat_id = ?
         ORDER  BY c.idx`
      )
      .all(...ids, chatId) as { content: string }[]
  } else {
    rows = db
      .prepare(`SELECT content FROM chunks WHERE id IN (${placeholders}) ORDER BY idx`)
      .all(...ids) as { content: string }[]
  }

  // Trim to the top-k results after SQL filtering
  const topRows = rows.slice(0, k)

  console.log(`🔥 VECTOR DB RESULTS COUNT: ${topRows.length} (chatId=${chatId ?? 'none'}, candidates=${neighbors.length}, sqlRows=${rows.length})`)
  if (topRows.length > 0) {
    console.log('🔥 VECTOR DB RESULTS (first chunk preview):', topRows[0].content.slice(0, 200))
  }

  if (topRows.length === 0) return ''

  const chunks = topRows
    .map((r, i) => `[Document Content: ${i + 1}]\n${r.content.trim()}`)
    .filter(Boolean)

  return chunks.join('\n\n')
}
