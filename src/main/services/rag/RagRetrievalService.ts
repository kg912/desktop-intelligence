/**
 * RagRetrievalService — hybrid FTS5 + vector retrieval with RRF fusion.
 *
 * Phase 2: retrieves passages from rag_chunks using both BM25 lexical search
 * and dense cosine-based vector search, fuses the ranked lists with Reciprocal
 * Rank Fusion, stitches neighbouring chunks for context, and assembles a
 * token-budgeted context envelope ready to splice as a system message.
 *
 * The embedFn parameter is injectable so tests never download the real model.
 */

import { getDB } from '../DatabaseService'
import { knn } from './RagVectorStore'
import { isVecAvailable } from './sqliteVecLoader'
import { countTokens } from '../tokenUtils'
import type { RagRetrievalResult, RagPassage } from '../../../shared/types'

export type { RagRetrievalResult, RagPassage }

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum lexical (FTS5 BM25) candidates to retrieve. */
export const K_LEXICAL = 20

/** Maximum vector (KNN) candidates to retrieve. */
export const K_VECTOR = 20

/** RRF smoothing constant — industry default. */
export const RRF_K = 60

/** Number of fused candidates to carry into the stitch + assembly step. */
export const FINAL_K = 6

/** Token budget for the assembled context envelope (excludes headers). */
export const CONTEXT_TOKEN_BUDGET = 6000

/**
 * L2-distance upper bound for vector candidates.
 * With L2-normalized vectors: L2² = 2 - 2·cos(θ), so
 *   distance=1.15 → distance²≈1.32 → cos(θ)≈0.34 (≈70° separation).
 * Candidates above this floor are noisy and excluded before fusion.
 */
export const VEC_DISTANCE_FLOOR = 1.15

// ── FTS5 query sanitizer (ported verbatim from RAGService.ts) ─────────────────

/**
 * Converts a free-form user query into a safe FTS5 query string.
 *
 * Plain unquoted tokens are used (no double-quote wrapping) so that FTS5's
 * default unicode61 tokenizer applies case-insensitive prefix matching.
 * Punctuation is replaced with spaces so hyphens/slashes in the raw query
 * don't produce FTS5 syntax errors.
 * Single-character tokens are dropped — FTS5 minimum token length is typically 2.
 *
 * Exported for unit testing.
 */
export function sanitizeFts5Query(raw: string): string {
  const words = raw
    .replace(/[^\w\s]/g, ' ')   // strip punctuation → space
    .split(/\s+/)
    .filter(w => w.length > 1)  // skip single chars
  return words.join(' ')
}

// ── Internal DB row type ──────────────────────────────────────────────────────

interface ChunkRow {
  id:            number
  doc_id:        string
  doc_name:      string
  chunk_index:   number
  section_title: string | null
  content:       string
}

// ── Retrieval helpers ─────────────────────────────────────────────────────────

/** Lexical retrieval: FTS5 BM25 search scoped to this chat. */
function lexicalSearch(query: string, chatId: string): Array<{ id: number }> {
  const ftsQuery = sanitizeFts5Query(query)
  if (!ftsQuery) return []
  const db = getDB()
  try {
    return db.prepare(`
      SELECT rowid AS id
      FROM   chunks_fts
      WHERE  chunks_fts MATCH ?
        AND  rowid IN (SELECT id FROM rag_chunks WHERE chat_id = ?)
      ORDER  BY rank
      LIMIT  ${K_LEXICAL}
    `).all(ftsQuery, chatId) as Array<{ id: number }>
  } catch {
    return []  // FTS5 syntax error → empty list
  }
}

/** RRF score for a single candidate: Σ 1/(K + rank) over each list it appears in. */
function rfScore(ranks: number[]): number {
  return ranks.reduce((s, r) => s + 1 / (RRF_K + r), 0)
}

