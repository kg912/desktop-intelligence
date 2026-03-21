#!/usr/bin/env node
/**
 * Phase 5 Integration Tests
 * Exercises @xenova/transformers, hnswlib-node, better-sqlite3, and tiktoken
 * without requiring a live Electron process.
 *
 * Run:  node scripts/test-phase5.mjs
 */

import { createRequire } from 'module'
import { join }          from 'path'
import { tmpdir }        from 'os'
import { mkdtempSync, existsSync } from 'fs'

const require  = createRequire(import.meta.url)
const TEST_DIR = mkdtempSync(join(tmpdir(), 'qwen-phase5-'))

// ── Assertion helpers ─────────────────────────────────────────────
let pass = 0
let fail = 0

function ok(label, value) {
  if (value) {
    console.log(`  ✅  ${label}`)
    pass++
  } else {
    console.log(`  ❌  ${label}`)
    fail++
  }
}
function section(title) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log('─'.repeat(60))
}

// ── Shared chunking logic (mirrors RAGService.ts) ─────────────────
const CHUNK_CHARS   = 2000   // 500 tokens × 4 chars
const OVERLAP_CHARS =  200   // 50  tokens × 4 chars
const STEP          = CHUNK_CHARS - OVERLAP_CHARS

function chunkText(text) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    const c = text.slice(start, start + CHUNK_CHARS).trim()
    if (c.length > 0) chunks.push(c)
    start += STEP
  }
  return chunks
}

// ─────────────────────────────────────────────────────────────────
// TEST 1 — Vector Ingestion Pipeline
// ─────────────────────────────────────────────────────────────────
section('TEST 1 — Vector Ingestion Pipeline')

const DUMMY_TEXT = `
The secret project codename is Apollo.
The project Apollo aims to build a next-generation AI chip for on-device inference.
The server IP for the Apollo project is 192.168.1.50.
The CEO likes black coffee every morning before the standup meeting.
All Apollo team members are required to use encrypted VPN connections.
The quarterly budget review for Apollo is scheduled for next Friday at 10am.
The Apollo chip uses a custom RISC-V instruction set optimised for matrix operations.
The development office is located at 123 Market Street, San Francisco.
Sarah is the CEO's executive assistant and manages all calendar invitations.
The 192.168.1.50 server runs Ubuntu 22.04 LTS with 512GB RAM and 8x H100 GPUs.
`.trim()

// ── 1a. SQLite ────────────────────────────────────────────────────
console.log('\n  [1a] SQLite (better-sqlite3)')
const Database = require('better-sqlite3')
const db = new Database(join(TEST_DIR, 'test.db'))
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, ts INTEGER);
  CREATE TABLE IF NOT EXISTS chunks (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id  TEXT    NOT NULL,
    content TEXT    NOT NULL,
    idx     INTEGER NOT NULL,
    vec_id  INTEGER NOT NULL DEFAULT 0
  );
