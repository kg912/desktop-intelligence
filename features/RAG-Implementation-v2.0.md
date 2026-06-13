# RAG Implementation v2.0 — How It Works, End to End

**Project:** Desktop Intelligence
**Status:** Phases 0–3 implemented and live (hybrid retrieval + flag-gated reranker).
Phases 4–5 (observability polish, v1 demolition) pending — see `specs/RAG-v2-Implementation-Plan.md`.
**Purpose of this file:** A standing, human-readable description of the v2 RAG pipeline —
what happens to a file from the moment it's dropped into a chat to the moment its content
shows up in a model's answer. Maintained alongside the implementation so the system never
becomes a black box. Updated at the end of every build phase.

---

## 0. The one-paragraph version

When you attach a file, it's extracted and measured. Small files (≤ 50% of your configured
context window) skip RAG
entirely — the whole text rides along with every message, because nothing retrieves better
than "all of it." Large files are split into ~400-token, boundary-respecting chunks; every
chunk is indexed **twice** — once in a BM25 keyword index (SQLite FTS5) and once as a
384-dim semantic vector (sqlite-vec) — inside the same SQLite database the app already uses.
On every message you send in that chat, your question runs against both indexes in parallel,
the two ranked lists are merged with Reciprocal Rank Fusion, the winning passages (plus
their immediate neighbours) are assembled under a token budget with file/section provenance,
and spliced into the request as a single, calm system message. If nothing relevant is found,
the model is told that honestly instead of being fed the first 32 chunks of the oldest file.

---

## 1. Why v1 had to go

| | v1 (FTS5-only, Phase 28) | v2 |
|---|---|---|
| Chunking | 1,800 **characters**, mid-word cuts | ~400 **tokens**, paragraph/sentence boundaries, section titles preserved |
| Semantic retrieval | None — keyword match only | Dense vectors, finds paraphrases ("optimizer convergence" ↔ "gradient descent stationary point") |
| Keyword retrieval | FTS5 BM25 ✓ (the one good part) | Kept, fused with vectors |
| No-match behaviour | Dump first 32 chunks chronologically | Honest "no relevant passages" note |
| Small docs | 12k-char blob inject **and** FTS5 retrieval simultaneously — duplicated, uncoordinated | One path: full inline injection, no retrieval |
| Embeddings | `EmbeddingService` existed, wired to nothing | Core of the dense index |
| Vector store | hnswlib (broken in packaged builds, dead code) | sqlite-vec in the main DB, transactional |
| Chat deletion | Chunks orphaned forever | Full cascade cleanup |
| Re-upload same file | Double-indexed | Content-hash dedup |
| Prompt style | ALL-CAPS "YOU MUST ACT AS IF…" directive | Structured `<attached_file_context>` envelope |

---

## 2. Bird's-eye architecture

```
                        ┌─────────────────────────────────────────────────┐
                        │              Electron Main Process              │
                        │                                                 │
  file dropped ───────► │  FileProcessorService                           │
                        │   │  extract (pdf-parse / fs) + sanitize        │
                        │   │  count tokens (tokenUtils)                  │
                        │   ▼                                             │
                        │  ≤ 50% of context window?                       │
                        │   ├── yes ──► documents(mode='inline')          │
                        │   │           doc_inline_text (full text)       │
                        │   └── no ───► RagIngestionService               │
                        │                │ RagChunker (~400 tok chunks)   │
                        │                │ EmbeddingService (MiniLM 384d) │
                        │                ▼                                │
                        │       ┌─────────────────────────────┐           │
                        │       │   desktop-intelligence.db   │           │
                        │       │  rag_chunks   (source rows) │           │
                        │       │  chunks_fts   (BM25 index)  │           │
                        │       │  chunks_vec   (vec0 index)  │           │
                        │       └─────────────────────────────┘           │
                        │                ▲                                │
  user sends message ─► │  handlers.ts (CHAT_SEND)                        │
                        │   └─► RagRetrievalService.retrieve(query, chat) │
                        │        hybrid search → RRF → assemble           │
                        │   └─► splice ONE system envelope into messages  │
                        │   └─► ChatService.send()  (untouched by v2)     │
                        └─────────────────────────────────────────────────┘
```

