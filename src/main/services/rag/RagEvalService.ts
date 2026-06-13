/**
 * RagEvalService — ground-truth evaluation harness for the RAG pipeline.
 *
 * Phase 4: purely unit-testable metric functions + runEval() that drives
 * retrieve() across four modes and writes an ablation markdown report.
 *
 * Eval file format (JSONL): each line is a JSON object:
 *   { "query": string, "relevant": string[], "note"?: string }
 *
 * A chunk is RELEVANT to a query iff its content contains ANY of the
 * `relevant` substrings after normalization (lowercase, collapse whitespace).
 *
 * Example eval.jsonl line:
 *   {"query":"how does L2 regularization prevent overfitting","relevant":["L2 regularization penalises","weight decay"]}
 */

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { getDB } from '../DatabaseService'
import { retrieve } from './RagRetrievalService'
import type { EmbedFn } from './RagRetrievalService'
import type { RerankerScoreFn } from './RerankerService'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EvalQuery {
  query:     string
  relevant:  string[]
  note?:     string
}

export interface EvalModeResult {
  mode:        string
  hitAtK:      number
  precisionAtK: number
  recallAtK:   number
  mrr:         number
  candidateRecall: number  // recall at the candidate stage (before budget allocation)
}

export interface EvalQueryResult {
  query:        string
  note?:        string
  relevantCount: number
  modes:        EvalModeResult[]
  status:       'ok' | 'unresolvable'
  unresolvableNote?: string
}

export interface EvalReport {
  evalFile:    string
  chatId:      string
  timestamp:   string
  queryCount:  number
  resolvedCount: number
  aggregates:  EvalModeResult[]
  perQuery:    EvalQueryResult[]
}

// ── Text normalization ────────────────────────────────────────────────────────

/**
 * Normalize text for relevance matching:
 * lowercase, collapse whitespace to single space, trim.
 */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Returns true if `content` contains ANY of the `snippets` after normalization.
 * An empty snippets array → always false (unresolvable query).
 */
export function isRelevant(content: string, snippets: string[]): boolean {
  if (snippets.length === 0) return false
  const norm = normalizeForMatch(content)
  return snippets.some(s => norm.includes(normalizeForMatch(s)))
}

// ── Pure metric functions ─────────────────────────────────────────────────────

/**
 * Precision@K: fraction of the top-K ranked results that are relevant.
 * Returns 0 if rankedRowids is empty.
 */
export function precisionAtK(
  rankedRowids:     number[],
  relevantRowidSet: Set<number>,
  k:                number
): number {
  if (rankedRowids.length === 0 || k === 0) return 0
  const topK = rankedRowids.slice(0, k)
  const hits  = topK.filter(id => relevantRowidSet.has(id)).length
  return hits / Math.min(k, rankedRowids.length)
}

/**
 * Recall@K: fraction of all relevant items found in the top-K results.
 * Returns 0 when relevantRowidSet is empty.
 */
export function recallAtK(
  rankedRowids:     number[],
  relevantRowidSet: Set<number>,
  k:                number
): number {
  if (relevantRowidSet.size === 0) return 0
  const topK = rankedRowids.slice(0, k)
  const hits  = topK.filter(id => relevantRowidSet.has(id)).length
  return hits / relevantRowidSet.size
}

/**
 * Mean Reciprocal Rank: 1/rank of the first relevant item, or 0 if none.
 */
export function mrr(
  rankedRowids:     number[],
  relevantRowidSet: Set<number>
): number {
  for (let i = 0; i < rankedRowids.length; i++) {
    if (relevantRowidSet.has(rankedRowids[i])) return 1 / (i + 1)
  }
  return 0
}

/**
 * Hit@K: 1 if any relevant item appears in the top-K, 0 otherwise.
 */
export function hitRate(
  rankedRowids:     number[],
  relevantRowidSet: Set<number>,
  k:                number
): number {
  const topK = rankedRowids.slice(0, k)
  return topK.some(id => relevantRowidSet.has(id)) ? 1 : 0
}

// ── Relevant rowid resolution ─────────────────────────────────────────────────

/**
 * Scan rag_chunks for this chat and return the set of rowids whose content
 * matches any of the given snippets (normalized substring match).
 */
export function resolveRelevantRowids(
  chatId:   string,
  snippets: string[]
): Set<number> {
  if (snippets.length === 0) return new Set()
  const db = getDB()
  const rows = db.prepare(
    'SELECT id, content FROM rag_chunks WHERE chat_id = ?'
  ).all(chatId) as Array<{ id: number; content: string }>

  const relevant = new Set<number>()
  for (const row of rows) {
    if (isRelevant(row.content, snippets)) {
      relevant.add(row.id)
    }
  }
  return relevant
}

// ── Run eval ─────────────────────────────────────────────────────────────────

const K = 6            // evaluation k (matches FINAL_K default)
const K_CANDIDATE = 20 // candidate pool cap for candidateRecall