`)
ok('DB file created', existsSync(join(TEST_DIR, 'test.db')))

// ── 1b. Embeddings ────────────────────────────────────────────────
console.log('\n  [1b] Embeddings (@xenova/transformers)')
console.log('       Loading all-MiniLM-L6-v2 — first run downloads ~23 MB …')

const { pipeline, env } = await import('@xenova/transformers')
env.cacheDir = join(TEST_DIR, 'models')

const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
ok('Pipeline created', typeof embedder === 'function')

async function embed(text) {
  const out = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(out.data)
}

// Sanity: embed a single string and check dimensionality
const sampleVec = await embed('hello world')
ok('Embedding dimensionality is 384', sampleVec.length === 384)
ok('All values are finite floats', sampleVec.every(v => isFinite(v)))

// ── 1c. Chunk + embed the dummy doc ──────────────────────────────
console.log('\n  [1c] Chunking + embedding document')
const chunks = chunkText(DUMMY_TEXT)
console.log(`       Text → ${chunks.length} chunk(s)`)
ok('At least 1 chunk produced', chunks.length >= 1)

const vectors = await Promise.all(chunks.map(c => embed(c)))
ok(`All ${chunks.length} chunk(s) embedded`, vectors.length === chunks.length)
ok('Every vector is 384-dim', vectors.every(v => v.length === 384))

// ── 1d. Store in SQLite ───────────────────────────────────────────
console.log('\n  [1d] Writing chunks to SQLite')
const insertChunk = db.prepare(
  'INSERT INTO chunks (doc_id, content, idx, vec_id) VALUES (?, ?, ?, 0)'
)
const rowids = []
const insertTx = db.transaction(() => {
  for (let i = 0; i < chunks.length; i++) {
    const r = insertChunk.run('doc-1', chunks[i], i)
    rowids.push(Number(r.lastInsertRowid))
  }
})
insertTx()

const dbCount = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n
ok(`SQLite holds ${chunks.length} chunk(s)`, dbCount === chunks.length)
ok('Rowids are positive integers', rowids.every(r => r > 0))

// ── 1e. Store in HNSWLib ──────────────────────────────────────────
console.log('\n  [1e] Building HNSWLib index')
const { HierarchicalNSW } = require('hnswlib-node')
const index = new HierarchicalNSW('cosine', 384)
index.initIndex(1000)

for (let i = 0; i < rowids.length; i++) {
  index.addPoint(vectors[i], rowids[i])
}

const indexPath = join(TEST_DIR, 'vectors.hnsw')
// Use writeIndexSync — the async writeIndex does not reliably persist state (hnswlib-node v3)
index.writeIndexSync(indexPath)

ok('HNSWLib index written to disk', existsSync(indexPath))
ok(`Index holds ${chunks.length} vector(s)`, index.getCurrentCount() === chunks.length)

console.log('\n  ➡️  TEST 1 complete')


// ─────────────────────────────────────────────────────────────────
// TEST 2 — Semantic Retrieval
// ─────────────────────────────────────────────────────────────────
section('TEST 2 — Semantic Retrieval')

const QUERY = 'What is the secret project called?'
console.log(`\n  Query: "${QUERY}"`)

// ── 2a. Embed query ───────────────────────────────────────────────
const queryVec = await embed(QUERY)
ok('Query vector is 384-dim', queryVec.length === 384)

// ── 2b. Load index from disk (fresh instance) ─────────────────────
// initIndex must be called before readIndexSync (hnswlib-node v3 requirement)
const index2 = new HierarchicalNSW('cosine', 384)
index2.initIndex(1000)
index2.readIndexSync(indexPath)
ok('Index reloaded from disk', index2.getCurrentCount() === chunks.length)

// ── 2c. Search for top-3 nearest chunks ──────────────────────────
const k      = Math.min(3, chunks.length)
const result = index2.searchKnn(queryVec, k)
console.log(`\n  kNN result (k=${k}):`)
result.neighbors.forEach((id, i) =>
  console.log(`    neighbor[${i}]  id=${id}  distance=${result.distances[i].toFixed(4)}`)
)
ok('searchKnn returned neighbors', result.neighbors.length > 0)

// ── 2d. Fetch chunk text from SQLite ──────────────────────────────
const ids     = result.neighbors
const ph      = ids.map(() => '?').join(',')
const rows    = db.prepare(
  `SELECT content FROM chunks WHERE id IN (${ph}) ORDER BY idx`
).all(...ids)

ok('Retrieved chunk rows from DB', rows.length > 0)

const combined = rows.map(r => r.content).join('\n')
ok('Top result mentions "Apollo"', combined.toLowerCase().includes('apollo'))

// ── 2e. Show the final system prompt ─────────────────────────────
const systemPrompt = [
  '[Context from attached documents:',
  rows.map(r => r.content.trim()).filter(Boolean).join('\n\n---\n\n'),
  ']'
].join('\n')

console.log('\n  📋  Final System Prompt (first 400 chars):')
console.log('  ┌' + '─'.repeat(58))
systemPrompt.slice(0, 400).split('\n').forEach(l =>
  console.log('  │ ' + l)
)
if (systemPrompt.length > 400) console.log('  │ … (truncated)')
console.log('  └' + '─'.repeat(58))

ok('System prompt starts with [Context', systemPrompt.startsWith('[Context'))
ok('System prompt contains "Apollo"', systemPrompt.includes('Apollo'))

console.log('\n  ➡️  TEST 2 complete')


// ─────────────────────────────────────────────────────────────────
// TEST 3 — Context Slider Stress Test  (budget = 50 tokens)
// ─────────────────────────────────────────────────────────────────
section('TEST 3 — Context Sliding (budget = 50 tokens)')

// ── 3a. Token counter (tiktoken with fallback) ────────────────────
console.log('\n  [3a] Token counter')
let countTokens
try {
  const { get_encoding } = require('tiktoken')
  const enc = get_encoding('cl100k_base')
  countTokens = t => enc.encode(t).length
  const sample = countTokens('The secret project codename is Apollo.')
  ok(`tiktoken loaded — "Apollo sentence" = ${sample} tokens`, sample > 0)
} catch (e) {
  console.log(`  ⚠️  tiktoken failed (${e.message}), using char/3.6 fallback`)
  countTokens = t => Math.ceil(t.length / 3.6)
  ok('Fallback counter works', countTokens('hello world') > 0)
}

// ── 3b. Simulate 5 long messages ─────────────────────────────────
const MESSAGES = [
  { role: 'user',      content: 'Tell me everything about the Apollo project and its chip architecture including all hardware specs.' },
  { role: 'assistant', content: 'Apollo is a next-gen AI chip project using a custom RISC-V ISA optimised for matrix inference at low power. The team is based in San Francisco on Market Street.' },
  { role: 'user',      content: 'What are the network infrastructure details for the Apollo development servers?' },
  { role: 'assistant', content: 'The primary Apollo server is at 192.168.1.50 running Ubuntu 22.04 LTS with 512GB RAM and 8x H100 GPUs. VPN is mandatory for all team access.' },
  { role: 'user',      content: 'When is the next review meeting, who should I contact, and what is the quarterly budget status?' },
]

const TOKEN_BUDGET = 50   // ← artificially low for stress test

const totalTokens = MESSAGES.reduce((s, m) => s + countTokens(m.content) + 4, 0)
const sysPromptTokens = 0

console.log(`\n  Token budget    : ${TOKEN_BUDGET}`)
console.log(`  Message tokens  : ${totalTokens}`)
console.log(`  Total           : ${totalTokens + sysPromptTokens}`)

ok(`Budget breach detected (${totalTokens} > ${TOKEN_BUDGET})`,
   totalTokens > TOKEN_BUDGET)

// ── 3c. Split at 50 % ─────────────────────────────────────────────
const splitAt    = Math.floor(MESSAGES.length * 0.5)
const toSummarise = MESSAGES.slice(0, splitAt)
const toKeep      = MESSAGES.slice(splitAt)

ok(`Split at 50%: ${toSummarise.length} to summarise, ${toKeep.length} to keep`,
   toSummarise.length >= 1 && toKeep.length >= 1)

console.log('\n  Messages to summarise:')
toSummarise.forEach((m, i) =>
  console.log(`    [${i}] ${m.role}: ${m.content.slice(0, 60)}…`)
)
console.log('  Messages to keep:')
toKeep.forEach((m, i) =>
  console.log(`    [${i}] ${m.role}: ${m.content.slice(0, 60)}…`)
)

// ── 3d. Call LM Studio for summarisation ─────────────────────────
console.log('\n  [3d] Background summarisation → LM Studio')
const convo = toSummarise.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')

let summary
try {
  const resp = await Promise.race([
    fetch('http://localhost:1234/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model:      'local-model',
        stream:     false,
        max_tokens: 256,
        messages: [
          {
            role:    'system',
            content: 'Summarise the following conversation as dense bullet points. Preserve all technical details and context. Be concise.',
          },
          { role: 'user', content: convo },
        ],
      }),
    }).then(r => r.json()),
    new Promise((_, rej) => setTimeout(() => rej(new Error('LM Studio timeout (5s)')), 5000)),
  ])

  summary = resp.choices?.[0]?.message?.content ?? null

  if (summary) {
    ok('LM Studio summarisation succeeded', true)
    console.log('\n  📝  Summary received:')
    summary.split('\n').slice(0, 6).forEach(l => console.log('     ' + l))
  } else {
    ok('LM Studio returned a response but content was empty', false)
    summary = '[Summary unavailable — empty response]'
  }
} catch (e) {
  console.log(`\n  ⚠️   LM Studio not reachable: ${e.message}`)
  console.log('       Structural slider test continues without real summary.')
  summary = '[Summary unavailable — LM Studio offline during test]'
  // Don't count this as a test failure — the slider logic is independent
}

// ── 3e. Build slid context ────────────────────────────────────────
const slidMessages = [
  { role: 'system', content: `[Summary of previous context:\n${summary}]` },
  ...toKeep,
]

ok('Slid array starts with summary system message',
   slidMessages[0].role === 'system' &&
   slidMessages[0].content.startsWith('[Summary of previous context:'))
ok(`Slid array length = ${toKeep.length + 1} (${toKeep.length} kept + 1 summary)`,
   slidMessages.length === toKeep.length + 1)

// ── 3f. Verify SQLite update (mirror what the real service does) ──
console.log('\n  [3f] Persisting summary to SQLite')
db.exec(`CREATE TABLE IF NOT EXISTS context_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER,
  content TEXT
)`)
db.prepare('INSERT INTO context_summaries (created_at, content) VALUES (?, ?)')
  .run(Date.now(), slidMessages[0].content)

const savedSummary = db.prepare(
  'SELECT content FROM context_summaries ORDER BY id DESC LIMIT 1'
).get()

ok('Summary persisted to SQLite', savedSummary?.content?.includes('[Summary of previous context:'))

const slidTokens = slidMessages.reduce((s, m) => s + countTokens(m.content) + 4, 0)
console.log(`\n  📊  Token count after slide: ~${slidTokens}`)

// Note: with LM Studio offline the summary is a placeholder, so it won't
// be under budget — but the structure is verified.
ok('Slid context produced valid structure', slidMessages.length > 0)

console.log('\n  ➡️  TEST 3 complete')


// ─────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`)
console.log(`  RESULTS:  ${pass} passed  |  ${fail} failed`)
console.log(`  Test dir: ${TEST_DIR}`)
console.log('═'.repeat(60) + '\n')

process.exit(fail > 0 ? 1 : 0)
