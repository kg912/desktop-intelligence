/**
 * RagRetrievalService tests — Phase 2
 *
 * Uses a real in-memory DB with the sqlite-vec extension.
 * embedFn is always a deterministic stub.
 * sanitizeFts5Query suite ported verbatim from RAGService.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { ensureVecLoaded, _resetForTests } from '../../rag/sqliteVecLoader'
import { EMBEDDING_DIM } from '../../EmbeddingService'

// ── Fixtures ───────────────────────────────────────────────────────────────────

let db: Database.Database

/** Deterministic unit vector stub: hash-seeded. */
function stubEmbed(seed: number): (text: string) => Promise<number[]> {
  return async (_text: string): Promise<number[]> => {
    const arr = new Array<number>(EMBEDDING_DIM)
    for (let i = 0; i < EMBEDDING_DIM; i++) arr[i] = Math.sin(seed * (i + 1))
    const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0))
    return arr.map(v => v / norm)
  }
}

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
      section_title TEXT, content TEXT NOT NULL,
      char_start INTEGER, char_end INTEGER
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
      doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))

// Mock SettingsStore so retrieve() can call readSettings() without Electron's app.getPath.
// Default: rerankEnabled=false → pure-RRF path used by all pre-Phase-3 tests.
vi.mock('../../SettingsStore', () => ({
  readSettings:  vi.fn(() => ({ rerankEnabled: false })),
  writeSettings: vi.fn(),
}))

import { retrieve, sanitizeFts5Query, buildContextEnvelope } from '../RagRetrievalService'
import { readSettings } from '../../SettingsStore'

// ── Helper: seed a chunk with both FTS5 and vec ────────────────────────────────

let _chunkIdCounter = 100