/**
 * Run the evaluation harness against a JSONL eval file.
 *
 * For each query, retrieve across four modes:
 *   lexical-only, vector-only, hybrid (default), hybrid+rerank
 * Records candidate-stage recall, Hit@K, Precision@K, Recall@K, MRR.
 *
 * Writes a markdown report to Downloads/rag-eval-<timestamp>.md.
 * Returns the full EvalReport (also emits a rag_eval observability event).
 *
 * embedFn and scoreFn are injectable for tests.
 */
export async function runEval(
  evalFilePath: string,
  chatId:       string,
  embedFn?:     EmbedFn,
  scoreFn?:     RerankerScoreFn
): Promise<EvalReport> {
  // Parse JSONL
  const rawLines = fs.readFileSync(evalFilePath, 'utf8')
    .split('\n')
    .filter(l => l.trim())

  const queries: EvalQuery[] = rawLines.map((line, idx) => {
    try { return JSON.parse(line) as EvalQuery }
    catch { throw new Error(`eval file line ${idx + 1}: invalid JSON — ${line}`) }
  })

  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-')
  const perQuery:  EvalQueryResult[] = []
  const modeNames  = ['lexical-only', 'vector-only', 'hybrid', 'hybrid+rerank']

  // Aggregate accumulators
  const aggSums: Record<string, { hit: number; prec: number; rec: number; mrr: number; candRec: number; n: number }> = {}
  for (const m of modeNames) aggSums[m] = { hit: 0, prec: 0, rec: 0, mrr: 0, candRec: 0, n: 0 }

  for (const q of queries) {
    const relevantSet = resolveRelevantRowids(chatId, q.relevant)

    if (relevantSet.size === 0) {
      perQuery.push({
        query:        q.query,
        note:         q.note,
        relevantCount: 0,
        modes:        [],
        status:       'unresolvable',
        unresolvableNote: 'no chunks matched any relevant snippet — check snippet text',
      })
      continue
    }

    const modes: EvalModeResult[] = []

    for (const modeName of modeNames) {
      const isRerank = modeName === 'hybrid+rerank'
      const forceMode = modeName === 'lexical-only' ? 'lexical'
        : modeName === 'vector-only' ? 'vector'
        : 'hybrid'

      let result
      try {
        result = await retrieve(q.query, chatId, embedFn, scoreFn, {
          forceMode:      forceMode as 'lexical' | 'vector' | 'hybrid',
          rerankOverride: isRerank,
          captureTrace:   true,
        })
      } catch {
        modes.push({
          mode:            modeName,
          hitAtK:          0,
          precisionAtK:    0,
          recallAtK:       0,
          mrr:             0,
          candidateRecall: 0,
        })
        continue
      }

      const trace = result.trace!

      // Admitted winners in priority order: rerank order when reranking, else RRF order.
      // Stitched neighbours are excluded — they are context fillers, not ranked results.
      const admittedOrdered: number[] = trace.allocation
        .filter(a => a.decision === 'admitted')
        .map(a => a.rowid)

      // Candidate pool for candidateRecall: the retrieval stage before FINAL_K/budget
      // allocation.  A chunk here but NOT in admittedOrdered means the retriever FOUND
      // it but budget/FINAL_K dropped it — i.e. an allocation failure, not a retrieval
      // failure.  Capped at K_CANDIDATE (20) per mode.
      let candidateRowids: number[]
      if (modeName === 'lexical-only') {
        candidateRowids = trace.lexical.slice(0, K_CANDIDATE).map(e => e.rowid)
      } else if (modeName === 'vector-only') {
        candidateRowids = trace.vector.filter(e => !e.dropped).slice(0, K_CANDIDATE).map(e => e.rowid)
      } else {
        // hybrid / hybrid+rerank: fused entries are already in RRF-desc order
        candidateRowids = trace.fused.slice(0, K_CANDIDATE).map(e => e.rowid)
      }
      const candRecall = relevantSet.size === 0 ? 0
        : candidateRowids.filter(id => relevantSet.has(id)).length / relevantSet.size

      const hit  = hitRate(admittedOrdered, relevantSet, K)
      const prec = precisionAtK(admittedOrdered, relevantSet, K)
      const rec  = recallAtK(admittedOrdered, relevantSet, K)
      const m    = mrr(admittedOrdered, relevantSet)

      modes.push({
        mode:            modeName,
        hitAtK:          hit,
        precisionAtK:    prec,
        recallAtK:       rec,
        mrr:             m,
        candidateRecall: candRecall,
      })

      // Accumulate
      aggSums[modeName].hit     += hit
      aggSums[modeName].prec    += prec
      aggSums[modeName].rec     += rec
      aggSums[modeName].mrr     += m
      aggSums[modeName].candRec += candRecall
      aggSums[modeName].n++
    }

    perQuery.push({
      query:         q.query,
      note:          q.note,
      relevantCount: relevantSet.size,
      modes,
      status:        'ok',
    })
  }

  const resolvedCount = perQuery.filter(r => r.status === 'ok').length

  const aggregates: EvalModeResult[] = modeNames.map(m => {
    const s = aggSums[m]
    const n = s.n || 1
    return {
      mode:            m,
      hitAtK:          Math.round((s.hit / n) * 1000) / 1000,
      precisionAtK:    Math.round((s.prec / n) * 1000) / 1000,
      recallAtK:       Math.round((s.rec / n) * 1000) / 1000,
      mrr:             Math.round((s.mrr / n) * 1000) / 1000,
      candidateRecall: Math.round((s.candRec / n) * 1000) / 1000,
    }
  })

  const report: EvalReport = {
    evalFile:     evalFilePath,
    chatId,
    timestamp:    new Date().toISOString(),
    queryCount:   queries.length,
    resolvedCount,
    aggregates,
    perQuery,
  }

  // Write markdown report to Downloads
  const mdPath = path.join(app.getPath('downloads'), `rag-eval-${timestamp}.md`)
  fs.writeFileSync(mdPath, _buildEvalMarkdown(report), 'utf8')
  console.log(`[RagEval] Report written to ${mdPath}`)

  // Emit observability event
  try {
    const { observabilityService } = await import('../ObservabilityService')
    observabilityService.emitRagEvent({
      type: 'rag_eval',
      ts:   Date.now(),
      payload: {
        evalFile:     evalFilePath,
        chatId,
        queryCount:   queries.length,
        resolvedCount,
        aggregates,
        reportPath:   mdPath,
      },
    })
  } catch { /* non-fatal */ }

  return report
}