/** Fetch full chunk rows by rowid. */
function fetchChunkRows(ids: number[]): Map<number, ChunkRow> {
  if (ids.length === 0) return new Map()
  const db = getDB()
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id, doc_id, doc_name, chunk_index, section_title, content
     FROM   rag_chunks WHERE id IN (${placeholders})`
  ).all(...ids) as ChunkRow[]
  return new Map(rows.map(r => [r.id, r]))
}

/** Fetch a single adjacent chunk (±1) for stitching. Returns null if not found. */
function fetchAdjacentChunk(docId: string, chunkIndex: number, chatId: string): ChunkRow | null {
  const db = getDB()
  return db.prepare(
    `SELECT id, doc_id, doc_name, chunk_index, section_title, content
     FROM   rag_chunks
     WHERE  doc_id = ? AND chunk_index = ? AND chat_id = ?`
  ).get(docId, chunkIndex, chatId) as ChunkRow | null
}

// ── Context envelope builders ─────────────────────────────────────────────────

/**
 * Passage header: "[docName · §sectionTitle · part N]" — §section omitted when null.
 */
function passageHeader(docName: string, sectionTitle: string | null, chunkIndex: number): string {
  const parts = [docName]
  if (sectionTitle) parts.push(`§${sectionTitle}`)
  parts.push(`part ${chunkIndex + 1}`)
  return `[${parts.join(' · ')}]`
}

/**
 * Build the full <attached_file_context> system-message string.
 *
 * Spec §4.6: calm preamble; one envelope for ALL docs (inline first, then passages);
 * no-hit case uses a single honest note; inline text is full with truncation guard.
 */
export function buildContextEnvelope(opts: {
  passages:    RagPassage[]
  noHit:       boolean
  inlineTexts: Array<{ docName: string; text: string }>
  indexedDocNames: string[]  // all indexed doc names in this chat
  contextWindow: number      // for inline truncation cap
}): string {
  const { passages, noHit, inlineTexts, indexedDocNames, contextWindow } = opts
  const inlineBudget = Math.floor(0.5 * contextWindow)

  const sections: string[] = []

  // ── Inline documents (full text, truncated if needed) ─────────────────────
  for (const { docName, text } of inlineTexts) {
    const header = `[${docName} · full document]`
    // Token-budget cap: if combined inline would overflow, truncate with notice
    if (countTokens(text) > inlineBudget) {
      // Approximate char truncation
      const capChars = inlineBudget * 4  // conservative 4 chars/token
      const truncated = text.slice(0, capChars)
      sections.push(`${header}\n${truncated}\n[Note: ${docName} truncated to fit the context window]`)
    } else {
      sections.push(`${header}\n${text}`)
    }
  }

  // ── Retrieved passages (indexed docs) ─────────────────────────────────────
  if (noHit && indexedDocNames.length > 0) {
    const nameList = indexedDocNames.join(', ')
    sections.push(
      `Retrieval found no passages relevant to this question in the attached files (${nameList}). ` +
      `State this honestly if asked about their content.`
    )
  } else if (passages.length > 0) {
    for (const p of passages) {
      sections.push(`${passageHeader(p.docName, p.sectionTitle, p.chunkIndex)}\n${p.content}`)
    }
  }

  if (sections.length === 0) return ''

  const body = sections.join('\n\n')
  if (noHit && inlineTexts.length === 0) {
    // Pure no-hit with no inline: return the note as a bare system message
    return body
  }

  return (
    `<attached_file_context>\n` +
    `The user attached files to this conversation. Relevant passages retrieved for the\n` +
    `current question are below. Treat them as readable file content; cite the file name\n` +
    `when drawing on them. If the passages do not contain the answer, say so.\n\n` +
    `${body}\n` +
    `</attached_file_context>`
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

export type EmbedFn = (text: string) => Promise<number[]>

/**
 * Retrieve the most relevant passages for `query` within `chatId`.
 *
 * Hybrid strategy:
 *   1. Lexical (FTS5 BM25) → up to K_LEXICAL candidates
 *   2. Dense (vec0 KNN, partition key) → up to K_VECTOR candidates,
 *      filtered by VEC_DISTANCE_FLOOR
 *   3. Reciprocal Rank Fusion → top FINAL_K
 *   4. Stitch: each winner gains its ±1 neighbours within CONTEXT_TOKEN_BUDGET
 *   5. Assemble: group by doc, order by chunk_index
 *
 * Returns noHit=true when both candidate lists are empty (never falls back to
 * chronological dump).
 *
 * embedFn is injectable (tests supply a deterministic stub).
 */
export async function retrieve(
  query:   string,
  chatId:  string,
  embedFn?: EmbedFn
): Promise<RagRetrievalResult> {
  const db = getDB()

  // ── 0. Get all indexed doc names for this chat (for no-hit message) ────────
  const docRows = db.prepare(
    `SELECT DISTINCT name FROM documents WHERE chat_id = ? AND mode = 'indexed'`
  ).all(chatId) as Array<{ name: string }>
  const docNames = docRows.map(r => r.name)

  // ── 1. Lexical (FTS5) ──────────────────────────────────────────────────────
  const lexIds = lexicalSearch(query, chatId)
  const lexicalCount = lexIds.length

  // ── 2. Dense (vec KNN) ────────────────────────────────────────────────────
  let vectorIds: Array<{ rowid: number }> = []
  let degradedMode = false

  if (isVecAvailable()) {
    try {
      let resolvedEmbed = embedFn
      if (!resolvedEmbed) {
        const { embed } = await import('../EmbeddingService')
        resolvedEmbed = embed
      }
      const qVecArr = await resolvedEmbed(query)
      const qVec    = new Float32Array(qVecArr)
      const raw     = knn(qVec, K_VECTOR, chatId)
      // Apply distance floor — discard noisy far-away candidates
      vectorIds = raw.filter(r => r.distance <= VEC_DISTANCE_FLOOR)
    } catch {
      degradedMode = true
    }
  }

  const vectorCount = vectorIds.length

  // ── 3. Reciprocal Rank Fusion ─────────────────────────────────────────────
  // No candidates from either list → honest no-hit
  if (lexicalCount === 0 && vectorCount === 0) {
    return {
      hits: [], noHit: true, degradedMode,
      lexicalCount: 0, vectorCount: 0, fusedCount: 0,
      tokensUsed: 0, docNames,
    }
  }

  // Build rank maps
  const lexRankMap  = new Map(lexIds.map((r, i) => [r.id, i]))
  const vecRankMap  = new Map(vectorIds.map((r, i) => [r.rowid, i]))

  // Union of candidate ids
  const allIds = new Set([
    ...lexIds.map(r => r.id),
    ...vectorIds.map(r => r.rowid),
  ])

  const scored: Array<{ id: number; score: number }> = []
  for (const id of allIds) {
    const ranks: number[] = []
    const lex = lexRankMap.get(id)
    const vec = vecRankMap.get(id)
    if (lex !== undefined) ranks.push(lex)
    if (vec !== undefined) ranks.push(vec)
    scored.push({ id, score: rfScore(ranks) })
  }
  scored.sort((a, b) => b.score - a.score)

  const topIds = scored.slice(0, FINAL_K).map(s => s.id)
  const fusedCount = scored.length

  // Fetch full rows for winners
  const chunkMap = fetchChunkRows(topIds)

  // ── 4. Stitch: include ±1 neighbours within token budget ─────────────────
  const includedIds = new Set(topIds)
  const passages: RagPassage[] = []

  for (const { id, score } of scored.slice(0, FINAL_K)) {
    const row = chunkMap.get(id)
    if (!row) continue

    passages.push({
      rowid: row.id, docId: row.doc_id, docName: row.doc_name,
      chunkIndex: row.chunk_index, sectionTitle: row.section_title,
      content: row.content, stitched: false, rrfScore: score,
    })

    // Stitch ±1
    for (const delta of [-1, 1]) {
      const adj = fetchAdjacentChunk(row.doc_id, row.chunk_index + delta, chatId)
      if (adj && !includedIds.has(adj.id)) {
        includedIds.add(adj.id)
        passages.push({
          rowid: adj.id, docId: adj.doc_id, docName: adj.doc_name,
          chunkIndex: adj.chunk_index, sectionTitle: adj.section_title,
          content: adj.content, stitched: true,
        })
      }
    }
  }

  // ── 5. Sort by doc + chunk_index, then apply token budget ─────────────────
  passages.sort((a, b) =>
    a.docName.localeCompare(b.docName) || a.chunkIndex - b.chunkIndex
  )

  let tokensUsed = 0
  const budgetedPassages: RagPassage[] = []
  for (const p of passages) {
    const t = countTokens(p.content)
    if (tokensUsed + t > CONTEXT_TOKEN_BUDGET && budgetedPassages.length > 0) break
    budgetedPassages.push(p)
    tokensUsed += t
  }

  return {
    hits: budgetedPassages,
    noHit: false,
    degradedMode,
    lexicalCount,
    vectorCount,
    fusedCount,
    tokensUsed,
    docNames,
  }
}
