/**
 * RAGService — Main process  (Phase 11 rewrite)
 *
 * Previous approach used @xenova/transformers for embeddings and hnswlib-node
 * for vector search.  Both were silently broken in the packaged app:
 *
 *   • hnswlib-node is a CJS native module.  `await import('hnswlib-node')` returns
 *     undefined for all named exports because dynamic ESM import of native CJS
 *     bindings cannot statically determine the exports.  `HierarchicalNSW` was
 *     undefined every call → initIndex was never called → zero vectors ever stored.
 *     Confirmed: `require('hnswlib-node').HierarchicalNSW` works; `(await import()).HierarchicalNSW` is undefined.
 *
 *   • The whole chain (embed → hnswlib insert → ANN search → SQL join) was
 *     dead weight on top of a broken foundation.  The model received zero context
 *     on every single query.
 *
 * New approach — SQLite full-text storage:
 *
 *   ingestDocument(fileName, rawText, chatId?)
 *     → INSERT raw text directly into documents.content (synchronous SQLite write)
 *     → No embedding, no vector index, no native modules beyond better-sqlite3
 *
 *   retrieveContext(query, chatId?)
 *     → SELECT all documents for this chat from SQLite
 *     → Concatenate and truncate to MAX_CONTEXT_CHARS
 *     → Return formatted string for injection as system message
 *
 * Why this is better:
 *   • Reliable — pure SQLite, no ONNX, no hnswlib
 *   • Complete — model receives the actual document text, not a subset of
 *     semantically similar chunks from a broken vector index
 *   • Fast — synchronous DB write on ingest, one SELECT on retrieval
 *   • Correct — no chatId/timing races; text is in DB the moment processFile returns
 *
 * The `query` parameter in retrieveContext is kept for signature compatibility
 * and future use (keyword ranking, etc.) but is not used in this implementation.
 */

import { v4 as uuid } from 'uuid'
import { getDB }      from './DatabaseService'

// Maximum characters of document text to inject into the system prompt.
// 12 000 chars ≈ 3 000 tokens — well within Qwen's context window.
// For documents larger than this, the first MAX_CONTEXT_CHARS characters
// are used (the most structurally important section of most documents).
const MAX_CONTEXT_CHARS = 12_000

// ── Public API ────────────────────────────────────────────────────

/**
 * Store the full extracted document text in SQLite.
 * Replaces the old chunk→embed→hnswlib pipeline entirely.
 */
export async function ingestDocument(
  fileName: string,
  rawText:  string,
  chatId?:  string
): Promise<void> {
  console.log(`[RAG] 🔄 ingestDocument: fileName="${fileName}" chatId=${chatId ?? 'null'} rawTextLen=${rawText?.length ?? 0}`)

  if (!rawText || rawText.trim().length === 0) {
    console.warn(`[RAG] ⚠️  rawText is empty for "${fileName}" — skipping. PDF may be image-based (no text layer).`)
    return
  }

  const db    = getDB()
  const docId = uuid()

  db.prepare(
    `INSERT OR REPLACE INTO documents (id, name, path, ts, chat_id, content) VALUES (?, ?, '', ?, ?, ?)`
  ).run(docId, fileName, Date.now(), chatId ?? null, rawText)

  console.log(`💾 DOCUMENT SAVED TO SQLITE: "${fileName}" chatId=${chatId ?? 'null'} chars=${rawText.length}`)
}

/**
 * Retrieve all document text for this chat and return a formatted
 * context block for injection as a system message.
 *
 * The `query` parameter is reserved for future semantic ranking but is
 * not used in this implementation — all document content is returned.
 */
export async function retrieveContext(
  _query:  string,
  chatId?: string
): Promise<string> {
  const db = getDB()

  if (!chatId) {
    console.log(`🔥 DOCUMENT RETRIEVAL: no chatId — returning empty context`)
    return ''
  }

  const rows = db
    .prepare(
      `SELECT name, content FROM documents
       WHERE  chat_id = ?
         AND  content != ''
       ORDER  BY ts ASC`
    )
    .all(chatId) as { name: string; content: string }[]

  console.log(`🔥 DOCUMENT RETRIEVAL: ${rows.length} doc(s) for chatId=${chatId}`)

  if (rows.length === 0) return ''

  // Concatenate documents, truncating the total to MAX_CONTEXT_CHARS.
  // Multiple documents in the same chat are each labelled separately.
  let context = ''
  for (const row of rows) {
    const header  = `[Document: ${row.name}]\n`
    const body    = row.content
    const section = header + body

    if (context.length + section.length <= MAX_CONTEXT_CHARS) {
      context += (context ? '\n\n' : '') + section
    } else {
      const remaining = MAX_CONTEXT_CHARS - context.length - header.length - 4
      if (remaining > 100) {
        context += (context ? '\n\n' : '') + header + body.slice(0, remaining) + '\n…'
      }
      break
    }
  }

  console.log(`🔥 CONTEXT PREVIEW (first 200 chars): ${context.slice(0, 200).replace(/\n/g, ' ')}`)
  return context
}