// ── Markdown report builder ───────────────────────────────────────────────────

function _buildEvalMarkdown(r: EvalReport): string {
  const lines: string[] = []

  lines.push('# RAG Evaluation Report')
  lines.push('')
  lines.push(`**Eval file:** \`${r.evalFile}\``)
  lines.push(`**Chat ID:** \`${r.chatId}\``)
  lines.push(`**Timestamp:** ${r.timestamp}`)
  lines.push(`**Queries:** ${r.queryCount} total / ${r.resolvedCount} resolved`)
  lines.push('')
  lines.push('## Ablation Table (averages over resolved queries)')
  lines.push('')
  lines.push('| Mode | Hit@K | Precision@K | Recall@K | MRR | Candidate Recall |')
  lines.push('|---|---|---|---|---|---|')
  for (const m of r.aggregates) {
    lines.push(
      `| ${m.mode} | ${m.hitAtK} | ${m.precisionAtK} | ${m.recallAtK} | ${m.mrr} | ${m.candidateRecall} |`
    )
  }
  lines.push('')
  lines.push('> **Interpreting the ablation table:**')
  lines.push('> - **Hit@K** — did any relevant chunk appear in the top-K final results?')
  lines.push('> - **Precision@K** — what fraction of the top-K were relevant?')
  lines.push('> - **Recall@K** — what fraction of all relevant chunks were in the top-K?')
  lines.push('> - **MRR** — mean reciprocal rank of the first relevant result (1.0 = always first).')
  lines.push('> - **Candidate Recall** — fraction of relevant chunks that entered the top-20 candidate pool')
  lines.push('>   (before FINAL_K / budget allocation). Ranked in retrieval order, NOT presentation order.')
  lines.push('>   `CandRec=1.0` + `Recall@K=0.0` ⇒ retrieval found it, FINAL_K/budget dropped it ⇒')
  lines.push('>   raise `FINAL_K` or `CONTEXT_TOKEN_BUDGET` to surface it. `CandRec=0.0` ⇒ true')
  lines.push('>   retrieval miss ⇒ check embedding quality or add lexical synonyms.')
  lines.push('> - If vector-only recall ≫ lexical-only: queries use paraphrasing that BM25 misses.')
  lines.push('> - If lexical-only recall ≫ vector-only: queries use exact identifiers/rare tokens.')
  lines.push('> - hybrid should dominate both; +rerank should improve MRR/Precision over hybrid.')
  lines.push('')
  lines.push('## Per-Query Results')
  lines.push('')

  for (const q of r.perQuery) {
    lines.push(`### "${q.query}"`)
    if (q.note) lines.push(`> *${q.note}*`)
    lines.push('')
    if (q.status === 'unresolvable') {
      lines.push(`⚠️ **Unresolvable** — ${q.unresolvableNote}`)
      lines.push('')
      continue
    }
    lines.push(`Relevant chunks found in corpus: **${q.relevantCount}**`)
    lines.push('')
    lines.push('| Mode | Hit@K | P@K | R@K | MRR | CandRec |')
    lines.push('|---|---|---|---|---|---|')
    for (const m of q.modes) {
      lines.push(
        `| ${m.mode} | ${m.hitAtK} | ${m.precisionAtK} | ${m.recallAtK} | ${m.mrr} | ${m.candidateRecall} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}