Everything is in-process. No sidecars, no network, no second database file.

---

## 3. Ingestion, step by step

```
attach lecture-notes.pdf (34 pages)
        │
        ▼
┌──────────────────────────────┐
│ 1. EXTRACT                   │  pdf-parse v2 → raw text (e.g. 96,000 chars)
│ 2. SANITIZE                  │  prompt-injection regex pass (unchanged from v1)
│ 3. MEASURE                   │  tokenUtils → 26,400 tokens; INLINE_BUDGET =
│                              │  floor(0.5 × configured context window) → 'indexed'
│ 4. HASH                      │  sha256(text); already in this chat? → skip (dedup)
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ 5. CHUNK (RagChunker)        │
│   target 400 tokens          │   split preference, in order:
│   overlap  60 tokens (~15%)  │   blank line ▸ newline ▸ sentence end ▸ word ▸ hard cut
│   char estimate only         │   splits use 3.5 chars/token estimate (no tokenUtils
│   track nearest heading      │   in hot path — avoids O(n²) cost on large docs)
│                              │   "§3 Optimization" travels with its chunks
└──────────────┬───────────────┘
               ▼   ~70 chunks
┌──────────────────────────────┐
│ 6. EMBED (per chunk)         │   text embedded WITH a provenance header:
│                              │   "[lecture-notes.pdf §3 Optimization, part 12/70]
│   all-MiniLM-L6-v2 (ONNX)    │    <chunk text>"
│   384-dim, ~4 ms/chunk warm  │   (header improves embedding quality; the stored
│                              │    row keeps the clean text only)
└──────────────┬───────────────┘
               ▼
┌──────────────────────────────┐
│ 7. STORE — one transaction   │   rowid N is the join key everywhere:
│   rag_chunks   row N         │   ├── chunks_fts row N  (via sync trigger)
│                              │   └── chunks_vec row N  (explicit insert)
└──────────────────────────────┘
```

A small file (say a 3-page paper, 2,100 tokens) stops at step 3: one `documents` row with
`mode='inline'`, full text in `doc_inline_text`, zero chunks, zero vectors.

---

## 4. Retrieval, step by step

User asks: *"how does the model avoid overfitting?"* — and the document never uses the
word "overfitting"; it talks about "L2 regularization" and "early stopping".

```
                       "how does the model avoid overfitting?"
                                        │
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                   ▼
┌──────────────────────────────┐                  ┌──────────────────────────────┐
│  LEXICAL — chunks_fts (BM25) │                  │  SEMANTIC — chunks_vec (KNN) │
│  sanitized MATCH query       │                  │  embed(query) → cosine top-20│
│  scoped to this chat_id      │                  │  scoped to this chat_id      │
│  top-20 by bm25 rank         │                  │                              │
│                              │                  │  finds: "L2 regularization   │
│  finds: chunks containing    │                  │  penalises large weights…",  │
│  "model", "avoid"… (weak)    │                  │  "early stopping halts…" ✓✓  │
└──────────────┬───────────────┘                  └──────────────┬───────────────┘
               │            two independent ranked lists         │
               └────────────────────┬─────────────────────────────┘
                                    ▼
                  ┌─────────────────────────────────────┐
                  │  RECIPROCAL RANK FUSION  (k = 60)   │
                  │  score(c) = Σ 1/(60 + rank_i(c))    │
                  │  rank-based → no score-scale fights │
                  │  relevance floor → may yield ZERO   │
                  └──────────────────┬──────────────────┘
                                     ▼  top fused candidates
                  ┌─────────────────────────────────────┐
                  │  CROSS-ENCODER RERANK (flag, off)   │
                  │  jinaai/jina-reranker-v1-tiny-en    │
                  │  scores top-20 (query, chunk) pairs │
                  │  215 ms warm / 20 pairs (M5 Pro)    │
                  └──────────────────┬──────────────────┘
                                     ▼  final 6 (RRF) or 8 (rerank) winners
                  ┌─────────────────────────────────────┐
                  │  PRIORITY BUDGET + NEIGHBOUR STITCH │
                  │  pass 1: admit winners in relevance │
                  │  order until ~6,000-token budget    │
                  │  (a big low-rank chunk is skipped,  │
                  │  never displaces a better one)      │
                  │  pass 2: fill remaining budget with │
                  │  chunk_index ±1 neighbours          │
                  │  then sort survivors by doc + index │
                  │  for reading order (tokenUtils)     │
                  └──────────────────┬──────────────────┘
                                     ▼
                     one <attached_file_context> system
                     message, spliced before the last
                     user turn → ChatService.send()
```

