/**
 * RAGService — Main process  (Phase 28 rewrite: FTS5-Powered Hybrid Retrieval)
 *
 * ── Architectural evolution ────────────────────────────────────────────────────
 *
 * Phase 11 (previous): SQLite full-document storage.
 *   Stored the entire extracted text in documents.content and injected the first
 *   12 000 chars into the system prompt.  "Top-heavy" — only saw the beginning of
 *   any document.  A detail on page 20 of a 30-page PDF was invisible to the model.
 *
 * Phase 28 (this): FTS5-Powered Hybrid Retrieval.
 *   Splits each document into overlapping 1 800-character chunks and stores them in
 *   a SQLite FTS5 virtual table (document_chunks).  BM25-ranked keyword search finds
 *   the exact chunk(s) most relevant to the user's query, regardless of where they
 *   appear in the document — true "needle in a haystack" retrieval.
 *
 * ── Why FTS5 over vector embeddings ────────────────────────────────────────────
 *   • hnswlib-node (Phase 5): silently broken — dynamic ESM import of native CJS
 *     returns undefined for all named exports; HierarchicalNSW was never defined.
 *   • @xenova/transformers (Phase 10): 1 056ms cold-start per session; WASM/ONNX
 *     fails in Electron packaged app unless extracted from ASAR.
 *   • FTS5: built into SQLite, no native bindings beyond better-sqlite3, zero cold-
 *     start, sub-millisecond search on thousands of chunks.
 *
 * ── Retrieval strategy ─────────────────────────────────────────────────────────
 *   Primary   — FTS5 MATCH with BM25 ranking.  Triggered when a non-empty query is
 *               provided and returns ≥ 2 matching chunks.
 *   Fallback  — Chronological retrieval (oldest doc first, chunk order preserved).
 *               Used when query is empty or FTS5 returns < 2 results (e.g. single-
 *               word query, rare terminology not present in the document verbatim).
 *
 * ── Signature compatibility ────────────────────────────────────────────────────
 *   ingestDocument(fileName, rawText, chatId?) and retrieveContext(query, chatId?)
 *   are unchanged — FileProcessorService.ts calls them without modification.
 */

import crypto from 'crypto'
import { getDB } from './DatabaseService'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum total characters assembled into the context block injected as a system message. */
const MAX_CONTEXT_CHARS = 12_000

/** Target character width of each chunk.  1 800 chars ≈ 450 tokens — comfortably
 *  inside a single reasoning step for most models. */
const CHUNK_SIZE = 1_800

/** Overlap between consecutive chunks to preserve semantic continuity at boundaries.
 *  200 chars ≈ 1–2 sentences repeated at the start of the next chunk. */
const CHUNK_OVERLAP = 200

/** Maximum number of chunks to include in the assembled context.
 *  8 × 1 800 = 14 400 chars before the MAX_CONTEXT_CHARS cap applies. */
const MAX_CHUNKS = 8

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Splits `text` into overlapping fixed-size chunks.
 * Each chunk is CHUNK_SIZE chars, with the next chunk starting at
 * (previous_start + CHUNK_SIZE - CHUNK_OVERLAP).
 */
function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - CHUNK_OVERLAP
  }
  return chunks
}

/**
 * Converts a free-form user query into a safe FTS5 query string.
 * Each word is wrapped in double quotes to avoid special-character issues
 * (FTS5 tokens like AND/OR/NOT, parentheses, asterisks, etc.).
 * Single-character tokens are dropped — they produce too many false positives.
 */
function sanitizeFts5Query(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, ' ')   // strip punctuation
    .split(/\s+/)
    .filter(w => w.length > 1)  // skip single chars
  if (words.length === 0) return ''
  return words.map(w => `"${w.replace(/"/g, '')}"`).join(' ')
}

// ── Chunk row type returned by both retrieval paths ───────────────────────────

interface ChunkRow {
  doc_id:      string
  chat_id:     string | null
  doc_name:    string
  content:     string
  chunk_index: number
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Chunk and store a document in the FTS5 table for later retrieval.
 *
 * Pipeline:
 *   1. Guard — empty / whitespace-only text is skipped.
 *   2. Split — divide rawText into CHUNK_SIZE chunks with CHUNK_OVERLAP.
 *   3. Atomic transaction — insert metadata row in `documents` and all chunk
 *      rows in `document_chunks` in a single BEGIN/COMMIT.
 *
 * Only sanitized text (from FileProcessorService.sanitizeDocumentText) should
 * be passed here.  RAGService itself performs no sanitization.
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
  const docId = crypto.randomUUID()
  const ts    = Date.now()
  const chunks = chunkText(rawText)

