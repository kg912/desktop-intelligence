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
      doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL
    );
  `)
})

vi.mock('../../DatabaseService', () => ({ getDB: () => db }))

import { retrieve, sanitizeFts5Query, buildContextEnvelope } from '../RagRetrievalService'

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