Why both retrievers, always:

| Query type | BM25 alone | Vectors alone | Hybrid |
|---|---|---|---|
| "QJL kernel function signature" (exact identifier) | ✓ nails it | ✗ may drift to similar-ish code talk | ✓ |
| "how does it avoid overfitting" (paraphrase) | ✗ no shared words | ✓ | ✓ |
| "MU Q2 earnings figure" (rare token + concept) | ~ | ~ | ✓ fusion wins |

This BM25 + dense + RRF (+ rerank) cascade is the consensus production architecture in
2026 — the same shape used by Elasticsearch/Weaviate hybrid modes and validated repeatedly
in retrieval benchmarks; reranking alone is worth double-digit recall/MRR points when
enabled.

---

## 5. What the model actually receives

```
messages (wire payload)
├── system: global system prompt (SystemPromptService — unchanged)
├── user:   "summarise section 2"            ← earlier turns
├── assistant: "…"
├── system: <attached_file_context>          ← THE ONE RAG MESSAGE, this turn only
│            The user attached files to this conversation. Their content (full
│            documents and/or passages retrieved for the current question) is
│            below. Treat it as readable file content; cite the file name when
│            drawing on it. If it does not contain the answer, say so.
│
│            [lecture-notes.pdf · §3 Optimization · part 11/70]
│            …L2 regularization penalises large weights…
│
│            [lecture-notes.pdf · §3 Optimization · part 12/70]   ← stitched neighbour
│            …early stopping monitors validation loss…
└── user:   "how does the model avoid overfitting?"   ← last user turn
```

Rules the envelope obeys:
- **Exactly one** context message per turn. Inline docs and retrieved passages never
  double-inject for the same document (a doc is either `inline` or `indexed`, never both).
- Rebuilt fresh every turn from the current question — never accumulates in history.
- No-hit case: the passages are replaced by an honest note —
  `Retrieval found no passages relevant to this question in the attached files
  (lecture-notes.pdf). State this honestly if asked about their content.`
  Sent as a bare system line when the chat has no inline docs, or inside the
  envelope alongside inline content when it does. The model can then say "the
  document doesn't cover this" instead of improvising.

---

## 6. Data model

```
documents ─────────────┐ 1:N (indexed docs)            1:1 (inline docs)
  id, name, ts,        ├──► rag_chunks ──────────┐       └──► doc_inline_text
  chat_id,             │     id (rowid) ◄────────┼─────────────┐
  mode,                │     doc_id, chat_id     │  same rowid │
  content_hash,        │     doc_name            │  everywhere │
  token_count          │     chunk_index         │             │
                       │     section_title       ▼             ▼
                       │     content        chunks_fts    chunks_vec
                       │                    (FTS5 BM25,   (vec0, 384-d float
                       │                    external-     vectors + chat_id
                       │                    content,      PARTITION KEY → native
                       │                    trigger-      per-chat KNN scoping
                       │                    synced)       and direct deletion)
chat deleted ──► deleteRagDataForChat(chatId) wipes all of the above for that chat
```

| Table | Kind | Holds | Size driver |
|---|---|---|---|
| `documents` | plain | one row per attached file | files attached |
| `doc_inline_text` | plain | full text of small docs | small files only |
| `rag_chunks` | plain | clean chunk text + provenance | the source of truth |
| `chunks_fts` | FTS5 virtual | inverted keyword index over `rag_chunks.content` | ~same as chunks |
| `chunks_vec` | vec0 virtual | 384 floats/chunk ≈ 1.5 KB | ~1.5 MB per 1,000 chunks |

