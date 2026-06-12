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
import { readSettings } from '../SettingsStore'
import type { RagRetrievalResult, RagPassage } from '../../../shared/types'
import type { RerankerScoreFn } from './RerankerService'

export type { RagRetrievalResult, RagPassage }
export type { RerankerScoreFn }

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum lexical (FTS5 BM25) candidates to retrieve. */
export const K_LEXICAL = 20

/** Maximum vector (KNN) candidates to retrieve. */
export const K_VECTOR = 20

/** RRF smoothing constant — industry default. */
export const RRF_K = 60

/** Number of fused candidates to carry into the stitch + assembly step (rerank OFF). */
export const FINAL_K = 6

/**
 * Number of fused candidates passed to the cross-encoder when rerankEnabled=true.
 * A wider candidate pool gives the reranker more to work with.
 */
export const RERANK_CANDIDATES = 20

/**
 * Number of rerank winners carried into budget allocation (replaces FINAL_K when
 * rerankEnabled=true).  More winners because the reranker has a larger pool to draw from.
 */
export const FINAL_K_RERANKED = 8

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

  // ── Inline documents (cumulative token accounting) ───────────────────────
  // Track COMBINED tokens across all inline docs against floor(0.5 × contextWindow).
  // When the cap is crossed mid-doc, truncate THAT doc at the remaining budget
  // and mark the cap exhausted. Subsequent docs are replaced by a single omit note.
  let cumulativeInlineTokens = 0
  let inlineBudgetExhausted = false

  for (const { docName, text } of inlineTexts) {
    const header = `[${docName} · full document]`

    if (inlineBudgetExhausted) {
      // All docs after the cap is crossed are omitted entirely
      sections.push(`[Note: ${docName} omitted to fit the context window]`)
      continue
    }

    const docTokens = countTokens(text)
    const remaining = inlineBudget - cumulativeInlineTokens

    if (docTokens <= remaining) {
      // Full doc fits within remaining combined budget
      sections.push(`${header}\n${text}`)
      cumulativeInlineTokens += docTokens
    } else if (remaining > 0) {
      // Partial fit — truncate at remaining budget (char approximation)
      const capChars = remaining * 4  // conservative 4 chars/token
      const truncated = text.slice(0, capChars)
      sections.push(`${header}\n${truncated}\n[Note: ${docName} truncated to fit the context window]`)
      cumulativeInlineTokens = inlineBudget
      inlineBudgetExhausted = true
    } else {
      // No remaining budget — omit entirely
      sections.push(`[Note: ${docName} omitted to fit the context window]`)
      inlineBudgetExhausted = true
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
    `The user attached files to this conversation. Their content (full documents\n` +
    `and/or passages retrieved for the current question) is below. Treat it as\n` +
    `readable file content; cite the file name when drawing on it. If it does not\n` +
    `contain the answer, say so.\n\n` +
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
 *   3. Reciprocal Rank Fusion → top candidates
 *   3.5 (optional) Cross-encoder rerank when settings.rerankEnabled=true
 *   4. Priority-ordered budget allocation (pass 1: winners, pass 2: stitches)
 *   5. Sort for presentation: docName + chunk_index
 *
 * Returns noHit=true when both candidate lists are empty (never falls back to
 * chronological dump).
 *
 * embedFn and scoreFn are injectable — tests supply deterministic stubs so
 * neither the embedding model nor the reranker model is ever downloaded.
 */
export async function retrieve(
  query:    string,
  chatId:   string,
  embedFn?: EmbedFn,
  scoreFn?: RerankerScoreFn
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
      tokensUsed: 0, docNames, rerankUsed: false,
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

  const fusedCount = scored.length

  // ── 3.5 Optional cross-encoder rerank ────────────────────────────────────────
  // When rerankEnabled=true: take the top RERANK_CANDIDATES from RRF, re-score
  // them with the cross-encoder, then carry the top FINAL_K_RERANKED into
  // budget allocation (replacing the plain FINAL_K RRF path).
  //
  // Fallback rule: ANY error in the rerank step logs one [RAG] warning and falls
  // back to the EXACT pure-RRF code path used when the flag is off — the budget
  // allocation below is shared code, parameterised by `orderedCandidates` only.
  //
  // Fire-and-forget warm-up fires at the START of the rerank branch so the model
  // is resident in memory for the NEXT call (the current call initialises it
  // serially below if needed).

  const settings = readSettings()
  let rerankUsed = false
  let rerankMs: number | undefined

  // orderedCandidates: chunks to allocate against, in priority order (highest first)
  type Candidate = { id: number; rrfScore: number; rerankScore?: number }
  let orderedCandidates: Candidate[]

  if (settings.rerankEnabled) {
    // Fire-and-forget: warm up the model for the next query
    void import('./RerankerService').then(m => m.ensureRerankerReady()).catch(() => {})

    try {
      const reCandIds = scored.slice(0, RERANK_CANDIDATES).map(s => s.id)
      const reCandMap = fetchChunkRows(reCandIds)
      const rePassages = reCandIds
        .map(id => reCandMap.get(id))
        .filter((r): r is ChunkRow => r != null)
        .map(r => ({ rowid: r.id, content: r.content }))

      const { rerank } = await import('./RerankerService')
      const t0 = Date.now()
      const reranked = await rerank(query, rePassages, scoreFn)
      rerankMs  = Date.now() - t0
      rerankUsed = true

      orderedCandidates = reranked.slice(0, FINAL_K_RERANKED).map(r => ({
        id:          r.rowid,
        rrfScore:    scored.find(s => s.id === r.rowid)?.score ?? 0,
        rerankScore: r.score,
      }))
    } catch (err) {
      console.warn('[RAG] ⚠️ Rerank failed, falling back to RRF order:', err)
      // Fall through to the exact same code path as rerankEnabled=false
      orderedCandidates = scored.slice(0, FINAL_K).map(s => ({ id: s.id, rrfScore: s.score }))
      rerankUsed = false
    }
  } else {
    // Pure-RRF path (default) — byte-identical to pre-Phase-3 behaviour
    orderedCandidates = scored.slice(0, FINAL_K).map(s => ({ id: s.id, rrfScore: s.score }))
  }

  // Fetch full rows for the chosen winner set
  const chunkMap = fetchChunkRows(orderedCandidates.map(c => c.id))

  // ── 4. Priority-ordered budget allocation ────────────────────────────────────
  //
  // Shared code path — orderedCandidates drives priority regardless of whether
  // they came from RRF or rerank.  This guarantees no logic drift between modes.
  //
  // Pass 1 — winners (descending priority order):
  //   • The very first winner is always admitted regardless of size.
  //   • Any subsequent winner that does not fit is SKIPPED with `continue` —
  //     a smaller winner later in the list may still fit.
  //
  // Pass 2 — stitches (fills remaining budget only):
  //   • For each admitted winner, attempt its ±1 neighbours.
  //   • A neighbour is added only if it fits within the remaining budget.
  //   • Guarantee: stitched neighbours can NEVER displace an un-admitted winner
  //     because all winners are decided before any stitch is attempted.

  let tokensUsed = 0

  // Pass 1 — winners
  const admittedWinners: Array<{ row: ChunkRow; rrfScore: number; rerankScore?: number }> = []
  for (const { id, rrfScore, rerankScore } of orderedCandidates) {
    const row = chunkMap.get(id)
    if (!row) continue
    const t = countTokens(row.content)
    if (tokensUsed + t > CONTEXT_TOKEN_BUDGET && admittedWinners.length > 0) {
      continue  // too large for current budget; try the next winner
    }
    admittedWinners.push({ row, rrfScore, rerankScore })
    tokensUsed += t
  }

  // Seed passages with admitted winners
  const passages: RagPassage[] = admittedWinners.map(({ row, rrfScore, rerankScore }) => ({
    rowid: row.id, docId: row.doc_id, docName: row.doc_name,
    chunkIndex: row.chunk_index, sectionTitle: row.section_title,
    content: row.content, stitched: false, rrfScore,
    ...(rerankScore !== undefined && { rerankScore }),
  }))

  // Track all admitted ids to prevent duplicates (includes winners so a
  // top-k chunk is not re-added as a neighbour stitch of another winner).
  const includedIds = new Set<number>(admittedWinners.map(w => w.row.id))

  // Pass 2 — stitches
  for (const { row } of admittedWinners) {
    for (const delta of [-1, 1]) {
      const adj = fetchAdjacentChunk(row.doc_id, row.chunk_index + delta, chatId)
      if (adj && !includedIds.has(adj.id)) {
        const t = countTokens(adj.content)
        if (tokensUsed + t <= CONTEXT_TOKEN_BUDGET) {
          includedIds.add(adj.id)
          passages.push({
            rowid: adj.id, docId: adj.doc_id, docName: adj.doc_name,
            chunkIndex: adj.chunk_index, sectionTitle: adj.section_title,
            content: adj.content, stitched: true,
          })
          tokensUsed += t
        }
      }
    }
  }

  // ── 5. Sort admitted passages for presentation ────────────────────────────
  // Budget allocation above is by priority; sorting is for readability only.
  passages.sort((a, b) =>
    a.docName.localeCompare(b.docName) || a.chunkIndex - b.chunkIndex
  )

  console.log(
    `[RAG] retrieve: lex=${lexicalCount} vec=${vectorCount} fused=${fusedCount}` +
    ` hits=${passages.filter(p => !p.stitched).length}+${passages.filter(p => p.stitched).length}stitched` +
    ` tokens=${tokensUsed} rerankUsed=${rerankUsed}` +
    (rerankMs != null ? ` rerankMs=${rerankMs}` : '')
  )

  return {
    hits: passages,
    noHit: false,
    degradedMode,
    lexicalCount,
    vectorCount,
    fusedCount,
    tokensUsed,
    docNames,
    rerankUsed,
    rerankMs,
  }
}