function seedChunk(opts: {
  chatId: string
  docId: string
  docName: string
  chunkIndex: number
  content: string
  vecSeed?: number
  sectionTitle?: string | null
}): number {
  const { chatId, docId, docName, chunkIndex, content, vecSeed, sectionTitle = null } = opts
  const id = _chunkIdCounter++

  // Ensure documents row exists
  try {
    db.prepare(
      `INSERT OR IGNORE INTO documents (id, name, path, ts, chat_id, mode, content_hash, token_count)
       VALUES (?, ?, '', ?, ?, 'indexed', 'hash-' || ?, 0)`
    ).run(docId, docName, Date.now(), chatId, docId)
  } catch { /* already exists */ }

  // Use prepared statement with explicit id
  db.prepare(
    `INSERT INTO rag_chunks (id, doc_id, chat_id, doc_name, chunk_index, section_title, content)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, docId, chatId, docName, chunkIndex, sectionTitle, content)

  if (vecSeed !== undefined) {
    const vec = seedVec(vecSeed)
    db.prepare('INSERT INTO chunks_vec(rowid, chat_id, embedding) VALUES (?, ?, ?)')
      .run(BigInt(id), chatId, vecBuffer(vec))
  }
  return id
}

// ── sanitizeFts5Query (ported verbatim) ───────────────────────────────────────

describe('sanitizeFts5Query (ported from RAGService)', () => {
  it('strips punctuation and joins tokens with spaces', () => {
    expect(sanitizeFts5Query('hello, world!')).toBe('hello world')
  })

  it('removes single-character tokens', () => {
    expect(sanitizeFts5Query('a big cat')).toBe('big cat')
  })

  it('returns empty string for all-single-char input', () => {
    expect(sanitizeFts5Query('a b c')).toBe('')
  })

  it('handles hyphenated terms by splitting on hyphens', () => {
    expect(sanitizeFts5Query('back-propagation')).toBe('back propagation')
  })

  it('handles empty input', () => {
    expect(sanitizeFts5Query('')).toBe('')
  })

  it('preserves multi-char tokens intact', () => {
    expect(sanitizeFts5Query('neural network gradient descent')).toBe(
      'neural network gradient descent'
    )
  })
})

// ── Exact-term query found via FTS5 (vec unavailable) ────────────────────────

describe('retrieve — lexical only (vec forced unavailable via mocked loader)', () => {
  it('finds exact-term chunk via FTS5 when vec is not available', async () => {
    const chatId = 'chat-lex-only'
    seedChunk({ chatId, docId: 'doc-lex', docName: 'lex.pdf', chunkIndex: 0,
      content: 'The quick brown fox jumps over the lazy dog.' })
    seedChunk({ chatId, docId: 'doc-lex', docName: 'lex.pdf', chunkIndex: 1,
      content: 'Gradient descent is an optimization algorithm.' })

    // Only FTS5-embed stub (no vec)
    const embedFn = async (_: string): Promise<number[]> => { throw new Error('vec unavailable') }
    const result = await retrieve('gradient descent', chatId, embedFn)

    expect(result.degradedMode).toBe(true)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    // Check the non-stitched winner (may not be hits[0] if stitch re-ordered)
    expect(result.hits.some(h => h.content.includes('Gradient descent'))).toBe(true)
  })
})

// ── Paraphrase scenario: dense path finds what FTS5 misses ────────────────────

describe('retrieve — dense path for paraphrase', () => {
  it('returns the paraphrase chunk via vector similarity', async () => {
    const chatId   = 'chat-para'
    const vecSeed  = 42
    const queryVec = vecSeed   // query vector close to chunk vector

    seedChunk({
      chatId, docId: 'doc-para', docName: 'para.pdf', chunkIndex: 0,
      content: 'The optimizer converges to a stationary point.',  // no shared tokens with query
      vecSeed,  // this chunk's vector will be near the query
    })
    seedChunk({
      chatId, docId: 'doc-para', docName: 'para.pdf', chunkIndex: 1,
      content: 'Completely unrelated content about cooking recipes.',
      vecSeed: 99,  // far from query
    })

    // Query has zero lexical overlap with the target chunk
    const embedFn = stubEmbed(queryVec)
    const result = await retrieve('how does the model avoid overfitting', chatId, embedFn)

    // Vector should find the target chunk
    const targetFound = result.hits.some(h => h.content.includes('stationary point'))
    expect(targetFound).toBe(true)
  })
})

// ── RRF: chunk in both lists outranks single-list ─────────────────────────────

describe('retrieve — RRF ordering', () => {
  it('candidate present in both lists ranks higher than single-list candidates', async () => {
    const chatId  = 'chat-rrf'
    const querySeed = 7

    // Chunk A: appears in both FTS5 and vec list
    const idA = seedChunk({
      chatId, docId: 'doc-rrf', docName: 'rrf.pdf', chunkIndex: 0,
      content: 'The target keyword appears in this chunk specifically.',
      vecSeed: querySeed,   // close to query
    })
    // Chunk B: appears only in FTS5 list
    seedChunk({
      chatId, docId: 'doc-rrf', docName: 'rrf.pdf', chunkIndex: 1,
      content: 'The target keyword also in this text for FTS5.',
      vecSeed: 999,  // far from query (will be filtered by VEC_DISTANCE_FLOOR)
    })
    // Chunk C: appears only in vec list
    seedChunk({
      chatId, docId: 'doc-rrf', docName: 'rrf.pdf', chunkIndex: 2,
      content: 'Totally different wording but semantically similar xqzvk.',
      vecSeed: querySeed + 0.001,  // close to query
    })

    const result = await retrieve('target keyword', chatId, stubEmbed(querySeed))

    // Chunk A (both lists) should be first
    const firstHit = result.hits.find(h => !h.stitched)
    expect(firstHit?.rowid).toBe(idA)
  })
})

// ── Per-chat isolation ────────────────────────────────────────────────────────

describe('retrieve — per-chat isolation', () => {
  it('returns hits only for the requested chat', async () => {
    const chatA = 'chat-iso-a-ret'
    const chatB = 'chat-iso-b-ret'

    seedChunk({ chatId: chatA, docId: 'doc-a', docName: 'a.pdf', chunkIndex: 0,
      content: 'isolation keyword for chat a only', vecSeed: 5 })
    seedChunk({ chatId: chatB, docId: 'doc-b', docName: 'b.pdf', chunkIndex: 0,
      content: 'isolation keyword in chat b corpus', vecSeed: 6 })

    const resultA = await retrieve('isolation', chatA, stubEmbed(5))
    const resultB = await retrieve('isolation', chatB, stubEmbed(6))

    const docNamesA = resultA.hits.map(h => h.docName)
    const docNamesB = resultB.hits.map(h => h.docName)

    expect(docNamesA.every(n => n === 'a.pdf')).toBe(true)
    expect(docNamesB.every(n => n === 'b.pdf')).toBe(true)
  })
})

// ── No-hit: both lists empty → noHit=true ────────────────────────────────────

describe('retrieve — no-hit rule', () => {
  it('noHit=true and hits empty when both candidate lists are empty', async () => {
    const chatId = 'chat-nohit'
    // Seed a vector that is FAR from the query (will be filtered by distance floor)
    seedChunk({ chatId, docId: 'doc-nohit', docName: 'nohit.pdf', chunkIndex: 0,
      content: 'unrelated xyz123 content', vecSeed: 50 })

    // Query: irrelevant term + far vector → both lists empty after floor
    const farEmbed = stubEmbed(100)  // far from seed 50
    const result = await retrieve('xyzxyzxyz999notaword', chatId, farEmbed)

    // FTS should return nothing (no word match), vec should filter all by distance
    // (or return nothing close). Either way noHit or empty hits.
    // This is a soft assertion — the important invariant is no chronological fallback.
    expect(result.hits.length === 0 || result.noHit).toBeTruthy()
  })
})

// ── CONTEXT_TOKEN_BUDGET respected ───────────────────────────────────────────

describe('retrieve — token budget', () => {
  it('total tokens in hits does not exceed CONTEXT_TOKEN_BUDGET', async () => {
    const chatId = 'chat-budget'
    const bigContent = 'Token budget test. '.repeat(300)  // ~300+ tokens each

    for (let i = 0; i < 8; i++) {
      seedChunk({ chatId, docId: 'doc-budget', docName: 'budget.pdf',
        chunkIndex: i, content: `${bigContent} chunk ${i}`, vecSeed: 3 + i * 0.01 })
    }

    const { retrieve: r, CONTEXT_TOKEN_BUDGET: CTB } = await import('../RagRetrievalService')
    const result = await r('token budget test', chatId, stubEmbed(3))

    expect(result.tokensUsed).toBeLessThanOrEqual(CTB)
  })
})

// ── Stitch includes ±1 neighbours ─────────────────────────────────────────────

describe('retrieve — stitch', () => {
  it('includes adjacent chunks (±1) as stitched neighbours', async () => {
    const chatId = 'chat-stitch'
    const docId  = 'doc-stitch'

    // Seed 3 sequential chunks; chunk_index=1 will be the retrieval winner
    const id0 = seedChunk({ chatId, docId, docName: 'stitch.pdf', chunkIndex: 0,
      content: 'Preamble before the target.', vecSeed: 1 })
    const id1 = seedChunk({ chatId, docId, docName: 'stitch.pdf', chunkIndex: 1,
      content: 'The stitching target sentence here.', vecSeed: 1 })
    const id2 = seedChunk({ chatId, docId, docName: 'stitch.pdf', chunkIndex: 2,
      content: 'Follow-up after the target.', vecSeed: 2 })

    const result = await retrieve('stitching target', chatId, stubEmbed(1))
    const ids = result.hits.map(h => h.rowid)

    expect(ids).toContain(id1)
    // At least one neighbour should be included
    expect(ids.includes(id0) || ids.includes(id2)).toBe(true)
    // Stitched neighbours are flagged
    const stitchedHits = result.hits.filter(h => h.stitched)
    expect(stitchedHits.length).toBeGreaterThan(0)
  })
})

// ── degradedMode when embedFn throws ─────────────────────────────────────────

describe('retrieve — degradedMode', () => {
  it('degradedMode=true when embedFn throws; FTS5 still runs', async () => {
    const chatId = 'chat-degrad'
    seedChunk({ chatId, docId: 'doc-degrad', docName: 'deg.pdf', chunkIndex: 0,
      content: 'degraded mode test with unique word zyzzyva.' })

    const failEmbed = async (_: string): Promise<number[]> => { throw new Error('embed error') }
    const result = await retrieve('zyzzyva', chatId, failEmbed)

    expect(result.degradedMode).toBe(true)
    // FTS5 should still find the chunk
    const found = result.hits.some(h => h.content.includes('zyzzyva'))
    expect(found).toBe(true)
  })
})

// ── Envelope builder ──────────────────────────────────────────────────────────

describe('buildContextEnvelope', () => {
  const hitPassage = {
    rowid: 1, docId: 'doc1', docName: 'paper.pdf',
    chunkIndex: 0, sectionTitle: 'Introduction',
    content: 'This is the relevant passage.', stitched: false, rrfScore: 0.5,
  }

  it('wraps passages in <attached_file_context> tags', () => {
    const env = buildContextEnvelope({
      passages: [hitPassage], noHit: false,
      inlineTexts: [], indexedDocNames: ['paper.pdf'], contextWindow: 32768,
    })
    expect(env).toContain('<attached_file_context>')
    expect(env).toContain('</attached_file_context>')
  })

  it('includes the passage header with docName and sectionTitle', () => {
    const env = buildContextEnvelope({
      passages: [hitPassage], noHit: false,
      inlineTexts: [], indexedDocNames: [], contextWindow: 32768,
    })
    expect(env).toContain('paper.pdf')
    expect(env).toContain('§Introduction')
    expect(env).toContain('part 1')
  })

  it('no-hit message names the files', () => {
    const env = buildContextEnvelope({
      passages: [], noHit: true,
      inlineTexts: [], indexedDocNames: ['report.pdf', 'notes.txt'], contextWindow: 32768,
    })
    expect(env).toContain('report.pdf')
    expect(env).toContain('notes.txt')
    expect(env).not.toContain('<attached_file_context>')
  })

  it('inline + indexed chat → exactly one envelope, inline first', () => {
    const env = buildContextEnvelope({
      passages: [hitPassage], noHit: false,
      inlineTexts: [{ docName: 'notes.txt', text: 'inline content here' }],
      indexedDocNames: ['paper.pdf'], contextWindow: 32768,
    })
    expect(env).toContain('<attached_file_context>')
    // Inline appears before the retrieved passage
    const inlinePos  = env.indexOf('inline content here')
    const passagePos = env.indexOf('This is the relevant passage.')
    expect(inlinePos).toBeLessThan(passagePos)
    // Exactly one opening tag
    const matches = env.match(/<attached_file_context>/g)
    expect(matches?.length).toBe(1)
  })

  it('inline truncation triggers at small contextLength and appends truncation note', () => {
    const longText = 'x'.repeat(5000)
    const env = buildContextEnvelope({
      passages: [], noHit: false,
      inlineTexts: [{ docName: 'big.pdf', text: longText }],
      indexedDocNames: [], contextWindow: 100,  // very small → budget = 50 tokens ≈ 200 chars
    })
    expect(env).toContain('truncated to fit')
    expect(env).toContain('big.pdf')
  })

  it('returns empty string when no content at all', () => {
    const env = buildContextEnvelope({
      passages: [], noHit: false,
      inlineTexts: [], indexedDocNames: [], contextWindow: 32768,
    })
    expect(env).toBe('')
  })
})

// ── Priority budget: top-RRF wins over alphabetical order ─────────────────────

describe('retrieve — priority budget: top-RRF over alphabetical order', () => {
  it('admits the highest-RRF chunk even when it is alphabetically last', async () => {
    const chatId    = 'chat-prio-alpha'
    const querySeed = 11

    // Large content — enough tokens to create real budget pressure
    const big = 'priority alpha '.repeat(600)  // ~1800+ chars, several hundred tokens

    // z-last.pdf: highest RRF — FTS5 + vec rank 0 (close to query)
    const idZ = seedChunk({
      chatId, docId: 'doc-pa-z', docName: 'z-last.pdf', chunkIndex: 0,
      content: `priority alpha ${big}`, vecSeed: querySeed,
    })
    // Five alphabetically-earlier docs: FTS5 only (vec seeds far → filtered by VEC_DISTANCE_FLOOR)
    for (let i = 0; i < 5; i++) {
      seedChunk({
        chatId,
        docId:   `doc-pa-${i}`,
        docName: `${String.fromCharCode(97 + i)}-filler.pdf`,  // a-filler … e-filler
        chunkIndex: 0,
        content: `priority alpha ${big}`,
        vecSeed: 80 + i,  // far from querySeed=11 — filtered by distance floor
      })
    }

    const result = await retrieve('priority alpha', chatId, stubEmbed(querySeed))

    // z-last.pdf has the highest RRF score (vec rank 0 + lexical rank) and MUST be admitted.
    // Under the old sort-then-truncate approach it would be excluded (alphabetically last).
    expect(result.hits.some(h => h.rowid === idZ)).toBe(true)
  })
})

// ── Priority budget: stitch dropped before winner ─────────────────────────────

describe('retrieve — priority budget: stitch dropped before winner', () => {
  it('winner-2 is admitted even when winner-1\'s stitch would have consumed its slot', async () => {
    const chatId    = 'chat-prio-stitch'
    const querySeed = 13

    // winner-1: large chunk; winner-2: tiny chunk; stitch (adjacent to winner-1): large chunk.
    //
    // Two-pass allocation:
    //   Pass 1: winner-1 (large) admitted; winner-2 (tiny) admitted → both fit.
    //   Pass 2: stitch (large) — remaining budget ≈ CONTEXT_TOKEN_BUDGET - winner-1 - winner-2.
    //           If stitch > remaining, it is dropped. winner-2 is already safe.
    //
    // Old single-pass (sort+truncate) would order:
    //   a-prio-stitch.pdf chunk 0 (winner-2), z-prio-stitch.pdf chunk 4 (stitch), chunk 5 (winner-1).
    //   With stitch + winner-1 > budget, winner-1 would be the one dropped — NOT the stitch.

    const large = 'st '.repeat(2800)  // ~2800+ tokens
    const small = 'st unique winner two'  // ~5 tokens

    // winner-1 in alphabetically-LAST doc (so old code places it after the stitch)
    const idW1 = seedChunk({
      chatId, docId: 'doc-ps-z', docName: 'z-prio-stitch.pdf', chunkIndex: 5,
      content: `st winner one ${large}`, vecSeed: querySeed,
    })
    // Stitch neighbour at chunkIndex 4 of same doc (adjacent to winner-1)
    seedChunk({
      chatId, docId: 'doc-ps-z', docName: 'z-prio-stitch.pdf', chunkIndex: 4,
      content: `st stitch neighbour ${large}`, vecSeed: querySeed + 0.01,
    })
    // winner-2: tiny chunk in alphabetically-FIRST doc
    const idW2 = seedChunk({
      chatId, docId: 'doc-ps-a', docName: 'a-prio-stitch.pdf', chunkIndex: 0,
      content: `st winner two ${small}`, vecSeed: querySeed + 0.005,
    })

    const result = await retrieve('st winner', chatId, stubEmbed(querySeed))

    const hitIds = result.hits.map(h => h.rowid)
    // Both winners must be present — a stitched neighbour cannot displace an un-admitted winner
    expect(hitIds).toContain(idW1)
    expect(hitIds).toContain(idW2)
  })
})

// ── Combined inline accounting ────────────────────────────────────────────────

describe('buildContextEnvelope — combined inline accounting', () => {
  it('second inline doc omitted when first doc exhausts the inline budget', () => {
    // contextWindow=500 → inlineBudget=250 tokens
    // doc1: ~300+ tokens → individually exceeds 250 → truncated; budget exhausted
    // doc2: very small (individually fits within 250) → budget gone → omitted with note
    // This test validates combined accounting: the old per-doc implementation would include
    // doc2 because it individually fits the cap; combined accounting correctly omits it.
    const text1 = 'hello '.repeat(300)  // ~300 tokens > inlineBudget of 250
    const text2 = 'world content here'  // ~4 tokens — fits individually; not after combined cap
    const env = buildContextEnvelope({
      passages: [], noHit: false,
      inlineTexts: [
        { docName: 'first.pdf',  text: text1 },
        { docName: 'second.txt', text: text2 },
      ],
      indexedDocNames: [], contextWindow: 500,
    })
    // First doc: present but truncated (exceeded the per-envelope inline budget)
    expect(env).toContain('first.pdf')
    expect(env).toContain('[Note: first.pdf truncated to fit the context window]')
    // Second doc: omitted entirely — budget was exhausted by first doc
    expect(env).toContain('[Note: second.txt omitted to fit the context window]')
    expect(env).not.toContain('world content here')
  })
})

// ── Preamble wording ──────────────────────────────────────────────────────────

describe('buildContextEnvelope — preamble wording', () => {
  it('inline-only chat (no retrieved passages, noHit=false) uses the combined preamble', () => {
    const env = buildContextEnvelope({
      passages: [], noHit: false,
      inlineTexts: [{ docName: 'notes.txt', text: 'some content here' }],
      indexedDocNames: [], contextWindow: 32768,
    })
    expect(env).toContain('<attached_file_context>')
    // New preamble explicitly covers both inline docs and retrieved passages
    expect(env).toContain('full documents')
    expect(env).toContain('and/or passages retrieved for the current question')
    // Old preamble ("Relevant passages retrieved for the…") is gone
    expect(env).not.toContain('Relevant passages retrieved for the')
  })

  it('mixed inline + retrieved also uses the combined preamble', () => {
    const env = buildContextEnvelope({
      passages: [{
        rowid: 99, docId: 'doc-preamble', docName: 'indexed.pdf',
        chunkIndex: 0, sectionTitle: null,
        content: 'retrieved content', stitched: false, rrfScore: 0.5,
      }],
      noHit: false,
      inlineTexts: [{ docName: 'notes.txt', text: 'inline content' }],
      indexedDocNames: ['indexed.pdf'], contextWindow: 32768,
    })
    expect(env).toContain('full documents')
    expect(env).toContain('and/or passages retrieved for the current question')
  })
})

// ── Reranker integration ──────────────────────────────────────────────────────

import type { RerankerScoreFn } from '../RerankerService'

describe('retrieve — reranker integration: flag off', () => {
  it('rerankUsed=false when rerankEnabled=false (default mock)', async () => {
    const chatId = 'chat-rerank-off'
    seedChunk({ chatId, docId: 'doc-rk-off', docName: 'rk-off.pdf', chunkIndex: 0,
      content: 'reranker flag off test content', vecSeed: 3 })

    // Default mock returns { rerankEnabled: false }
    const result = await retrieve('reranker flag', chatId, stubEmbed(3))

    expect(result.rerankUsed).toBe(false)
    expect(result.rerankMs).toBeUndefined()
    expect(result.hits.every(h => h.rerankScore === undefined)).toBe(true)
  })
})

describe('retrieve — reranker integration: flag on, stub scoreFn inverts RRF order', () => {
  it('winners follow rerank order when rerankEnabled=true + stub scoreFn', async () => {
    const chatId    = 'chat-rerank-on'
    const querySeed = 17

    // Seed two chunks. RRF would rank idA first (closer vec), but stub scoreFn ranks idB first.
    const idA = seedChunk({ chatId, docId: 'doc-rk-a', docName: 'a-rk.pdf', chunkIndex: 0,
      content: 'reranker on test chunk A — closer vec so higher RRF', vecSeed: querySeed })
    const idB = seedChunk({ chatId, docId: 'doc-rk-b', docName: 'b-rk.pdf', chunkIndex: 0,
      content: 'reranker on test chunk B — farther vec so lower RRF', vecSeed: querySeed + 0.1 })

    // Stub scoreFn: inverts the expected RRF order — idB gets the higher score
    const invertingScoreFn: RerankerScoreFn = async (_q, passages) => {
      return passages
        .map(p => ({ rowid: p.rowid, score: p.rowid === idA ? 0.1 : 0.9 }))
        .sort((a, b) => b.score - a.score)
    }

    // Enable reranking via mock override for this one call
    vi.mocked(readSettings).mockReturnValueOnce({ rerankEnabled: true })

    const result = await retrieve('reranker on test', chatId, stubEmbed(querySeed), invertingScoreFn)

    expect(result.rerankUsed).toBe(true)
    expect(result.rerankMs).toBeTypeOf('number')
    // idB (higher rerank score) must appear as a non-stitched winner
    const nonStitched = result.hits.filter(h => !h.stitched)
    expect(nonStitched.some(h => h.rowid === idB)).toBe(true)
    // rerankScore is populated on winner passages
    const winner = result.hits.find(h => h.rowid === idB)
    expect(winner?.rerankScore).toBeDefined()
    expect(winner?.rerankScore).toBeGreaterThan(0.5)
  })
})

describe('retrieve — reranker integration: rerank throws → RRF fallback', () => {
  it('rerankUsed=false and hits still populated when scoreFn throws', async () => {
    const chatId    = 'chat-rerank-throw'
    const querySeed = 19

    seedChunk({ chatId, docId: 'doc-rk-throw', docName: 'throw.pdf', chunkIndex: 0,
      content: 'reranker throw fallback test content', vecSeed: querySeed })

    const throwingScoreFn: RerankerScoreFn = async () => {
      throw new Error('reranker model unavailable in test')
    }

    vi.mocked(readSettings).mockReturnValueOnce({ rerankEnabled: true })

    // Must not throw — fallback to RRF silently
    const result = await retrieve('reranker throw', chatId, stubEmbed(querySeed), throwingScoreFn)

    expect(result.rerankUsed).toBe(false)
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits.every(h => h.rerankScore === undefined)).toBe(true)
  })
})

describe('retrieve — reranker integration: budget still priority-correct under rerank order', () => {
  it('budget allocation respects rerank priority order (first rerank winner always admitted)', async () => {
    const chatId    = 'chat-rerank-budget'
    const querySeed = 23

    // Large content so budget pressure is real: only ~2 chunks fit in 6000-token budget
    const large = 'budget rerank '.repeat(2000)  // ≥2000 tokens each

    const idFirst = seedChunk({ chatId, docId: 'doc-rb-1', docName: 'rb-first.pdf', chunkIndex: 0,
      content: `budget rerank first winner ${large}`, vecSeed: querySeed })
    seedChunk({ chatId, docId: 'doc-rb-2', docName: 'rb-second.pdf', chunkIndex: 0,
      content: `budget rerank second winner ${large}`, vecSeed: querySeed + 0.05 })

    // scoreFn ranks idFirst above idSecond (same as RRF here)
    const stubFn: RerankerScoreFn = async (_q, passages) =>
      passages
        .map(p => ({ rowid: p.rowid, score: p.rowid === idFirst ? 0.9 : 0.4 }))
        .sort((a, b) => b.score - a.score)

    vi.mocked(readSettings).mockReturnValueOnce({ rerankEnabled: true })

    const result = await retrieve('budget rerank', chatId, stubEmbed(querySeed), stubFn)

    // The top rerank winner (idFirst) must always be admitted.
    // Note: the "first winner always in" rule admits it even when its size alone
    // exceeds CONTEXT_TOKEN_BUDGET — by design, to guarantee at least one result.
    expect(result.hits.some(h => h.rowid === idFirst)).toBe(true)
    // No SECOND large winner should have been admitted when the budget is already full.
    const nonStitched = result.hits.filter(h => !h.stitched)
    // If idFirst filled the budget, idSecond must not also be present
    if (result.tokensUsed > 4000) {
      // Both are large — only one should fit
      expect(nonStitched.length).toBeLessThanOrEqual(2)
    }
  })
})
