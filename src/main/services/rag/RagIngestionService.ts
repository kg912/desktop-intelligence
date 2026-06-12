/**
 * RagIngestionService — v2 document ingestion pipeline.
 *
 * Phase 1: chunks text, embeds each chunk, writes to rag_chunks + chunks_fts
 * (via trigger) + chunks_vec in a single transaction.
 *
 * The `embedFn` parameter is injectable so tests can supply a deterministic stub
 * without downloading the real ONNX model.
 */

import crypto from 'crypto'
import { getDB } from '../DatabaseService'
import { chunk } from './RagChunker'
import { insertVectors } from './RagVectorStore'
import { isVecAvailable } from './sqliteVecLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmbedFn = (text: string) => Promise<number[]>

export interface IngestParams {
  docId:       string
  chatId:      string | undefined
  fileName:    string
  text:        string
  /** Pre-computed token count of `text`; callers that already counted tokens pass it here. */
  tokenCount?: number
  /** Defaults to EmbeddingService.embed — injectable for tests. */
  embedFn?:    EmbedFn
}

export interface IngestResult {
  status:      'ingested' | 'duplicate' | 'empty'
  chunkCount:  number
  vectorCount: number
  /** Percentage of sanitized text covered by the last chunk's charEnd (should be ~100). */
  coveragePct: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a document into the v2 RAG index.
 *
 * Flow:
 *   1. Guard: empty/whitespace text → 'empty'
 *   2. Dedup: sha256(text) checked against existing documents.content_hash
 *      for the same chat → 'duplicate' (no writes)
 *   3. Chunk: RagChunker.chunk(text)
 *   4. Embed: each chunk with a "[fileName §section, part i/N]" header prepended
 *      (raw content stored clean)
 *   5. Transaction: INSERT documents row + INSERT rag_chunks rows
 *      (trigger auto-inserts chunks_fts); then insert chunks_vec rows
 *   6. If embed fails mid-way: commits rag_chunks (FTS5-only), logs warning,
 *      vectorCount = 0
 *   7. Updates documents row: content_hash, token_count, mode='indexed'
 */
export async function ingest(params: IngestParams): Promise<IngestResult> {
  const { docId, chatId, fileName, text } = params

  const ingestStartMs = Date.now()
  // Acquire DB handle first so all guards can clean up the placeholder documents row
  const db = getDB()

  // 1. Empty guard — clean up any placeholder documents row the caller inserted
  if (!text || text.trim().length === 0) {
    console.warn(`[RAG][v2] ingest: empty text for "${fileName}" — skipping`)
    try { db.prepare('DELETE FROM documents WHERE id = ?').run(docId) } catch { /* non-fatal */ }
    return { status: 'empty', chunkCount: 0, vectorCount: 0, coveragePct: 0 }
  }
  const contentHash = sha256(text)

  // 2. Dedup: check existing documents in this chat with the same hash
  const effectiveChatId = chatId ?? null
  try {
    const existing = db.prepare(
      'SELECT id FROM documents WHERE chat_id = ? AND content_hash = ? AND id != ?'
    ).get(effectiveChatId, contentHash, docId) as { id: string } | undefined

    if (existing) {
      console.log(
        `[RAG][v2] ingest: duplicate content (hash=${contentHash.slice(0, 8)}…) ` +
        `for "${fileName}" in chat ${chatId ?? 'null'} — skipping`
      )
      // Clean up the placeholder documents row the caller inserted
      db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
      return { status: 'duplicate', chunkCount: 0, vectorCount: 0, coveragePct: 0 }
    }
  } catch (err) {
    console.warn('[RAG][v2] ingest: dedup check failed (proceeding):', err)
  }

  // 3. Chunk
  const chunks = chunk(text)
  const N      = chunks.length
  console.log(`[RAG][v2] ingest: "${fileName}" → ${N} chunks`)

  if (N === 0) {
    db.prepare('DELETE FROM documents WHERE id = ?').run(docId)
    return { status: 'empty', chunkCount: 0, vectorCount: 0, coveragePct: 0 }
  }

  // 4. Embed (with injectable embedFn; default = EmbeddingService.embed)
  let embedFn = params.embedFn
  if (!embedFn) {
    const { embed } = await import('../EmbeddingService')
    embedFn = embed
  }

  const embeddings: Float32Array[] = []
  let embedFailed = false
  for (let i = 0; i < N; i++) {
    // Build the header-prefixed text for embedding (stored content stays clean)
    const c = chunks[i]
    const headerParts = [`[${fileName}`]
    if (c.sectionTitle) headerParts.push(` §${c.sectionTitle}`)
    headerParts.push(`, part ${i + 1}/${N}]`)
    const headerText = headerParts.join('') + '\n' + c.content

    try {
      const vec = await embedFn(headerText)
      embeddings.push(new Float32Array(vec))
    } catch (embedErr) {
      console.warn(`[RAG][v2] ingest: embed failed at chunk ${i}/${N} (FTS5-only degradation):`, embedErr)
      embedFailed = true
      break
    }

    if ((i + 1) % 25 === 0 || i + 1 === N) {
      console.log(`[RAG][v2] ingest: embedded ${i + 1}/${N} chunks for "${fileName}"`)
    }
  }

  // 5. Transaction: write documents row + rag_chunks (triggers auto-inserts chunks_fts)
  const insertDoc = db.prepare(`
    INSERT OR REPLACE INTO documents (id, name, path, ts, chat_id, content_hash, token_count, mode)
    VALUES (?, ?, '', ?, ?, ?, ?, 'indexed')
  `)
  const insertChunk = db.prepare(`
    INSERT INTO rag_chunks (doc_id, chat_id, doc_name, chunk_index, section_title, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  // Collect rowids so we can align with embedding vectors
  const insertedRowids: number[] = []

  // Use caller-supplied tokenCount when available; fall back to lazy import
  let resolvedTokenCount = params.tokenCount ?? 0
  if (!resolvedTokenCount) {
    try {
      const { countTokens } = await import('../tokenUtils')
      resolvedTokenCount = countTokens(text)
    } catch { /* non-fatal — 0 is fine */ }
  }

  db.transaction(() => {
    insertDoc.run(docId, fileName, Date.now(), effectiveChatId, contentHash, resolvedTokenCount)
    for (let i = 0; i < N; i++) {
      const c = chunks[i]
      const info = insertChunk.run(
        docId, effectiveChatId, fileName, c.chunkIndex, c.sectionTitle, c.content
      )
      insertedRowids.push(Number(info.lastInsertRowid))
    }
  })()

  console.log(`[RAG][v2] ingest: ${N} rag_chunks rows written for "${fileName}"`)

  // 6. Insert vectors if embedding succeeded
  let vectorCount = 0
  if (!embedFailed && embeddings.length === N && isVecAvailable()) {
    const vecRows = embeddings.map((embedding, i) => ({
      rowid: insertedRowids[i],
      chatId: effectiveChatId ?? '',
      embedding,
    }))
    try {
      insertVectors(vecRows)
      vectorCount = N
      console.log(`[RAG][v2] ingest: ${N} vectors written to chunks_vec for "${fileName}"`)
    } catch (vecErr) {
      console.warn('[RAG][v2] ingest: chunks_vec insert failed (FTS5-only retrieval):', vecErr)
    }
  } else if (embedFailed) {
    console.warn(
      `[RAG][v2] ingest: embed failure — ${embeddings.length}/${N} embeddings computed. ` +
      'rag_chunks committed for FTS5-only retrieval.'
    )
  }

  // coveragePct: proves the chunker consumed the whole document.
  // lastChunk.charEnd ÷ text.length × 100. The chunker guarantees full consumption
  // (loop terminates only when actualEnd >= text.length), so this should be ~100.
  const lastChunk = chunks[chunks.length - 1]
  const coveragePct = text.length > 0
    ? Math.round((lastChunk.charEnd / text.length) * 100 * 100) / 100
    : 100

  // Emit rag_ingest observability event
  const ingestMs = Date.now() - ingestStartMs
  try {
    const { observabilityService } = await import('../ObservabilityService')
    observabilityService.emitRagEvent({
      type: 'rag_ingest',
      ts: Date.now(),
      payload: {
        docId,
        docName:       fileName,
        chatId:        effectiveChatId,
        mode:          'indexed',
        tokenCount:    resolvedTokenCount,
        inlineBudget:  null,
        chunkCount:    N,
        vectorCount,
        coveragePct,
        embedMsTotal:  ingestMs,  // total ingest time (embed is the dominant cost)
        durationMs:    ingestMs,
        degraded:      embedFailed,
      },
    })
  } catch { /* non-fatal */ }

  return { status: 'ingested', chunkCount: N, vectorCount, coveragePct }
}
