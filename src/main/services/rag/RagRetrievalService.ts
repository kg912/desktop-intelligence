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
import type {
  RagRetrievalResult, RagPassage, RagQueryTrace,
  RagTraceLexicalEntry, RagTraceVectorEntry, RagTraceFusedEntry,
  RagTraceRerankEntry, RagTraceAllocationEntry, RagAllocationDecision,
} from '../../../shared/types'
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
      `The following document(s) are attached to this conversation: ${nameList}. ` +
      `No passages directly relevant to this question were found — the user may need to ask something more specific about the document content.`
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
 * Options for retrieve() — all optional; omitting them is byte-identical to
 * the pre-Phase-4 behaviour.
 */
export interface RetrieveOptions {
  /** Force a single retrieval mode, bypassing the hybrid default. */
  forceMode?: 'lexical' | 'vector' | 'hybrid'
  /** Override the rerankEnabled setting from SettingsStore (eval harness use). */
  rerankOverride?: boolean
  /**
   * When true, attach a full RagQueryTrace to the result.
   * Zero-cost when false — no string building occurs.
   */
  captureTrace?: boolean
}

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
 *
 * options (5th param) is fully optional — omitting it is byte-identical to
 * the pre-Phase-4 call signature.
 */
export async function retrieve(
  query:    string,
  chatId:   string,
  embedFn?: EmbedFn,
  scoreFn?: RerankerScoreFn,
  options?: RetrieveOptions
): Promise<RagRetrievalResult> {
  const db = getDB()
  const captureTrace = options?.captureTrace === true
  const forceMode    = options?.forceMode ?? 'hybrid'

  // ── 0. Get all indexed doc names for this chat (for no-hit message) ────────
  const docRows = db.prepare(
    `SELECT DISTINCT name FROM documents WHERE chat_id = ? AND mode = 'indexed'`
  ).all(chatId) as Array<{ name: string }>
  const docNames = docRows.map(r => r.name)

  // ── 1. Lexical (FTS5) ──────────────────────────────────────────────────────
  const sanitizedFts = sanitizeFts5Query(query)

  // lexicalSearchRaw: returns {id, rank} with the BM25 rank value
  function lexicalSearchWithRank(q: string, cId: string): Array<{ id: number; rank: number }> {
    if (!q) return []
    try {
      return db.prepare(`
        SELECT rowid AS id, rank
        FROM   chunks_fts
        WHERE  chunks_fts MATCH ?
          AND  rowid IN (SELECT id FROM rag_chunks WHERE chat_id = ?)
        ORDER  BY rank
        LIMIT  ${K_LEXICAL}
      `).all(q, cId) as Array<{ id: number; rank: number }>
    } catch {
      return []
    }
  }

  const skipLexical = forceMode === 'vector'
  const lexRaw = skipLexical ? [] : lexicalSearchWithRank(sanitizedFts, chatId)
  const lexIds = lexRaw.map(r => ({ id: r.id }))
  const lexicalCount = lexIds.length

  // ── 2. Dense (vec KNN) ────────────────────────────────────────────────────
  // raw vector results before floor filtering (needed for trace dropped candidates)
  let vectorIdsRaw: Array<{ rowid: number; distance: number }> = []
  let vectorIds: Array<{ rowid: number }> = []
  let degradedMode = false

  const skipVector = forceMode === 'lexical'

  if (!skipVector && isVecAvailable()) {
    try {
      let resolvedEmbed = embedFn
      if (!resolvedEmbed) {
        const { embed } = await import('../EmbeddingService')
        resolvedEmbed = embed
      }
      const qVecArr = await resolvedEmbed(query)
      const qVec    = new Float32Array(qVecArr)
      vectorIdsRaw  = knn(qVec, K_VECTOR, chatId)
      // Apply distance floor — discard noisy far-away candidates
      vectorIds = vectorIdsRaw.filter(r => r.distance <= VEC_DISTANCE_FLOOR)
    } catch {
      degradedMode = true
    }
  } else if (skipVector) {
    // forceMode='lexical' — never call embedFn
    vectorIdsRaw = []
    vectorIds    = []
  }

  const vectorCount = vectorIds.length

  // ── 3. Reciprocal Rank Fusion ─────────────────────────────────────────────
  // No candidates from either list → honest no-hit
  if (lexicalCount === 0 && vectorCount === 0) {
    const result: RagRetrievalResult = {
      hits: [], noHit: true, degradedMode,
      lexicalCount: 0, vectorCount: 0, fusedCount: 0,
      tokensUsed: 0, docNames, rerankUsed: false,
    }
    if (captureTrace) {
      result.trace = _buildTrace({
        query, sanitizedFtsQuery: sanitizedFts, chatId,
        mode: forceMode === 'hybrid' ? 'hybrid' : forceMode,
        rerankUsed: false,
        lexRaw, vectorIdsRaw, vectorIds, db,
        scored: [], orderedCandidates: [], admittedWinners: [],
        stitchAttempts: [], passages: [],
        rerankEntries: null, rerankMs: undefined,
        tokensUsed: 0,
      })
    }
    return result
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
  const settings    = readSettings()
  const doRerank    = options?.rerankOverride !== undefined
    ? options.rerankOverride
    : (settings.rerankEnabled ?? false)

  let rerankUsed = false
  let rerankMs: number | undefined
  let rerankEntries: RagTraceRerankEntry[] | null = null

  type Candidate = { id: number; rrfScore: number; rerankScore?: number }
  let orderedCandidates: Candidate[]

  if (doRerank) {
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
      rerankMs   = Date.now() - t0
      rerankUsed = true

      if (captureTrace) {
        rerankEntries = reranked.map(r => ({ rowid: r.rowid, rerankScore: r.score }))
      }

      orderedCandidates = reranked.slice(0, FINAL_K_RERANKED).map(r => ({
        id:          r.rowid,
        rrfScore:    scored.find(s => s.id === r.rowid)?.score ?? 0,
        rerankScore: r.score,
      }))
    } catch (err) {
      console.warn('[RAG] ⚠️ Rerank failed, falling back to RRF order:', err)
      orderedCandidates = scored.slice(0, FINAL_K).map(s => ({ id: s.id, rrfScore: s.score }))
      rerankUsed = false
    }
  } else {
    orderedCandidates = scored.slice(0, FINAL_K).map(s => ({ id: s.id, rrfScore: s.score }))
  }

  // Fetch full rows for the chosen winner set
  const chunkMap = fetchChunkRows(orderedCandidates.map(c => c.id))

  // ── 4. Priority-ordered budget allocation ────────────────────────────────────
  let tokensUsed = 0

  // Pass 1 — winners
  const admittedWinners: Array<{ row: ChunkRow; rrfScore: number; rerankScore?: number }> = []
  // Track candidates skipped for "too big" (for trace)
  const skippedTooBig = new Set<number>()
  for (const { id, rrfScore, rerankScore } of orderedCandidates) {
    const row = chunkMap.get(id)
    if (!row) continue
    const t = countTokens(row.content)
    if (tokensUsed + t > CONTEXT_TOKEN_BUDGET && admittedWinners.length > 0) {
      skippedTooBig.add(id)
      continue
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

  const includedIds = new Set<number>(admittedWinners.map(w => w.row.id))

  // Track stitch attempts for trace
  const stitchAttempts: Array<{ row: ChunkRow; admitted: boolean }> = []

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
          if (captureTrace) stitchAttempts.push({ row: adj, admitted: true })
        } else {
          if (captureTrace) stitchAttempts.push({ row: adj, admitted: false })
        }
      }
    }
  }

  // ── 5. Sort admitted passages for presentation ────────────────────────────
  passages.sort((a, b) =>
    a.docName.localeCompare(b.docName) || a.chunkIndex - b.chunkIndex
  )

  console.log(
    `[RAG] retrieve: lex=${lexicalCount} vec=${vectorCount} fused=${fusedCount}` +
    ` hits=${passages.filter(p => !p.stitched).length}+${passages.filter(p => p.stitched).length}stitched` +
    ` tokens=${tokensUsed} rerankUsed=${rerankUsed}` +
    (rerankMs != null ? ` rerankMs=${rerankMs}` : '')
  )

  const result: RagRetrievalResult = {
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

  if (captureTrace) {
    result.trace = _buildTrace({
      query, sanitizedFtsQuery: sanitizedFts, chatId,
      mode: forceMode === 'hybrid' ? 'hybrid' : forceMode,
      rerankUsed, rerankEntries, rerankMs,
      lexRaw, vectorIdsRaw, vectorIds, db,
      scored, orderedCandidates, admittedWinners, skippedTooBig,
      stitchAttempts, passages, tokensUsed,
    })
  }

  return result
}

