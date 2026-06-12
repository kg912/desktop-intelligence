/**
 * Spike: cross-encoder reranker model selection — Phase 3 of RAG v2.
 *
 * For each candidate (in preference order), attempts to:
 *   1. Load the model via @xenova/transformers text-classification pipeline
 *   2. Measure cold-start ms
 *   3. Score 20 (query, ~400-token passage) pairs (warm latency)
 *   4. Verify ordering: relevant passage must outscore unrelated passage
 *
 * SELECTION RULE: highest-quality model that loads AND scores 20 pairs ≤ 1500ms warm.
 *
 * Run: npm run spike:rerank
 * Results are written to stdout for copy-paste into the spec appendix.
 */

import os   from 'os'
import path from 'path'

// ── Test data ─────────────────────────────────────────────────────────────────

const QUERY = 'What controls the step size during gradient descent training?'

const RELEVANT_PASSAGE = `
The learning rate is a hyperparameter that controls how much to adjust model
weights in response to the estimated loss gradient on each update step. Choosing
an appropriate learning rate is critical: too large a value causes the loss to
diverge; too small slows convergence to the point of impracticality. Common
schedules include cosine annealing, warmup followed by linear decay, and
cyclical learning rates.
`.trim()

const IRRELEVANT_PASSAGE = `
The French Revolution began in 1789 with the convocation of the Estates-General
by King Louis XVI. The period saw the overthrow of the monarchy, the rise of
radical republicanism, and eventually the Reign of Terror under Robespierre.
The revolution fundamentally reshaped European political thought.
`.trim()

/** 20 passages of roughly 400 tokens each — for warm latency measurement. */
function makeCorpus(): string[] {
  const topics = [
    'neural networks and backpropagation in deep learning systems',
    'transformer attention mechanisms and positional encoding',
    'stochastic gradient descent and optimisation theory',
    'regularisation techniques including dropout and weight decay',
    'batch normalisation and layer normalisation in deep learning',
  ]
  return Array.from({ length: 20 }, (_, i) => {
    const topic = topics[i % topics.length]
    const base  = `This passage provides an in-depth discussion of ${topic}. `
    return (base.repeat(28) + `(passage index ${i})`).slice(0, 1600)
  })
}

// ── Candidate list ─────────────────────────────────────────────────────────────

interface Candidate {
  id:     string
  label:  string
  note:   string
}

const CANDIDATES: Candidate[] = [
  {
    id:    'jinaai/jina-reranker-v1-tiny-en',
    label: 'jina-reranker-v1-tiny-en',
    note:  'Preferred — built for ONNX / transformers.js; tiny variant',
  },
  {
    id:    'Xenova/ms-marco-MiniLM-L-6-v2',
    label: 'ms-marco-MiniLM-L-6-v2',
    note:  'Baseline — known-good Xenova ONNX cross-encoder',
  },
  {
    id:    'mixedbread-ai/mxbai-rerank-xsmall-v1',
    label: 'mxbai-rerank-xsmall-v1',
    note:  'Larger model — included if xsmall fits latency budget',
  },
]

// ── Spike runner ──────────────────────────────────────────────────────────────

interface CandidateResult {
  id:             string
  label:          string
  loaded:         boolean
  coldStartMs?:   number
  warmMs20pairs?: number
  orderingOk?:    boolean
  relevantScore?: number
  irrelevantScore?: number
  error?:         string
}

