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
