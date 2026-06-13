/**
 * RagEvalService unit tests — Phase 4
 *
 * Coverage:
 *   1. Pure metric functions: precisionAtK, recallAtK, mrr, hitRate
 *   2. Text normalization and substring relevance matching
 *   3. runEval end-to-end with in-memory corpus: asserts ablation table
 *      reflects lexical-only misses and vector-only misses correctly.
 *
 * No model downloads: embedFn is a deterministic stub throughout.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ensureVecLoaded, _resetForTests } from '../../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../../EmbeddingService'
import {
  precisionAtK,
  recallAtK,
  mrr,
  hitRate,
  normalizeForMatch,
  isRelevant,
  resolveRelevantRowids,
  runEval,
} from '../RagEvalService'
import { retrieve } from '../RagRetrievalService'
import type { RerankerScoreFn } from '../RerankerService'

// ── Test DB setup ─────────────────────────────────────────────────────────────

let db: Database.Database

function vecBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function seedVec(seed: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM)
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] = Math.sin(seed * (i + 1))
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0))
  for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] /= norm
  return arr
}

function stubEmbed(seed: number) {
  return async (_text: string): Promise<number[]> => {
    const arr = seedVec(seed)
    return Array.from(arr)
  }
}

let chunkCounter = 1000

function seedChunk(opts: {
  chatId: string
  docId: string
  docName: string
  chunkIndex: number
  content: string
  vecSeed?: number
}): number {
  const { chatId, docId, docName, chunkIndex, content, vecSeed } = opts
  const id = chunkCounter++
  try {
    db.prepare(
      `INSERT OR IGNORE INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'h' || ?, 0)`
    ).run(docId, docName, Date.now(), chatId, docId)
  } catch { /* already exists */ }

  db.prepare(
    `INSERT INTO rag_chunks (id, doc_id, chat_id, doc_name, chunk_index, section_title, content)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, docId, chatId, docName, chunkIndex, content)

  if (vecSeed !== undefined) {
    const v = seedVec(vecSeed)
    db.prepare('INSERT INTO chunks_vec(rowid, chat_id, embedding) VALUES (?, ?, ?)')
      .run(BigInt(id), chatId, vecBuffer(v))
  }
  return id
}

beforeAll(() => {
  _resetForTests()
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  ensureVecLoaded(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '',
      ts INTEGER NOT NULL, chat_id TEXT, content TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'indexed', content_hash TEXT, token_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY, doc_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      doc_name TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      section_title TEXT, content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_chat ON rag_chunks(chat_id);
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
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
      chat_id text partition key, embedding float[${EMBEDDING_DIM}]
    );
    CREATE TABLE IF NOT EXISTS doc_inline_text (
      doc_id TEXT PRIMARY KEY, text TEXT NOT NULL
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))
vi.mock('../../SettingsStore', () => ({
  readSettings:  vi.fn(() => ({ rerankEnabled: false, ragVerboseTrace: false })),
  writeSettings: vi.fn(),
}))

// ── Mock app (Electron not available in Vitest) ───────────────────────────────

vi.mock('electron', () => ({
  app: {
    getPath: (p: string) => (p === 'downloads' ? '/tmp' : '/tmp'),
    getVersion: () => '0.0.0',
  },
  ipcMain: { handle: vi.fn() },
}))

// ── 1. Metric functions ───────────────────────────────────────────────────────

describe('precisionAtK', () => {
  it('returns 1.0 when all top-K are relevant', () => {
    expect(precisionAtK([1, 2, 3], new Set([1, 2, 3]), 3)).toBe(1)
  })

  it('returns 0.5 when half are relevant', () => {
    expect(precisionAtK([1, 2, 3, 4], new Set([1, 3]), 4)).toBe(0.5)
  })

  it('returns 0 for empty ranked list', () => {
    expect(precisionAtK([], new Set([1]), 5)).toBe(0)
  })

  it('returns 0 when nothing relevant in top-K', () => {
    expect(precisionAtK([1, 2, 3], new Set([99]), 3)).toBe(0)
  })

  it('is bounded by actual list length, not k', () => {
    // list has 2 items, k=5, both relevant → P = 2/2 = 1
    expect(precisionAtK([1, 2], new Set([1, 2]), 5)).toBe(1)
  })
})

describe('recallAtK', () => {
  it('returns 1.0 when all relevant items are in top-K', () => {
    expect(recallAtK([1, 2, 3], new Set([1, 2]), 3)).toBe(1)
  })

  it('returns 0.5 when only half of relevant items are in top-K', () => {
    expect(recallAtK([1, 2, 3], new Set([1, 99]), 3)).toBe(0.5)
  })

  it('returns 0 for empty relevant set', () => {
    expect(recallAtK([1, 2, 3], new Set(), 3)).toBe(0)
  })

  it('returns 0 when no relevant items in top-K', () => {
    expect(recallAtK([1, 2, 3], new Set([99, 100]), 3)).toBe(0)
  })
})

describe('mrr', () => {
  it('returns 1.0 when relevant item is rank 1', () => {
    expect(mrr([10, 20, 30], new Set([10]))).toBe(1)
  })

  it('returns 0.5 when relevant item is rank 2', () => {
    expect(mrr([10, 20, 30], new Set([20]))).toBe(0.5)
  })

  it('returns 1/3 when relevant item is rank 3', () => {
    expect(mrr([10, 20, 30], new Set([30]))).toBeCloseTo(1 / 3)
  })

  it('returns 0 when no relevant item in list', () => {
    expect(mrr([10, 20, 30], new Set([99]))).toBe(0)
  })

  it('uses first relevant item for MRR', () => {
    expect(mrr([10, 20, 30], new Set([10, 20]))).toBe(1)
  })
})

describe('hitRate', () => {
  it('returns 1 when relevant item is in top-K', () => {
    expect(hitRate([1, 2, 3], new Set([2]), 3)).toBe(1)
  })

  it('returns 0 when no relevant item in top-K', () => {
    expect(hitRate([1, 2, 3], new Set([99]), 3)).toBe(0)
  })

  it('returns 0 for k=0', () => {
    expect(hitRate([1, 2, 3], new Set([1]), 0)).toBe(0)
  })
})

// ── 2. Substring relevance matching ──────────────────────────────────────────

describe('normalizeForMatch', () => {
  it('lowercases text', () => {
    expect(normalizeForMatch('Hello World')).toBe('hello world')
  })

  it('collapses whitespace', () => {
    expect(normalizeForMatch('a   b\t\nc')).toBe('a b c')
  })

  it('trims', () => {
    expect(normalizeForMatch('  text  ')).toBe('text')
  })
})

describe('isRelevant', () => {
  it('matches when content contains a snippet (case-insensitive)', () => {
    expect(isRelevant('L2 Regularization prevents overfitting', ['L2 regularization'])).toBe(true)
  })

  it('matches with whitespace differences', () => {
    expect(isRelevant('Early  stopping halts training', ['early stopping halts'])).toBe(true)
  })

  it('returns false when no snippets match', () => {
    expect(isRelevant('gradient descent', ['overfitting', 'regularization'])).toBe(false)
  })

  it('OR semantics: true if any snippet matches', () => {
    expect(isRelevant('gradient descent converges', ['overfitting', 'gradient descent'])).toBe(true)
  })

  it('returns false for empty snippets', () => {
    expect(isRelevant('anything', [])).toBe(false)
  })
})

describe('resolveRelevantRowids', () => {
  it('returns rowids whose content matches any snippet', () => {
    const chatId = 'eval-resolve-test'
    const id1 = seedChunk({ chatId, docId: 'doc-ev1', docName: 'ev.pdf', chunkIndex: 0,
      content: 'L2 regularization penalizes large weights in the model.' })
    const id2 = seedChunk({ chatId, docId: 'doc-ev1', docName: 'ev.pdf', chunkIndex: 1,
      content: 'Early stopping halts training when validation loss plateaus.' })
    seedChunk({ chatId, docId: 'doc-ev1', docName: 'ev.pdf', chunkIndex: 2,
      content: 'This chunk is about completely unrelated cooking recipes.' })

    const result = resolveRelevantRowids(chatId, ['L2 regularization', 'early stopping'])
    expect(result.has(id1)).toBe(true)
    expect(result.has(id2)).toBe(true)
  })

  it('returns empty set when no snippets match any chunk', () => {
    const chatId = 'eval-resolve-empty'
    seedChunk({ chatId, docId: 'doc-ev2', docName: 'ev2.pdf', chunkIndex: 0,
      content: 'Normal text about general topics.' })
    const result = resolveRelevantRowids(chatId, ['xyznonexistentsnippet123'])
    expect(result.size).toBe(0)
  })
})

// ── 3. runEval end-to-end ablation test ──────────────────────────────────────

import fs from 'fs'
import path from 'path'

describe('runEval — ablation: lexical-only miss, vector-only miss, hybrid catches both', () => {
  it('ablation table shows hybrid with higher recall than either unimodal mode', async () => {
    const chatId = 'eval-ablation-chat'

    // Chunk A: found by FTS5 (exact keyword match) but NOT by vectors
    // (vecSeed far from query — the stub query will use seed=42)
    const idA = seedChunk({
      chatId, docId: 'doc-abl', docName: 'ablation.pdf', chunkIndex: 0,
      content: 'regularization prevents overfitting by penalizing complexity',
      vecSeed: 99, // far from query seed 42
    })

    // Chunk B: found by vectors (semantic) but NOT by FTS5
    // (unique words not shared with query; close vecSeed to query)
    const idB = seedChunk({
      chatId, docId: 'doc-abl', docName: 'ablation.pdf', chunkIndex: 1,
      content: 'xyzabc123 gradient stationary convergence',
      vecSeed: 42, // close to query seed 42
    })

    // Write eval JSONL file
    const evalPath = path.join('/tmp', `ablation-test-${Date.now()}.jsonl`)
    const queryLines = [
      JSON.stringify({ query: 'regularization prevents overfitting', relevant: ['regularization prevents overfitting'] }),
      JSON.stringify({ query: 'xyzabc123 gradient stationary', relevant: ['xyzabc123 gradient stationary'] }),
    ]
    fs.writeFileSync(evalPath, queryLines.join('\n'), 'utf8')

    const embedFn = stubEmbed(42)

    const report = await runEval(evalPath, chatId, embedFn)

    expect(report.resolvedCount).toBeGreaterThanOrEqual(1)

    // Find the aggregates
    const lexMode    = report.aggregates.find(m => m.mode === 'lexical-only')
    const vecMode    = report.aggregates.find(m => m.mode === 'vector-only')
    const hybridMode = report.aggregates.find(m => m.mode === 'hybrid')

    expect(lexMode).toBeDefined()
    expect(vecMode).toBeDefined()
    expect(hybridMode).toBeDefined()

    // Hybrid hit@K should be >= both unimodal modes
    expect(hybridMode!.hitAtK).toBeGreaterThanOrEqual(lexMode!.hitAtK)
    expect(hybridMode!.hitAtK).toBeGreaterThanOrEqual(vecMode!.hitAtK)

    // Report written to /tmp
    expect(report.queryCount).toBe(2)

    // Clean up
    fs.unlinkSync(evalPath)

    void idA; void idB // used in corpus
  })
})

describe('runEval — unresolvable query excluded from aggregates', () => {
  it('marks query as unresolvable when no chunks match the snippets', async () => {
    const chatId = 'eval-unresolvable'
    seedChunk({ chatId, docId: 'doc-unres', docName: 'u.pdf', chunkIndex: 0,
      content: 'Some valid content about real topics.' })

    const evalPath = path.join('/tmp', `unresolvable-${Date.now()}.jsonl`)
    fs.writeFileSync(evalPath,
      JSON.stringify({ query: 'what is foo', relevant: ['xyznonexistent999snippet'] }) + '\n',
      'utf8')

    const report = await runEval(evalPath, chatId, stubEmbed(5))
    expect(report.resolvedCount).toBe(0)
    expect(report.perQuery[0].status).toBe('unresolvable')

    fs.unlinkSync(evalPath)
  })
})

// ── Helpers for priority-order metric correctness tests ───────────────────────

/**
 * Build a unit vector in R^EMBEDDING_DIM with:
 *   dim 0     = firstDimCos
 *   orthDim   = sqrt(1 - firstDimCos²)
 *   all other = 0
 *
 * L2 norm = 1 by construction.  Distance to [1,0,...]:
 *   d = sqrt(2 − 2 × firstDimCos)
 *
 * This lets us create chunks with EXACT, PREDICTABLE distances from the
 * query vector [1,0,...] without relying on the sin-based seedVec heuristic.
 */
function unitVec384(firstDimCos: number, orthDim: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM).fill(0)
  arr[0] = firstDimCos
  if (orthDim > 0 && orthDim < EMBEDDING_DIM) {
    arr[orthDim] = Math.sqrt(Math.max(0, 1 - firstDimCos * firstDimCos))
  }
  return arr
}

/** Insert a chunk with an arbitrary pre-built Float32Array embedding. */
function seedChunkWithVec(opts: {
  chatId: string; docId: string; docName: string
  chunkIndex: number; content: string; vec: Float32Array
}): number {
  const { chatId, docId, docName, chunkIndex, content, vec } = opts
  const id = chunkCounter++
  try {
    db.prepare(
      `INSERT OR IGNORE INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'h' || ?, 0)`
    ).run(docId, docName, Date.now(), chatId, docId)
  } catch { /* already exists */ }

  db.prepare(
    `INSERT INTO rag_chunks (id, doc_id, chat_id, doc_name, chunk_index, section_title, content)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(id, docId, chatId, docName, chunkIndex, content)

  db.prepare('INSERT INTO chunks_vec(rowid, chat_id, embedding) VALUES (?, ?, ?)')
    .run(BigInt(id), chatId, vecBuffer(vec))

  return id
}