/**
 * Score a single (query, passage) pair via the pipeline's underlying tokenizer + model.
 *
 * @xenova/transformers v2's high-level text-classification pipeline._call() does not
 * accept { text, text_pair } objects — it only accepts plain strings.  For cross-encoder
 * models we MUST encode the query-passage pair properly (i.e. [CLS] query [SEP] passage
 * [SEP]) using the tokenizer's text_pair option, then run the model forward pass
 * directly.  The Pipeline base class exposes both as `pipe.tokenizer` and `pipe.model`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scorePair(pipe: any, query: string, passage: string): Promise<number> {
  const inputs = pipe.tokenizer(query, {
    text_pair: passage,
    padding:   true,
    truncation: true,
  })
  const { logits } = await pipe.model(inputs)
  // Cross-encoder logits: shape [1, 1] (single relevance score) or [1, 2] (binary).
  // Return the first element — that is the raw relevance logit for both shapes.
  return logits.data[0] as number
}

/** Score 20 pairs sequentially; returns elapsed ms. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scoreCorpus(pipe: any, query: string, corpus: string[]): Promise<number> {
  const t0 = Date.now()
  for (const passage of corpus) {
    await scorePair(pipe, query, passage)
  }
  return Date.now() - t0
}

async function runCandidate(cand: Candidate): Promise<CandidateResult> {
  const result: CandidateResult = { id: cand.id, label: cand.label, loaded: false }
  console.log(`\n── Testing: ${cand.label} ──────────────────────────────────`)

  try {
    // Dynamic import keeps the heavy ONNX runtime out of the startup path
    const { pipeline, env } = await import('@xenova/transformers')

    // Use the same cache dir as the Electron app uses for embedding models
    const electronCache = path.join(
      os.homedir(), 'Library', 'Application Support', 'desktop-intelligence', 'models'
    )
    env.cacheDir = electronCache
    console.log(`  cache dir: ${electronCache}`)

    // ── Cold start ──────────────────────────────────────────────────────────
    const t0 = Date.now()
    const pipe = await pipeline('text-classification', cand.id)
    result.coldStartMs = Date.now() - t0
    result.loaded = true
    console.log(`  cold-start: ${result.coldStartMs} ms`)

    // ── Ordering sanity check (2 pairs) ────────────────────────────────────
    result.relevantScore   = await scorePair(pipe, QUERY, RELEVANT_PASSAGE)
    result.irrelevantScore = await scorePair(pipe, QUERY, IRRELEVANT_PASSAGE)
    result.orderingOk      = result.relevantScore > result.irrelevantScore
    console.log(`  relevant score:   ${result.relevantScore.toFixed(4)}`)
    console.log(`  irrelevant score: ${result.irrelevantScore.toFixed(4)}`)
    console.log(`  ordering correct: ${result.orderingOk}`)

    // ── Warm latency: 20 pairs (sequential — mirrors production usage) ────
    const corpus = makeCorpus()
    result.warmMs20pairs = await scoreCorpus(pipe, QUERY, corpus)
    console.log(`  warm 20-pair latency: ${result.warmMs20pairs} ms`)

  } catch (err) {
    result.error = String(err)
    console.log(`  FAILED: ${result.error}`)
  }

  return result
}

// ── Main ───────────────────────────────────────────────────────────────────────

export async function runRerankerSpike(): Promise<void> {
  console.log('=== Desktop Intelligence — Reranker Spike (Phase 3) ===')
  console.log(`Platform: ${process.platform} ${process.arch}`)
  console.log(`Node.js: ${process.version}`)
  console.log(`Candidates: ${CANDIDATES.length}`)

  const results: CandidateResult[] = []
  for (const cand of CANDIDATES) {
    results.push(await runCandidate(cand))
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n\n══════════════ SPIKE SUMMARY ══════════════')
  console.log('Model                            | Loaded | Cold(ms) | Warm20(ms) | Ordering | Notes')
  console.log('─────────────────────────────────|--------|----------|------------|----------|──────')
  for (const r of results) {
    const loaded  = r.loaded ? '  ✅   ' : '  ❌   '
    const cold    = r.coldStartMs    != null ? String(r.coldStartMs).padStart(6)    : '     -'
    const warm    = r.warmMs20pairs  != null ? String(r.warmMs20pairs).padStart(8)  : '       -'
    const order   = r.orderingOk != null ? (r.orderingOk ? '    ✅   ' : '    ❌   ') : '    -   '
    const note    = r.error ? r.error.slice(0, 60) : ''
    console.log(`${r.label.padEnd(32)} | ${loaded} | ${cold} | ${warm} | ${order} | ${note}`)
  }

  // ── Selection ─────────────────────────────────────────────────────────────
  const LATENCY_BUDGET_MS = 1500
  const chosen = results.find(r =>
    r.loaded && r.orderingOk && (r.warmMs20pairs ?? Infinity) <= LATENCY_BUDGET_MS
  )
  console.log('\n──────────────────────────────────────────')
  if (chosen) {
    console.log(`SELECTED MODEL: ${chosen.id}`)
    console.log(`  Cold start: ${chosen.coldStartMs} ms`)
    console.log(`  Warm 20-pair: ${chosen.warmMs20pairs} ms`)
    console.log(`  export const RERANKER_MODEL_ID = '${chosen.id}'`)
  } else {
    // Fallback: use baseline even if slow
    const baseline = results.find(r => r.id === 'Xenova/ms-marco-MiniLM-L-6-v2' && r.loaded)
    if (baseline) {
      console.log(`SELECTED MODEL (fallback — exceeded latency target): ${baseline.id}`)
      console.log(`  export const RERANKER_MODEL_ID = '${baseline.id}'`)
    } else {
      console.log('NO MODEL LOADED — check transformers.js version + ONNX export availability.')
    }
  }
  console.log('══════════════════════════════════════════')
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv[1]?.includes('spike-reranker')) {
  runRerankerSpike()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1) })
}