At this app's scale (a chat holds a handful of documents → hundreds, maybe low thousands
of chunks) sqlite-vec's brute-force KNN is single-digit milliseconds. No ANN index, no
index-vs-data drift, no separate file to corrupt — the lesson of hnswlib.

---

## 7. Defaults & knobs

| Knob | Default | Meaning |
|---|---|---|
| `INLINE_BUDGET` | 0.5 × configured context window | At/under this (measured at ingest), a doc is `inline` — whole text every turn. Scales with the window by design: the context window is **user-declared capacity**. If you configure a 128k window knowing your machine can take it, the app should use it for your documents rather than second-guessing you with a fixed cap. A whole document always beats retrieval over it. Send-time safety cap: if you shrink the window *after* ingesting, combined inline text is truncated to 0.5 × the current window with an explicit notice inside the envelope. |
| `CHUNK_TOKENS` / `CHUNK_OVERLAP_TOKENS` | 400 / 60 | Chunk geometry |
| `K_LEXICAL` / `K_VECTOR` | 20 / 20 | Candidates per retriever |
| `RRF_K` | 60 | Fusion smoothing constant (industry default) |
| `VEC_DISTANCE_FLOOR` | 1.15 | L2-distance ceiling for vector candidates before fusion. Embeddings are L2-normalized, so L2 distance is rank-equivalent to cosine: 1.15 ≈ cosine similarity 0.34. Anything farther is noise and is dropped — this is what makes the honest no-hit possible. |
| `FINAL_K` / `FINAL_K_RERANKED` | 6 / 8 | Passages handed to budget allocation (RRF path / rerank path) |
| `RERANK_CANDIDATES` | 20 | Top RRF candidates passed to the cross-encoder when rerank is on |
| `CONTEXT_TOKEN_BUDGET` | 6,000 tok | Hard cap on the envelope |
| `RERANK_ENABLED` | **off** (default) | Cross-encoder reranker toggle — Settings → Debug → "Re-rank retrieved passages". Requires one-time ~7 MB model download (jinaai/jina-reranker-v1-tiny-en). Adds ~215 ms warm (M5 Pro) / est. ~500 ms (M1 Pro). |
| Embedding model | all-MiniLM-L6-v2, 384-d | Shared `EmbeddingService` primitive; swappable constant |
| Reranker model | jinaai/jina-reranker-v1-tiny-en | `RerankerService` — selected by Phase 3 spike; RERANKER_MODEL_ID constant |

## 8. Failure behaviour (graceful, never blocking)

```
sqlite-vec won't load ──► FTS5-only retrieval, logged once      chat unaffected
embed() throws        ──► FTS5-only for that query              chat unaffected
FTS5 syntax error     ──► dense-only for that query             chat unaffected
both come back empty  ──► honest no-hit note                    chat unaffected
rerank() throws       ──► [RAG] warn logged, RRF order used    chat unaffected
ingestion fails       ──► error logged, message still sends     chat unaffected
```

## 9. Build status

| Phase | Scope | Status |
|---|---|---|
| 0 | sqlite-vec packaged-build validation spike | ✅ Done (2026-06-11) — dev 0.07ms KNN, packaged 0.15ms, partition key confirmed |
| 1 | Schema v2, chunker, dual-index ingestion (v1 still serving) | ✅ Done (2026-06-11) — dual-write live; v1 path untouched; 43 new tests |
| 2 | Hybrid retrieval + RRF, handlers cutover | ✅ Done (2026-06-11) — FTS5+KNN+RRF live, v1 path fully removed, inject=null, 717/718 tests |
| 3 | Local cross-encoder rerank (flag, default off) | ✅ Done (2026-06-12) — jinaai/jina-reranker-v1-tiny-en; cold 93ms, warm20 215ms; 9 new tests |
| 4 | Observability traces, evaluation harness, chunk inspector | ✅ Done (2026-06-13) — rag_ingest/rag_query events, coveragePct, RetrieveOptions, RagQueryTrace, RagEvalService, IPC diagnostics, Debug panel extensions, 40 new tests |
| 5 | Demolition: RAGService.ts, VectorStoreService.ts, hnswlib-node removed | ⏳ |