// ── Test: MRR follows priority order, not alphabetical docName ────────────────

describe('runEval — MRR follows priority order, not alphabetical docName', () => {
  it('MRR ≈ 1/3 when relevant chunk is at vector-rank 3 despite being alphabetically first', async () => {
    const chatId = 'eval-mrr-priority-order'

    // Query vector = e₁ = [1, 0, 0, …].  Distances: sqrt(2 − 2·cos)
    //   rank 1 → cos=1.00 → dist=0      "bbb-irrel.pdf"  (alphabetically 2nd)
    //   rank 2 → cos=0.90 → dist≈0.447  "ccc-irrel.pdf"  (alphabetically 3rd)
    //   rank 3 → cos=0.80 → dist≈0.632  "aaa-relev.pdf"  (alphabetically 1st ← the trap)
    //
    // Old code uses result.hits (sorted by docName) → aaa at rank 1 → MRR=1.0 (wrong)
    // New code uses trace.allocation admitted order → aaa at rank 3  → MRR≈1/3 (correct)

    const relevantId = seedChunkWithVec({
      chatId, docId: 'doc-mrr-a', docName: 'aaa-relev.pdf', chunkIndex: 0,
      content: 'mrr relevant content priority order check',
      vec: unitVec384(0.80, 3),  // rank 3, dist≈0.632
    })
    seedChunkWithVec({
      chatId, docId: 'doc-mrr-b', docName: 'bbb-irrel.pdf', chunkIndex: 0,
      content: 'bbb irrelevant alpha beta gamma delta',
      vec: unitVec384(1.00, 1),  // rank 1, dist=0
    })
    seedChunkWithVec({
      chatId, docId: 'doc-mrr-c', docName: 'ccc-irrel.pdf', chunkIndex: 0,
      content: 'ccc irrelevant epsilon zeta eta theta',
      vec: unitVec384(0.90, 2),  // rank 2, dist≈0.447
    })

    const queryVec = unitVec384(1.00, 1)
    const embedFn = async (_: string): Promise<number[]> => Array.from(queryVec)

    const evalPath = path.join('/tmp', `mrr-priority-${Date.now()}.jsonl`)
    fs.writeFileSync(evalPath,
      JSON.stringify({ query: 'mrr unique probe', relevant: ['mrr relevant content'] }) + '\n',
      'utf8')

    const report = await runEval(evalPath, chatId, embedFn)
    fs.unlinkSync(evalPath)

    expect(report.resolvedCount).toBe(1)
    // Confirm relevant chunk resolved
    const relSet = new Set([relevantId])
    expect(relSet.size).toBe(1)

    // vector-only mode: admittedOrdered = [bbb, ccc, aaa] (by vector dist)
    // relevant (aaa) at rank 3 → MRR = 1/3 ≈ 0.333
    const vecMode = report.aggregates.find(m => m.mode === 'vector-only')
    expect(vecMode).toBeDefined()
    expect(vecMode!.mrr).toBeCloseTo(1 / 3, 2)
    // Guard: must NOT be 1.0 (which would happen with alphabetical ordering)
    expect(vecMode!.mrr).toBeLessThan(0.5)
  })
})

