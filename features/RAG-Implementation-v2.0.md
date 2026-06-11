# RAG Implementation v2.0 — How It Works, End to End

**Project:** Desktop Intelligence
**Status:** Design finalised, implementation pending (see `specs/RAG-v2-Implementation-Plan.md`)
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
                        │  ≤ 8k tokens?                                   │
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
│   overlap  60 tokens (~15%)  │   blank line ▸ newline ▸ sentence end ▸ hard cut
│   track nearest heading      │   "§3 Optimization" travels with its chunks
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
                  │  (Phase 3, optional, default off)   │
                  │  CROSS-ENCODER RERANK — tiny ONNX   │
                  │  model scores (query, chunk) pairs  │
                  └──────────────────┬──────────────────┘
                                     ▼  final 6 winners
                  ┌─────────────────────────────────────┐
                  │  NEIGHBOUR STITCH + ASSEMBLY        │
                  │  pull chunk_index ±1 if budget OK   │
                  │  group by doc, restore reading order│
                  │  cap at ~6,000 tokens (tokenUtils)  │
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
│            The user attached files… passages below… cite the file name…
│            If the passages do not contain the answer, say so.
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
- No-hit case: the envelope is replaced by a single line —
  `Retrieval found no passages relevant to this question in the attached files
  (lecture-notes.pdf).` The model can then say "the document doesn't cover this"
  instead of improvising.

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
                       │                    (FTS5 BM25,   (vec0, 384-d
                       │                    external-     float vectors)
                       │                    content,
                       │                    trigger-synced)
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
| `FINAL_K` | 6 (8 w/ rerank) | Passages handed to assembly |
| `CONTEXT_TOKEN_BUDGET` | 6,000 tok | Hard cap on the envelope |
| `RERANK_ENABLED` | off | Phase 3 cross-encoder toggle (Settings) |
| Embedding model | all-MiniLM-L6-v2, 384-d | Shared `EmbeddingService` primitive; swappable constant |

## 8. Failure behaviour (graceful, never blocking)

```
sqlite-vec won't load ──► FTS5-only retrieval, logged once      chat unaffected
embed() throws        ──► FTS5-only for that query              chat unaffected
FTS5 syntax error     ──► dense-only for that query             chat unaffected
both come back empty  ──► honest no-hit note                    chat unaffected
ingestion fails       ──► error logged, message still sends     chat unaffected
```

## 9. Build status

| Phase | Scope | Status |
|---|---|---|
| 0 | sqlite-vec packaged-build validation spike | ✅ Done (2026-06-11) — dev 0.07ms KNN, packaged 0.15ms, partition key confirmed |
| 1 | Schema v2, chunker, dual-index ingestion (v1 still serving) | ✅ Done (2026-06-11) — dual-write live; v1 path untouched; 43 new tests |
| 2 | Hybrid retrieval + RRF, handlers cutover | ⏳ |
| 3 | Local cross-encoder rerank (flag, default off) | ⏳ |
| 4 | Progress events, observability traces, optional contextual headers | ⏳ |
| 5 | Demolition: RAGService.ts, VectorStoreService.ts, hnswlib-node removed | ⏳ |

*(Update this table and any sections that drift as phases land.)*