*(Update this table and any sections that drift as phases land.)*

---

## 10. Observability & evaluation (Phase 4)

### 10.1 Observability events

Phase 4 adds two new event types written to `<logsDir>/rag-events.jsonl` (fire-and-forget,
non-fatal; file rotates with each app launch). View events from Settings → Debug → Observability Logs.
Unknown event types are rendered as formatted JSON — the existing panel handles them correctly.

#### `rag_ingest`

Emitted by `RagIngestionService` after every document ingest (both `indexed` and `inline` mode).

```jsonc
{
  "ts": 1718000000000,
  "type": "rag_ingest",
  "payload": {
    "docId": "uuid-...",
    "docName": "paper.pdf",
    "chatId": "chat-uuid",
    "mode": "indexed",          // "indexed" | "inline"
    "tokenCount": 12480,        // estimated tokens at ingest time
    "inlineBudget": null,       // null when indexed; integer token cap when inline
    "chunkCount": 31,           // rag_chunks rows created (0 if inline)
    "vectorCount": 31,          // chunks_vec rows created (0 if embed failed)
    "coveragePct": 100.00,      // (lastChunk.charEnd / rawText.length) × 100
    "embedMsTotal": 2341,       // wall-clock ms for all embed() calls
    "durationMs": 2580,         // total ingest wall-clock ms
    "degraded": false           // true if embed failed and fell back to FTS5-only
  }
}
```

**`coveragePct`** proves the chunker consumed the whole document. A value < 100 would indicate a
real chunker bug (the test suite asserts `coveragePct === 100` for normally-sized documents and
will fail loudly if that guarantee ever breaks).

#### `rag_query`

Emitted by the `handlers.ts` retrieval path after every `retrieve()` call.

When the **Verbose RAG tracing** toggle is **off** (default), `contentPreview` fields and
`finalPassages` text are omitted from the event so the JSONL file stays compact.

When **on**, every field is populated. Toggle lives in Settings → Debug → "Verbose RAG tracing
(logs full retrieved chunk text)".

```jsonc
{
  "ts": 1718000000000,
  "type": "rag_query",
  "payload": {
    "query": "what does the paper say about dropout?",
    "sanitizedFtsQuery": "paper say dropout",
    "chatId": "chat-uuid",
    "timestamp": "2026-06-13T10:00:00.000Z",
    "mode": "hybrid",
    "rerankUsed": false,
    "lexical": [{ "rowid": 42, "rank": 1, "docName": "paper.pdf", "chunkIndex": 7,
                  "contentPreview": "Dropout regularizes..." }],
    "vector":  [{ "rowid": 42, "distance": 0.41, "cosineSim": 0.916,
                  "docName": "paper.pdf", "chunkIndex": 7,
                  "contentPreview": "Dropout regularizes...", "dropped": false }],
    "fused":   [{ "rowid": 42, "rrfScore": 0.0323, "inLexical": true, "inVector": true }],
    "rerank": null,
    "allocation": [{ "rowid": 42, "decision": "admitted", "tokens": 381 }],
    "finalPassages": ["[paper.pdf · chunk 7]\nDropout regularizes..."],
    "envelopeTokens": 381
  }
}
```

**`vector.dropped: true`** marks candidates filtered out by `VEC_DISTANCE_FLOOR=1.15`
(L2 ≥ 1.15 ≈ cosine similarity ≤ 0.34 — noise). They appear in the trace for diagnostics
even though they never reach the fusion step.

**`cosineSim`** is derived from the L2 distance via `1 − d² / 2` (valid because embeddings
are L2-normalised to unit length).

**Allocation decisions:**