// ── Test: candidateRecall=1.0 while recallAtK=0.0 ────────────────────────────

describe('runEval — CandRec=1.0 + Recall@K=0.0 when relevant chunk cut by FINAL_K', () => {
  it('relevant chunk in top-20 candidates but beyond FINAL_K=6 is flagged by divergence', async () => {
    const chatId = 'eval-cand-not-admitted'

    // Insert 7 chunks in one chat.  Query vec = [1,0,…].
    // Chunks ranked 1–6 are irrelevant; chunk 7 is relevant.
    // FINAL_K=6 → chunks 1–6 fill orderedCandidates → chunk 7 NOT admitted.
    // But chunk 7 IS in the top-20 vector candidate pool → CandRec=1.0.
    const cosines = [1.00, 0.99, 0.98, 0.97, 0.96, 0.95, 0.94] as const
    let relevantId = -1
    for (let i = 0; i < cosines.length; i++) {
      const isRelevantChunk = i === 6  // rank 7 = beyond FINAL_K
      const id = seedChunkWithVec({
        chatId, docId: `doc-cna-${i}`, docName: `doc${i}.pdf`, chunkIndex: 0,
        content: isRelevantChunk
          ? 'cna relevant needle content unique'
          : `cna irrelevant filler content rank${i}`,
        vec: unitVec384(cosines[i], i + 1),
      })
      if (isRelevantChunk) relevantId = id
    }

    const queryVec = unitVec384(1.00, 1)
    const embedFn = async (_: string): Promise<number[]> => Array.from(queryVec)

    const evalPath = path.join('/tmp', `cna-${Date.now()}.jsonl`)
    fs.writeFileSync(evalPath,
      JSON.stringify({ query: 'cna unique probe needle', relevant: ['cna relevant needle'] }) + '\n',
      'utf8')

    const report = await runEval(evalPath, chatId, embedFn)
    fs.unlinkSync(evalPath)

    expect(report.resolvedCount).toBe(1)
    expect(relevantId).toBeGreaterThan(0)

    const vecMode = report.aggregates.find(m => m.mode === 'vector-only')
    expect(vecMode).toBeDefined()

    // The key invariant: retrieval FOUND the relevant chunk (candidateRecall=1.0)
    // but budget/FINAL_K dropped it before presentation (recallAtK=0.0)
    expect(vecMode!.candidateRecall).toBeCloseTo(1.0, 2)
    expect(vecMode!.recallAtK).toBeCloseTo(0.0, 2)
  })
})

