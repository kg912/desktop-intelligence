/**
 * RerankerService — cross-encoder reranking for RAG v2 Phase 3.
 *
 * Lazy-initialised jinaai/jina-reranker-v1-tiny-en pipeline.
 * First call triggers a one-time model download (~7 MB) to app userData/models.
 * Subsequent calls reuse the cached pipeline instance.
 *
 * Spike results (M5 Pro, 2026-06-12):
 *   jinaai/jina-reranker-v1-tiny-en — cold 93 ms, warm 20-pair 215 ms ✅ SELECTED
 *   Xenova/ms-marco-MiniLM-L-6-v2  — cold 46 ms, warm 20-pair 254 ms
 *   mixedbread-ai/mxbai-rerank-xsmall-v1 — cold 381 ms, warm 788 ms
 *
 * NOTE: M1 Pro secondary device will be slower (estimated ~400–700 ms for 20 pairs),
 * still within the 1 500 ms gate. Flag defaults to off; user opts in via Settings → Debug.
 *
 * Scoring API:
 *   scoreFn is injectable so tests never download the real model.
 *   The production path uses the tokenizer+model low-level API (NOT the high-level
 *   text-classification pipeline._call, which does not support text pairs in v2.17.x).
 */

import { app } from 'electron'
import path    from 'path'

/** Chosen model after Phase 3 spike on M5 Pro (2026-06-12). */
export const RERANKER_MODEL_ID = 'jinaai/jina-reranker-v1-tiny-en'

// ── Internal types ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CrossEncoderPipeline = any  // @xenova/transformers Pipeline (untyped)

let _pipeline:    CrossEncoderPipeline | null = null
let _initPromise: Promise<void> | null        = null

// ── Initialisation ────────────────────────────────────────────────────────────

async function ensureReady(): Promise<void> {
  if (_pipeline) return
  if (!_initPromise) {
    _initPromise = (async () => {
      const t0 = Date.now()
      console.log(`[Reranker] 🔄 Loading ${RERANKER_MODEL_ID} via @xenova/transformers …`)

      const { pipeline, env } = await import('@xenova/transformers')

      // Same cache dir as EmbeddingService — both models live under userData/models/
      const cacheDir = path.join(app.getPath('userData'), 'models')
      env.cacheDir   = cacheDir

      try {
        _pipeline = await pipeline('text-classification', RERANKER_MODEL_ID)
        console.log(`[Reranker] ✅ Pipeline ready in ${Date.now() - t0} ms`)
      } catch (err) {
        _initPromise = null  // allow retry on next call
        console.error(`[Reranker] ❌ pipeline() FAILED after ${Date.now() - t0} ms:`, err)
        throw err
      }
    })()
  }
  await _initPromise
}

/**
 * Fire-and-forget warm-up so the model is resident in memory before it is
 * needed serially in retrieve().  Errors are swallowed intentionally.
 */
export function ensureRerankerReady(): void {
  void ensureReady().catch(() => {})
}

/** True once the pipeline has been initialised (model downloaded). */
export function isRerankerReady(): boolean {
  return _pipeline !== null
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a single (query, passage) pair using the cross-encoder.
 *
 * Uses the pipeline's underlying tokenizer + model directly because
 * @xenova/transformers v2's high-level _call() does not support text pairs.
 * Returns the raw logit (higher = more relevant).
 */
async function scorePair(query: string, passage: string): Promise<number> {
  await ensureReady()
  // Encode as a proper text pair: [CLS] query [SEP] passage [SEP]
  const inputs = _pipeline!.tokenizer(query, {
    text_pair:  passage,
    padding:    true,
    truncation: true,
  })
  const { logits } = await _pipeline!.model(inputs)
  // Cross-encoder outputs a single relevance logit (shape [1,1] or [1,2]).
  // In either case, data[0] is the raw relevance score.
  return logits.data[0] as number
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Injectable scoring function type — tests supply a deterministic stub so the
 * real model is never downloaded during vitest runs.
 */
export type RerankerScoreFn = (
  query:    string,
  passages: Array<{ rowid: number; content: string }>
) => Promise<Array<{ rowid: number; score: number }>>

/**
 * Re-score `passages` against `query` and return them sorted by descending score.
 *
 * @param query    The user's query string.
 * @param passages Candidates to score — each has a stable rowid and text content.
 * @param scoreFn  Optional injectable scoring function (omit in production).
 *
 * Errors are NOT caught here — the caller (RagRetrievalService) owns the fallback.
 */
export async function rerank(
  query:    string,
  passages: Array<{ rowid: number; content: string }>,
  scoreFn?: RerankerScoreFn
): Promise<Array<{ rowid: number; score: number }>> {
  if (passages.length === 0) return []

  // ── Injectable path (tests) ──────────────────────────────────────────────
  if (scoreFn) {
    return scoreFn(query, passages)
  }

  // ── Production path ──────────────────────────────────────────────────────
  // Score each pair sequentially (mirrors the spike's sequential approach).
  // Batched tokenisation would be faster but requires careful tensor padding;
  // sequential is simpler and still well within the 1 500 ms latency gate.
  const scored: Array<{ rowid: number; score: number }> = []
  for (const p of passages) {
    const score = await scorePair(query, p.content)
    scored.push({ rowid: p.rowid, score })
  }

  // Sort descending — highest relevance first
  scored.sort((a, b) => b.score - a.score)
  return scored
}