// ── Trace assembly ────────────────────────────────────────────────────────────

interface TraceInput {
  query:             string
  sanitizedFtsQuery: string
  chatId:            string
  mode:              'lexical' | 'vector' | 'hybrid'
  rerankUsed:        boolean
  rerankEntries:     RagTraceRerankEntry[] | null
  rerankMs?:         number
  lexRaw:            Array<{ id: number; rank: number }>
  vectorIdsRaw:      Array<{ rowid: number; distance: number }>
  vectorIds:         Array<{ rowid: number }>
  db:                ReturnType<typeof getDB>
  scored:            Array<{ id: number; score: number }>
  orderedCandidates: Array<{ id: number; rrfScore: number; rerankScore?: number }>
  admittedWinners:   Array<{ row: { id: number; doc_name: string; chunk_index: number; content: string } }>
  skippedTooBig?:    Set<number>
  stitchAttempts?:   Array<{ row: { id: number; content: string }; admitted: boolean }>
  passages:          RagPassage[]
  tokensUsed:        number
}

function _buildTrace(t: TraceInput): RagQueryTrace {
  // Lexical entries
  const lexical: RagTraceLexicalEntry[] = t.lexRaw.map((r, idx) => {
    const row = t.db.prepare(
      'SELECT doc_name, chunk_index, content FROM rag_chunks WHERE id = ?'
    ).get(r.id) as { doc_name: string; chunk_index: number; content: string } | undefined
    return {
      rowid:          r.id,
      rank:           idx,
      docName:        row?.doc_name ?? '',
      chunkIndex:     row?.chunk_index ?? 0,
      contentPreview: (row?.content ?? '').slice(0, 200),
    }
  })

  // Vector entries — include ALL raw results (dropped ones have dropped:true)
  const droppedSet = new Set(
    t.vectorIdsRaw
      .filter(r => !t.vectorIds.some(v => v.rowid === r.rowid))
      .map(r => r.rowid)
  )
  const vector: RagTraceVectorEntry[] = t.vectorIdsRaw.map(r => {
    const row = t.db.prepare(
      'SELECT doc_name, chunk_index, content FROM rag_chunks WHERE id = ?'
    ).get(r.rowid) as { doc_name: string; chunk_index: number; content: string } | undefined
    return {
      rowid:          r.rowid,
      distance:       r.distance,
      cosineSim:      1 - (r.distance * r.distance) / 2,
      docName:        row?.doc_name ?? '',
      chunkIndex:     row?.chunk_index ?? 0,
      contentPreview: (row?.content ?? '').slice(0, 200),
      dropped:        droppedSet.has(r.rowid),
    }
  })

  // Fused entries
  const lexSet = new Set(t.lexRaw.map(r => r.id))
  const vecSet = new Set(t.vectorIds.map(r => r.rowid))
  const fused: RagTraceFusedEntry[] = t.scored.map(s => ({
    rowid:     s.id,
    rrfScore:  s.score,
    inLexical: lexSet.has(s.id),
    inVector:  vecSet.has(s.id),
  }))

  // Allocation decisions
  const admittedWinnerIds   = new Set(t.admittedWinners.map(w => w.row.id))
  const skippedTooBigIds    = t.skippedTooBig ?? new Set<number>()
  const stitchedIds         = new Set(
    (t.stitchAttempts ?? []).filter(s => s.admitted).map(s => s.row.id)
  )
  const stitchRejectedIds   = new Set(
    (t.stitchAttempts ?? []).filter(s => !s.admitted).map(s => s.row.id)
  )

  const allocation: RagTraceAllocationEntry[] = []

  // All ordered candidates
  for (const c of t.orderedCandidates) {
    const row = t.db.prepare('SELECT content FROM rag_chunks WHERE id = ?')
      .get(c.id) as { content: string } | undefined
    const tokens = row ? countTokens(row.content) : 0
    let decision: RagAllocationDecision
    if (admittedWinnerIds.has(c.id)) decision = 'admitted'
    else if (skippedTooBigIds.has(c.id)) decision = 'skipped_too_big'
    else decision = 'not_reached'
    allocation.push({ rowid: c.id, decision, tokens })
  }

  // Stitch attempts
  for (const s of (t.stitchAttempts ?? [])) {
    const tokens = countTokens(s.row.content)
    allocation.push({
      rowid:    s.row.id,
      decision: s.admitted ? 'stitched' : 'stitch_rejected_budget',
      tokens,
    })
  }

  // Final passages — full decoded content of admitted non-stitched + stitched
  const finalPassages: string[] = t.passages.map(p => {
    const header = passageHeader(p.docName, p.sectionTitle, p.chunkIndex)
    return `${header}\n${p.content}`
  })

  return {
    query:             t.query,
    sanitizedFtsQuery: t.sanitizedFtsQuery,
    chatId:            t.chatId,
    timestamp:         new Date().toISOString(),
    mode:              t.mode,
    rerankUsed:        t.rerankUsed,
    lexical,
    vector,
    fused,
    rerank:            t.rerankEntries,
    rerankMs:          t.rerankMs,
    allocation,
    finalPassages,
    envelopeTokens:    t.tokensUsed,
  }
}