| decision | meaning |
|---|---|
| `admitted` | chunk fits in the token budget and is sent to the model |
| `skipped_too_big` | chunk is larger than remaining budget in pass 1 |
| `not_reached` | budget exhausted; this winner was never considered |
| `stitched` | ±1 neighbour admitted in pass 2 to provide context continuity |
| `stitch_rejected_budget` | stitch candidate would exceed remaining budget |

### 10.2 Chunk inspector

**IPC** `rag:export-chunks(docId)` — main-process handler in
`src/main/ipc/ragDiagnosticsHandlers.ts`. Writes a markdown file to the user's Downloads folder:

```
rag-chunks-<docName>-<timestamp>.md
```

File structure:
```
# Chunks: paper.pdf
- **Mode:** indexed
- **Token count:** 12,480
- **Chunk count:** 31
- **Coverage:** 100.00%

---

## [#0 · §Introduction · chars 0–1842 · ~412 tok]
<full chunk text>

## [#1 · §Introduction · chars 1782–3601 · ~403 tok]
...
```

**Debug panel** — Settings → Debug → "RAG Diagnostics" subsection:
- Chatid input → "Load docs" → lists indexed documents with name / mode / token count / chunk count
- "Export chunks" button per document → triggers `rag:export-chunks`

### 10.3 Evaluation harness

#### Eval file format (JSONL)

One JSON object per line. Lines starting with `#` are comments (ignored by the parser).

```jsonc
// evals/eval.jsonl
{ "query": "what does the paper say about dropout regularization?",
  "relevant": ["dropout regularizes", "prevents overfitting"],
  "note": "Section 4.2" }
{ "query": "what optimiser does the paper use?",
  "relevant": ["Adam optimiser", "learning rate 3e-4"] }
```

**Relevance rule:** a chunk is relevant to a query iff its content, after normalisation
(lowercase + collapse whitespace), contains **any** of the `relevant` substrings. OR semantics —
any match is sufficient.

A query whose `relevant` snippets match zero chunks in the corpus is flagged as `unresolvable`
and excluded from the aggregates (check your snippets).

**Worked example:**

Corpus chunk content: `"L2 Regularization prevents overfitting by penalizing large weights."`

Query: `"how does L2 regularization work?"`
Snippet: `"l2 regularization prevents"` (after normalisation)
→ chunk is **relevant** (substring match)

#### Ablation table interpretation

`runEval` runs every query through four modes and reports the aggregate metrics:

| Mode | What it tests |
|---|---|
| `lexical-only` | Pure BM25 — how well keywords alone surface relevant content |
| `vector-only` | Pure semantic similarity — catches paraphrase, misses exact terms |
| `hybrid` | RRF fusion of both — the production default |
| `hybrid+rerank` | Hybrid + cross-encoder reranker — higher precision at cost of latency |

**Reading the table:**

- If `vector-only Hit@K ≫ lexical-only Hit@K` → your documents use varied terminology / paraphrase
  (the embedding model generalises better than BM25 for your corpus style)
- If `lexical-only Hit@K ≫ vector-only Hit@K` → your queries use the same exact terms as the
  documents (precise technical jargon; BM25 thrives here)
- `hybrid` should beat or match both unimodal modes on Hit@K — if it doesn't, check that
  `VEC_DISTANCE_FLOOR` is not too tight (filtering good semantic candidates)
- `hybrid+rerank MRR > hybrid MRR` at similar Hit@K → the reranker is reordering correctly
  (most-relevant chunk moves to rank 1)

**Metrics:**

| Metric | Definition |
|---|---|
| Hit@K | 1 if any relevant chunk is in the top-K admitted passages; 0 otherwise |
| Precision@K | (relevant chunks in top-K) / (top-K count) |
| Recall@K | (relevant chunks in top-K) / (total relevant chunks in corpus) |
| MRR | 1 / rank of first relevant chunk in the **priority order** (rerank score → RRF score). This is the order in which the pipeline actually ranks chunks for the model — NOT the alphabetical presentation order. |
| Candidate Recall | (relevant chunks in top-20 candidate pool) / (all relevant chunks). The candidate pool is the pre-FINAL_K/pre-budget stage: `trace.lexical` for lexical-only, `trace.vector` (non-dropped) for vector-only, `trace.fused` (RRF-desc) for hybrid modes. **`CandRec=1.0` + `Recall@K=0.0` ⇒ the retriever found the chunk but FINAL_K or the token budget dropped it before presentation — raise `FINAL_K` or `CONTEXT_TOKEN_BUDGET`. `CandRec=0.0` ⇒ true retrieval miss — check embedding quality or add lexical synonyms.** |