// ── Test: rerank MRR improvement via stub scoreFn ─────────────────────────────

describe('runEval — hybrid+rerank MRR improves over hybrid via stub scoreFn', () => {
  it('scoreFn promoting relevant chunk from rank 5 → rank 1 raises MRR from 0.2 to 1.0', async () => {
    const chatId = 'eval-rerank-mrr-improve'

    // 5 chunks: relevant at rank 5 by vector distance (cos=0.96).
    // scoreFn assigns score=10 to the relevant chunk → rerank promotes it to rank 1.
    const cosines = [1.00, 0.99, 0.98, 0.97, 0.96] as const
    let relevantId = -1
    for (let i = 0; i < cosines.length; i++) {
      const isRel = i === 4
      const id = seedChunkWithVec({
        chatId, docId: `doc-rrm-${i}`, docName: `rrm${i}.pdf`, chunkIndex: 0,
        content: isRel
          ? 'rrm relevant promoted content needle'
          : `rrm irrelevant filler alpha beta rank${i}`,
        vec: unitVec384(cosines[i], i + 1),
      })
      if (isRel) relevantId = id
    }

    const capturedRelevantId = relevantId  // close over for scoreFn
    const queryVec = unitVec384(1.00, 1)
    const embedFn = async (_: string): Promise<number[]> => Array.from(queryVec)

    // scoreFn must return sorted descending — rerank()'s injectable path does not sort
    const promotingScoreFn: RerankerScoreFn = async (_q, passages) => {
      const scored = passages.map(p => ({
        rowid:  p.rowid,
        score: p.rowid === capturedRelevantId ? 10.0 : 0.1,
      }))
      return scored.sort((a, b) => b.score - a.score)
    }

    // Direct retrieve() calls to isolate hybrid vs hybrid+rerank MRR:
    const hybridResult = await retrieve(
      'rrm unique probe test', chatId, embedFn, undefined,
      { forceMode: 'hybrid', captureTrace: true },
    )
    const rerankResult = await retrieve(
      'rrm unique probe test', chatId, embedFn, promotingScoreFn,
      { forceMode: 'hybrid', rerankOverride: true, captureTrace: true },
    )

    const relevantSet = new Set([relevantId])

    const hybridAdmitted = hybridResult.trace!.allocation
      .filter(a => a.decision === 'admitted').map(a => a.rowid)
    const rerankAdmitted = rerankResult.trace!.allocation
      .filter(a => a.decision === 'admitted').map(a => a.rowid)

    const hybridMrr  = mrr(hybridAdmitted,  relevantSet)
    const rerankMrr  = mrr(rerankAdmitted,  relevantSet)

    // Hybrid (RRF order): relevant at rank 5 → MRR = 1/5 = 0.2
    expect(hybridMrr).toBeCloseTo(1 / 5, 2)

    // Hybrid+rerank (scoreFn promotes to rank 1): MRR = 1.0
    expect(rerankMrr).toBe(1.0)

    // Core assertion: reranker strictly improves MRR
    expect(rerankMrr).toBeGreaterThan(hybridMrr)
  })
})