  // Prepared statements are reused across all chunk inserts for performance.
  const insertDoc = db.prepare(
    `INSERT OR REPLACE INTO documents (id, name, path, ts, chat_id) VALUES (?, ?, '', ?, ?)`
  )
  const insertChunk = db.prepare(
    `INSERT INTO document_chunks (doc_id, chat_id, doc_name, content, chunk_index) VALUES (?, ?, ?, ?, ?)`
  )

  db.transaction(() => {
    insertDoc.run(docId, fileName, ts, chatId ?? null)
    for (let i = 0; i < chunks.length; i++) {
      insertChunk.run(docId, chatId ?? null, fileName, chunks[i], i)
    }
  })()

  console.log(`💾 DOCUMENT CHUNKS SAVED: "${fileName}" chatId=${chatId ?? 'null'} chunks=${chunks.length} totalChars=${rawText.length}`)
}

/**
 * Retrieve the most relevant document chunks for `query` within `chatId`.
 *
 * Hybrid strategy:
 *   Primary   — FTS5 BM25-ranked MATCH search.  Returns the N chunks whose
 *               content best matches the query keywords.
 *   Fallback  — Chronological retrieval (oldest document first, chunk order).
 *               Used when query is empty/blank OR primary returns < 2 chunks.
 *
 * Context format: `[Document: filename | Chunk N]\ncontent…`
 * Total output is capped at MAX_CONTEXT_CHARS; the last included chunk is
 * truncated with '…' when it would exceed the cap.
 */
export async function retrieveContext(
  query:   string,
  chatId?: string
): Promise<string> {
  if (!chatId) {
    console.log(`🔥 DOCUMENT RETRIEVAL: no chatId — returning empty context`)
    return ''
  }

  const db = getDB()
  let chunks: ChunkRow[] = []

  // ── Primary: FTS5 keyword search ─────────────────────────────────────────
  if (query && query.trim().length > 0) {
    const ftsQuery = sanitizeFts5Query(query)
    if (ftsQuery) {
      try {
        chunks = db.prepare(`
          SELECT doc_id, chat_id, doc_name, content, chunk_index
          FROM   document_chunks
          WHERE  document_chunks MATCH ?
            AND  chat_id = ?
          ORDER  BY rank
          LIMIT  ?
        `).all(ftsQuery, chatId, MAX_CHUNKS) as ChunkRow[]

        console.log(`🔥 FTS5 SEARCH: "${query.slice(0, 60)}" → ${chunks.length} chunk(s) for chatId=${chatId}`)
      } catch (err) {
        console.warn('[RAG] FTS5 MATCH failed — falling back to chronological retrieval:', err)
        chunks = []
      }
    }
  }

  // ── Fallback: chronological retrieval ────────────────────────────────────
  // Triggers when: no query, blank query, sanitised query is empty (all single
  // chars), FTS5 threw an error, or FTS5 returned < 2 results.
  if (chunks.length < 2) {
    chunks = db.prepare(`
      SELECT dc.doc_id, dc.chat_id, dc.doc_name, dc.content, dc.chunk_index
      FROM   document_chunks dc
      JOIN   documents d ON dc.doc_id = d.id
      WHERE  dc.chat_id = ?
      ORDER  BY d.ts ASC, dc.chunk_index ASC
      LIMIT  ?
    `).all(chatId, MAX_CHUNKS) as ChunkRow[]

    console.log(`🔥 CHRONOLOGICAL RETRIEVAL: ${chunks.length} chunk(s) for chatId=${chatId}`)
  }

  if (chunks.length === 0) return ''

  // ── Context assembly ──────────────────────────────────────────────────────
  let context = ''

  for (const chunk of chunks) {
    const header  = `[Document: ${chunk.doc_name} | Chunk ${Number(chunk.chunk_index) + 1}]\n`
    const section = header + chunk.content

    if (context.length + (context ? 2 : 0) + section.length <= MAX_CONTEXT_CHARS) {
      context += (context ? '\n\n' : '') + section
    } else {
      // Truncate this chunk to fill the remaining budget
      const separator = context ? 2 : 0
      const remaining = MAX_CONTEXT_CHARS - context.length - separator - header.length - 2
      if (remaining > 100) {
        context += (context ? '\n\n' : '') + header + chunk.content.slice(0, remaining) + '\n…'
      }
      break
    }
  }

  console.log(`🔥 CONTEXT ASSEMBLED: ${context.length} chars | preview: ${context.slice(0, 200).replace(/\n/g, ' ')}`)
  return context
}