All per-query values are averaged across queries to produce the aggregates.

#### Running an eval

1. Build your eval file at `evals/eval.jsonl` (gitignored — never committed)
2. In Settings → Debug → "Run RAG Eval": enter the file path and the chat ID of the indexed
   conversation, then click **Run eval**
3. A markdown report is written to Downloads (`rag-eval-<timestamp>.md`) and the aggregates
   are displayed inline in the Debug panel

### 10.4 Phase 4 deviations from the work order

- **Observability panel rendering**: the existing panel renders unknown event types as formatted
  JSON already — no renderer changes were needed for `rag_ingest` / `rag_query` events. This
  was confirmed in the work order as acceptable.
- **`coveragePct` for inline docs**: inline-mode docs skip chunking entirely, so `coveragePct`
  is set to 100 by convention (whole text sent verbatim — no coverage loss possible).
- **`hybrid+rerank` graceful skip**: if `RerankerService` fails to initialise, the mode is
  included in the report with a `note: "reranker unavailable"` and metrics from the hybrid
  (non-reranked) result so the report still has four rows.
- **IPC channel naming**: `rag:export-chunks`, `rag:run-eval`, `rag:list-docs` (not in original
  IPC channel enum — added to `shared/types.ts` as `RAG_EXPORT_CHUNKS`, `RAG_RUN_EVAL`,
  `RAG_LIST_DOCS`).
- **Test isolation**: `RagEvalService.test.ts` and `RagRetrievalOptions.test.ts` share the same
  in-memory DB pattern as Phase 2–3 tests. The reranker pipeline initialises lazily and the
  ablation test tolerates it (hybrid+rerank mode degrades gracefully if the reranker times out
  in a short-lived test process).

### 10.5 Phase 4 hotfix — eval metric ordering (2026-06-13)

**Root cause discovered:** `runEval` was deriving the ranked rowid list from `result.hits`, which
`retrieve()` step 5 sorts **alphabetically** by docName for presentation. Rank-sensitive metrics
(MRR, Precision@K, Recall@K, Hit@K) were therefore wrong whenever presentation order ≠ relevance
order — e.g. a relevant chunk named "aaa.pdf" that ranked 3rd by relevance would appear at rank 1
in `result.hits` → MRR = 1.0 instead of 1/3.

**Fix (commit `3.0.0-beta-12`):**

1. `captureTrace: true` passed to every `retrieve()` call in `runEval`.
2. Ranked rowid list derived from `trace.allocation` entries with `decision === 'admitted'`,
   **in the order they appear** — which is `orderedCandidates` priority order (rerank score
   when reranking, RRF score otherwise). Stitched neighbours are excluded.
3. Candidate Recall now computed from the correct pre-allocation stage in the trace:
   - lexical-only → `trace.lexical` (BM25 rank order)
   - vector-only → `trace.vector` (KNN distance order, non-dropped only)
   - hybrid / hybrid+rerank → `trace.fused` (RRF-desc order)

**New tests added** (3 cases):
- Relevant chunk alphabetically first but priority-rank 3 → MRR = 1/3 (not 1.0).
- 7 chunks with relevant at rank 7 (beyond FINAL_K=6): `CandRec=1.0`, `Recall@K=0.0`.
- Stub `scoreFn` promoting relevant from RRF-rank 5 to rerank-rank 1: MRR 0.2 → 1.0.

**Note on `scoreFn` contract:** `RerankerService.rerank()`'s injectable path returns the
`scoreFn` result verbatim (no sort). The production path sorts descending. Stub scoreFns must
therefore return results pre-sorted descending — this is consistent with all existing Phase 3
test stubs.
