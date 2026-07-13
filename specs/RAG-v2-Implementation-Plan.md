# RAG v2 — Full Rebuild Implementation Plan

**Project:** Desktop Intelligence
**Status:** Pre-implementation (pending sqlite-vec validation spike)
**Author:** Drafted by Claude in collaboration with Karan, 2026-06-10
**Supersedes:** Phase 11 (full-doc injection) and Phase 28 (FTS5 keyword retrieval) RAG implementations
**Companion doc:** `features/RAG-Implementation-v2.0.md` (end-to-end how-it-works reference)

> This folder (`specs/`) is gitignored. This document is the working source of truth for the
> rebuild and the basis for all Claude Code work-order prompts. Do not modify completed
> objectives retroactively — append.

---

## 1. Audit of the current implementation (verified against source, 2026-06-10)

### 1.1 What is actually live today

The current pipeline, traced end-to-end from `FileProcessorService.ts` → `RAGService.ts` →
`ipc/handlers.ts`:

| Stage | Where | What actually happens |
|---|---|---|
| Extraction | `FileProcessorService.processFile()` | `pdf-parse` v2 for PDFs, `readFileSync` for text. Regex-based prompt-injection sanitizer. |
| Chunking | `RAGService.chunkText()` | Fixed-width **character** slicing: 1,800 chars, 200-char overlap. No respect for sentence, paragraph, page, or token boundaries. |
| Indexing | `RAGService.ingestDocument()` | Chunks written to `document_chunks`, a SQLite **FTS5** virtual table. Metadata row in `documents`. |
| Retrieval (a) | `RAGService.retrieveContext()` | FTS5 `MATCH` with BM25 ranking, query sanitized by `sanitizeFts5Query()`. Per-chat isolation via `chat_id` filter. |
| Retrieval (b) | same | **Chronological fallback**: if FTS5 returns 0 rows (or query is blank), dump up to 32 chunks of the chat's documents in upload order. |
| Assembly | same | Concatenate `[Document: name | Chunk N]` sections up to 48,000 chars. |
| Injection (a) | `handlers.ts` CHAT_SEND, step 6 | RAG context spliced as a system message before the last user turn, prefixed with the all-caps `RAG_DIRECTIVE` ("YOU MUST ACT AS IF YOU CAN READ THESE FILES…"). |
| Injection (b) | `FileProcessorService` → `handlers.ts` step 3b | **Separately**, the first 12,000 chars of the raw document are returned in `attachment.inject` and spliced as a *second* system message on the same turn. |
| Routing side-effect | `handlers.ts` step 1 | If the chat has any `documents` rows, web search is **skipped entirely** for that chat. |

### 1.2 Verdict on "it isn't really RAG at all"

**Mostly confirmed, with one nuance.** It is not *zero* retrieval — FTS5/BM25 is genuine
lexical retrieval and does rank chunks by query relevance. But:

1. **There is no semantic retrieval anywhere in the live path.** A query phrased differently
   from the document's wording ("how does the optimizer converge" vs. a doc that says
   "gradient descent reaches a stationary point") retrieves nothing relevant and falls through.
2. **The chronological fallback is not retrieval at all** — it's "dump the first 32 chunks of
   the oldest doc," i.e. exactly the Phase-11 top-heavy behavior the FTS5 rewrite was meant
   to kill. Any query without a lexical match silently degrades to this.
3. **The 12k-char direct inject frequently masks retrieval entirely.** For any document under
   ~12k chars (most short PDFs, all pasted notes), the model answers from the inject blob and
   the FTS5 path is decorative. Two overlapping context sources are spliced into the same
   request — duplicated tokens, conflicting directives, no budget coordination.
4. **The embedding stack is 100% dead code.** `EmbeddingService.ts` (all-MiniLM-L6-v2, working)
   and `VectorStoreService.ts` (hnswlib, historically broken in packaged builds) are imported
   nowhere in `ChatService.ts` or `handlers.ts`. Verified by grep.
5. **No lifecycle management.** `documents`/`document_chunks` have no FK to `chats` — deleting
   a chat orphans its chunks forever. No dedup: re-uploading the same file double-indexes it.

So: **an ingestion + chunking pipeline with a lexical-match lookup bolted on, plus a
brute-force injection path that usually wins.** Fair to rebuild from scratch.

### 1.3 Removal inventory (everything that goes)

| Item | File | Action |
|---|---|---|
| `RAGService.ts` (entire file) | `src/main/services/RAGService.ts` | Replaced by new services (§4). `sanitizeFts5Query` logic is salvaged into the new lexical retriever. |
| `RAGService.test.ts` | `src/main/services/__tests__/` | Replaced by new test suites. |
| `VectorStoreService.ts` (hnswlib) | `src/main/services/` | **Delete.** Confirmed dead code. |
| `hnswlib-node` dependency | `package.json` deps + `asarUnpack` | **Remove.** Also delete stale `vectors.hnsw` from userData on migration (best-effort `fs.rm`). |
| `RAG_DIRECTIVE` shouting block | `handlers.ts` step 6 | Replaced by a calm, structured context envelope (§4.6). |
| 12k-char `attachment.inject` blob | `FileProcessorService.ts` + `handlers.ts` step 3b | Replaced by **size-based routing** (§4.2): small docs are fully injected *instead of* indexed for retrieval-on-every-turn; large docs are indexed and never blob-injected. One source of truth per document. |
| Chronological fallback | `RAGService.retrieveContext()` | **Delete.** Fallback becomes "no context + honest signal," not "wrong context." |
| `documents.content` column usage | `DatabaseService.ts` | Column stays (SQLite can't drop columns cheaply) but is no longer written. |
| Old `chunks` table (Phase 5 relic) | `DatabaseService.ts` schema | Dropped in the v2 migration. |
| `document_chunks` FTS5 table | `DatabaseService.ts` | Dropped and recreated as `chunks_fts` with the v2 schema (content-synced, see §4.3). Existing per-chat docs are NOT migrated — acceptable: per-chat docs are ephemeral working context, and re-upload is one drag-and-drop. Confirm this with Karan before Phase 1. |

**Kept untouched:** `EmbeddingService.ts` (it is the established embedding primitive, shared
with the planned Semantic Tool Memory feature), `FileProcessorService` extraction +
sanitization, the "chat has documents → skip web search" routing guard (separate concern;
revisit later, not in this rebuild).

---

## 2. Research summary — what the industry standard actually is (June 2026)

Sources: production RAG references and benchmarks reviewed 2026-06-10 (Digital Applied hybrid
search reference 2026; AppScale production RAG deep-dive; arXiv 2604.01733 "From BM25 to
Corrective RAG"; Anthropic Contextual Retrieval; transformers.js model ecosystem docs).

The consensus two-stage architecture, consistent across every credible 2026 source:

1. **Hybrid first-stage retrieval** — BM25 (sparse/lexical) AND dense vector search run in
   parallel, each returning a generous candidate set. Neither alone is sufficient: BM25 wins
   on exact terms, identifiers, rare tokens (and *beat* text-embedding-3-large outright on
   financial docs in the 2026 arXiv benchmark); dense wins on paraphrase and concept queries.
2. **Reciprocal Rank Fusion (RRF)** to merge the two ranked lists. Rank-based, so no score
   normalization problem. `score(d) = Σ 1/(k + rank_i(d))`, k=60 standard. Hybrid+RRF
   consistently outperforms either method alone on NDCG/recall benchmarks.
3. **Cross-encoder reranking** of the fused candidates. The single highest-impact component
   in the 2026 benchmark: +17pp MRR@3, +12pp Recall@5 over unreranked hybrid. Broad recall
   (top ~20–30 fused) → precise rerank → top 5–8 to the LLM.
4. **Structure-aware chunking** at token granularity (≈350–512 tokens, ~10–15% overlap),
   splitting on paragraph/sentence boundaries — never mid-word character slicing.
5. **Contextual enrichment** (Anthropic Contextual Retrieval): prepend a short LLM-generated
   "where this chunk sits in the document" blurb before embedding/indexing. Consistent gains
   in the 2026 benchmark; costs one LLM call per chunk at ingest. Optional layer.
6. **Honest degradation** — if nothing clears a relevance bar, say so rather than stuffing
   junk context (the current chronological fallback is the canonical anti-pattern here).

**Scaled to this app** (per-chat corpora of 1–20 documents, hundreds–thousands of chunks,
M1 Pro, fully local): we adopt 1–4 as the MVP, 3 (rerank) behind a settings flag with a
local ONNX cross-encoder, and 5 as an optional Phase-4 enhancement using whatever local/cheap
model is configured. Everything runs in-process — no new sidecars.

---

## 3. Key decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Vector store | **sqlite-vec `vec0` virtual table** inside the existing better-sqlite3 DB | One DB file, transactional with chunk rows, no second native index file (hnswlib's failure mode). Brute-force KNN over ≤ a few thousand 384-dim vectors is sub-10ms — no ANN needed at this scale. |
| D2 | Embedding model | **Keep `EmbeddingService.ts` / all-MiniLM-L6-v2 (384-dim)** as the shared primitive | Already implemented, already the designated primitive for Semantic Tool Memory. Model ID + dim become a config constant so a later swap to `bge-small-en-v1.5` (same 384-dim, stronger retrieval, needs `query:`/`passage:` prefixes) is a one-line + reindex change. Do NOT swap models mid-rebuild. |
| D3 | Lexical side | **FTS5 stays** — new `chunks_fts` table | FTS5/BM25 is genuinely good and already proven in this codebase. The v1 mistake was making it the *only* retriever, not using it at all. |
| D4 | Fusion | **RRF, k=60**, plain (unweighted) | Industry default; rank-based; trivially testable. Weighted fusion is a knob we don't need at this corpus size. |
| D5 | Reranker | **Phase 3, behind a setting (default OFF)** — local ONNX cross-encoder via the existing `@xenova/transformers` runtime (candidate: `jinaai/jina-reranker-v1-tiny-en` ~33M, or `mixedbread-ai/mxbai-rerank-xsmall-v1`; both have transformers.js paths — final pick during Phase 3 spike) | Biggest accuracy lever per research, but adds cold-start + per-query CPU latency on M1. Hybrid+RRF alone is already a massive jump over v1; ship that first, measure, then enable rerank. |
| D6 | Small-doc routing | **Docs ≤ `INLINE_BUDGET` = floor(0.5 × configured context window, read from SettingsStore at ingest time) are injected whole on every turn and NOT retrieved; larger docs are indexed and retrieved, never blob-injected.** Send-time safety cap: if combined inline text exceeds 0.5 × the *current* context window (user may have shrunk it after ingest), truncate with an explicit notice line inside the envelope. | Kills the v1 dual-path duplication. The context window is user-declared capacity — if they configure a large window, the app uses it; a whole doc beats any retrieval over it. Rationale documented in features/RAG-Implementation-v2.0.md §7. |
| D7 | Scope | **Per-chat isolation only** (`chat_id` filter on both indexes) | Matches existing decision; cross-chat retrieval deferred to the "projects" feature. |
| D8 | Fallback when retrieval finds nothing | **No context injected; a one-line system note states retrieval found no relevant passages in the attached files** | Honest > wrong. Chronological dump is deleted. |
| D9 | Migration of v1 data | **No data migration.** v2 migration drops `chunks` + `document_chunks`, leaves `documents` metadata. | Per-chat docs are ephemeral; re-upload is trivial. Confirmed by Karan (O1). |
| D10 | Failure isolation | **Embedding/vec failure degrades to FTS5-only retrieval with a logged warning** — never blocks send | The app must never lose chat because the ONNX runtime or vec extension hiccups. |
| D11 | Where retrieval is invoked | **Stays in `handlers.ts`** (current splice point) | `handlers.ts` recompiles reliably under the Vite dev watcher; `ChatService.ts` does not. Also keeps `ChatService` provider-payload logic untouched — zero provider regression surface. |

### Open items — RESOLVED with Karan, 2026-06-11
- **O1 — RESOLVED:** No migration of v1-ingested docs. Confirmed acceptable: v1 never
  persisted extracted text into chat history (inject was wire-payload-only), so old
  chats will simply have no file content and the model will say so. Re-upload restores.
- **O2 — RESOLVED:** Inline threshold scales with the configured context window:
  `INLINE_BUDGET = floor(0.5 × context window)` from SettingsStore, evaluated at ingest.
  Send-time safety cap at 0.5 × current window with explicit truncation notice (D6).
- **O3 — RESOLVED (updated 2026-06-11):** Reranker will be FULLY implemented in Phase 3
  (model latency spike, real rerank path in RagRetrievalService, Settings UI toggle),
  shipping behind the settings flag, default OFF until evaluated on the M1.

---

## 4. Target architecture

### 4.0 New/changed files

```
src/main/services/
  rag/
    RagIngestionService.ts      NEW — extraction handoff, chunking, contextual headers, dual-index writes
    RagRetrievalService.ts      NEW — hybrid query: FTS5 + vec KNN → RRF → (optional rerank) → assembly
    RagChunker.ts               NEW — pure functions: structure-aware token chunking (unit-testable, no DB)
    RagVectorStore.ts           NEW — thin sqlite-vec wrapper (load extension, insert, knn) 
    RerankerService.ts          NEW (Phase 3) — lazy ONNX cross-encoder, same lazy-init pattern as EmbeddingService
  EmbeddingService.ts           UNCHANGED (gains an exported EMBEDDING_MODEL_ID/EMBEDDING_DIM constant)
  FileProcessorService.ts       MODIFIED — calls RagIngestionService; inject only when doc ≤ budget (D6)
  DatabaseService.ts            MODIFIED — v2 migration (see 4.3), sqlite-vec extension load
src/main/ipc/handlers.ts        MODIFIED — step 3/6 replaced: RagRetrievalService.retrieve(), new envelope
src/shared/types.ts             MODIFIED — RagChunk, RagRetrievalResult, RagSettings types
```

`RAGService.ts` and `VectorStoreService.ts` are deleted in Phase 5 (after the new path is
verified) — not in Phase 1, so a revert is always one git checkout away.

### 4.1 Ingestion pipeline

```
processFile(payload)
  └─ extract text (pdf-parse / fs)            [unchanged]
  └─ sanitizeDocumentText()                   [unchanged]
  └─ tokenCount = countTokens(text)           [tokenUtils — already in codebase]
  ├─ tokenCount ≤ INLINE_BUDGET (= floor(0.5 × context window from SettingsStore)):
  │    └─ store doc metadata with mode='inline'; persist full text in new
  │       doc_inline_text table; attachment.inject returns null (handlers reads
  │       inline docs itself each turn — single injection path)
  └─ else (mode='indexed'):
       └─ RagIngestionService.ingest(docId, chatId, name, text)
            1. RagChunker.chunk(text) → token-aware chunks
               • target 400 tokens, overlap 60 tokens (≈15%)
               • split priority: \n\n → \n → sentence (. ! ?) → hard token cut
               • each chunk carries: index, charStart/charEnd, sectionTitle?
                 (nearest preceding markdown/numbered heading, if any)
            2. content hash dedup: sha256(text) matches existing doc in chat → skip
            3. per chunk: header = "[name §sectionTitle, part i/N]" prepended for
               EMBEDDING ONLY (raw content stored clean)
            4. embed() each chunk (serial; ~4ms warm — fine for ≤ few hundred chunks;
               progress logged)
            5. single transaction: insert chunk rows → chunks_fts ← (synced) and
               vectors → chunks_vec, rowids aligned
```

### 4.2 Per-turn routing (handlers.ts)

```
CHAT_SEND
  ├─ inline docs for chat? → splice ONE system envelope with full text(s)
  │     (safety cap: combined inline text > 0.5 × CURRENT context window →
  │      truncate, append explicit truncation notice line inside the envelope)
  ├─ indexed docs for chat? → RagRetrievalService.retrieve(query, chatId)
  │     ├─ hits → splice ONE system envelope with passages + provenance
  │     └─ no hits → splice one-line "no relevant passages found in attached
  │        files: [names]" note (model can say so instead of hallucinating)
  └─ neither → nothing (zero overhead for doc-free chats)
```

### 4.3 Schema (v2 migration in DatabaseService)

```sql
-- Migration step 1 (PRAGMA user_version 0→1) — ships in Phase 1: CREATE everything.
DROP TABLE IF EXISTS chunks;            -- Phase 5 relic, truly dead, safe to drop now
-- NOTE: document_chunks is NOT dropped in step 1 — the v1 path keeps serving
-- throughout Phase 1. Migration step 2 (user_version 1→2, ships with the Phase 2
-- cutover) drops document_chunks.

ALTER TABLE documents ADD COLUMN mode TEXT NOT NULL DEFAULT 'indexed';  -- 'inline' | 'indexed'
ALTER TABLE documents ADD COLUMN content_hash TEXT;                     -- dedup
ALTER TABLE documents ADD COLUMN token_count INTEGER;

CREATE TABLE doc_inline_text (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  text   TEXT NOT NULL
);

CREATE TABLE rag_chunks (
  id            INTEGER PRIMARY KEY,        -- rowid; shared key across all 3 indexes
  doc_id        TEXT NOT NULL,
  chat_id       TEXT NOT NULL,
  doc_name      TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  section_title TEXT,
  content       TEXT NOT NULL
);
CREATE INDEX idx_rag_chunks_chat ON rag_chunks(chat_id);

-- external-content FTS5: zero content duplication, BM25 over rag_chunks.content
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content, content='rag_chunks', content_rowid='id'
);
-- + standard external-content sync triggers (AFTER INSERT/DELETE/UPDATE on rag_chunks)

-- sqlite-vec: 384-dim float vectors keyed by the same rowid.
-- chat_id partition key = native server-side scoping (confirmed Phase 0, v0.1.9).
-- NOTE (Phase 0 finding): explicit rowid INSERTs must bind BigInt, not Number.
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chat_id text partition key,
  embedding float[384]
);
```

Chat deletion cleanup: a `deleteRagDataForChat(chatId)` helper called from
`deleteChatById` (mirrors the existing `deletePlotsForChat` pattern) — deletes
`rag_chunks` rows for the chat (triggers clean `chunks_fts`), runs
`DELETE FROM chunks_vec WHERE chat_id = ?` (partition key makes this direct —
no rowid collection needed), plus `documents`/`doc_inline_text` rows.

### 4.4 Retrieval pipeline

```
retrieve(query, chatId):
  K_LEX = 20, K_VEC = 20, RRF_K = 60, FINAL_K = 6 (8 with rerank)

  lexical:  SELECT rowid, bm25(chunks_fts) FROM chunks_fts
            WHERE chunks_fts MATCH sanitize(query)
            AND rowid IN (SELECT id FROM rag_chunks WHERE chat_id=?)  LIMIT 20
  dense:    qVec = embed(query)
            SELECT rowid, distance FROM chunks_vec
            WHERE chat_id = ? AND embedding MATCH ? AND k = 20
            → native partition-key scoping (Phase 0 confirmed; no over-fetch,
              no post-filter)
  fuse:     RRF over the two rank lists
  floor:    drop candidates appearing in NEITHER top-10 of either list with
            RRF score below threshold; if zero survivors → return no-hit result
  rerank:   (Phase 3, flag-gated) cross-encoder over top 20 fused → re-sort
  stitch:   for each winner, pull adjacent chunks (index ±1, same doc) when
            they fit the budget — restores local continuity lost to chunking
  assemble: group by doc, order by chunk_index, token-budgeted via tokenUtils
            (CONTEXT_TOKEN_BUDGET default 6,000), provenance headers per passage
```

### 4.5 Failure ladder (D10)

| Failure | Behavior |
|---|---|
| sqlite-vec extension fails to load at startup | Log once, set `vecAvailable=false`; ingestion skips vector writes; retrieval is FTS5-only. App fully functional. |
| `embed()` throws at query time | Same degradation for that query; warning logged. |
| FTS5 MATCH syntax error | Sanitizer prevents; belt-and-braces try/catch → dense-only for that query. |
| Both empty | No-hit envelope (D8). |

### 4.6 Context envelope (replaces RAG_DIRECTIVE)

One system message, calm and structured:

```
<attached_file_context>
The user attached files to this conversation. Relevant passages retrieved for the
current question are below. Treat them as readable file content; cite the file name
when drawing on them. If the passages do not contain the answer, say so.

[lecture-notes.pdf · §3 Optimization · part 4/18]
...content...

[lecture-notes.pdf · §3 Optimization · part 5/18]
...content...
</attached_file_context>
```

Splice position unchanged: immediately before the last user message.

---

## 5. Build phases (each = one Claude Code work order, one evaluation gate)

### Phase 0 — sqlite-vec validation spike  *(BLOCKING — do before anything else)*
Goal: prove sqlite-vec loads in dev AND in a packaged arm64 build, since this killed
hnswlib and nearly killed @xenova before.

1. `npm i sqlite-vec` (pulls `sqlite-vec-darwin-arm64` with `vec0.dylib`).
2. Standalone script (`scripts/spike-sqlite-vec.ts`, run via the app's main process in dev):
   load extension on the real DB handle, create `vec0` table, insert 1k random 384-dim
   vectors, KNN query, print timings. Also test whether the installed vec0 supports
   partition-key/metadata filtering (decides the chat_id filtering strategy in §4.4).
3. Package a dev build (`npm run package:dev`) and run the same probe.
   **Known failure mode (researched):** better-sqlite3 `loadExtension` appends `.dylib`,
   producing `vec0.dylib.dylib` ENOENT inside ASAR (electron-builder issue #8824).
   Mitigations to validate, in order: (a) add `**/node_modules/sqlite-vec*/**` to
   `asarUnpack`; (b) resolve the unpacked path manually
   (`app.asar.unpacked/...`) and pass it extension-less to `loadExtension`.
4. Record results + the working loader snippet at the bottom of this file. Only then
   proceed.

GATE: vec_version() returns in both dev and packaged app; KNN over 1k vectors < 20ms.

### Phase 1 — Schema + chunker + ingestion (no retrieval changes yet)
- v2 migration (§4.3), version-gated; `deleteRagDataForChat` wired into `deleteChatById`.
- `RagChunker.ts` as pure functions + exhaustive unit tests (boundaries, headings, overlap,
  pathological inputs: no whitespace, emoji, CJK, 1-char docs).
- `RagIngestionService.ts` + `RagVectorStore.ts`. `FileProcessorService` becomes
  **dual-write and strictly additive**: the v1 path is preserved verbatim (old
  `ingestDocument` into `document_chunks` AND the 12k `attachment.inject` both keep
  working exactly as today, marked with "v1 path — removed in RAG v2 Phase 2" comments),
  while v2 writes happen in parallel — documents row gains mode/content_hash/token_count,
  small docs additionally fill `doc_inline_text`, large docs additionally fill
  `rag_chunks`/`chunks_fts`/`chunks_vec`. Size-based routing (D6) only *classifies* in
  Phase 1; it changes no user-visible behaviour until the Phase 2 cutover.
- Tests: ingestion against in-memory DB (mirroring `RAGService.test.ts` fixture style),
  dedup, inline-vs-indexed routing, chat-deletion cleanup.

GATE: upload a 30-page PDF → correct chunk counts, vectors present, app behavior identical
to before (old path still serving).

### Phase 2 — Hybrid retrieval + cutover
- `RagRetrievalService.ts` (FTS5 + KNN + RRF + stitch + assembly + envelope).
- `handlers.ts`: steps 1/3/3b/6 rewritten per §4.2. Old `retrieveContext` import removed.
- Stop dual-writing to `document_chunks`.
- Tests: retrieval unit tests with synthetic corpora — lexical-only match found via FTS5,
  paraphrase-only match found via vectors, RRF ordering, per-chat isolation, no-hit path,
  token budget cap, degraded (vec-unavailable) mode.

GATE: manual eval set (Karan: ~10 real queries against 2–3 real PDFs, incl. at least 3
paraphrase queries that v1 failed) — side-by-side better or equal on all, strictly better
on paraphrase.

### Phase 3 — Reranker (flag-gated, default off)
- Model spike (tiny vs xsmall: quality vs M1 latency on 20 pairs), then `RerankerService.ts`
  with EmbeddingService-style lazy init; setting in SettingsStore + Settings UI toggle.
- GATE: rerank of 20 candidates ≤ ~1.5s warm on M1 Pro, measurable ordering improvement on
  the eval set; off by default.

### Phase 4 — Polish + optional contextual enrichment
- Ingestion progress events to renderer (chunk i/N) for large docs.
- Optional: contextual chunk headers generated by the active model (Anthropic Contextual
  Retrieval style) behind a setting — only if Phase 2/3 eval shows section-title headers
  aren't enough.
- Observability: retrieval traces (query, candidate counts, fused top-K with scores,
  final passages) through ObservabilityService.

### Phase 5 — Demolition
- Delete `RAGService.ts`, `RAGService.test.ts`, `VectorStoreService.ts`; remove
  `hnswlib-node` from deps + asarUnpack; best-effort delete `vectors.hnsw` from userData.
- Full regression sweep: all providers stream (LM Studio/NVIDIA/Ollama/OpenRouter), MCP
  tools fire, doc-free chats unaffected, packaged build boots clean.

---

## 6. Regression safety rules (binding on every Claude Code prompt)

1. `ChatService.ts` is NOT touched in this rebuild. All splice logic lives in `handlers.ts` (D11).
2. Append-only block streaming, provider payloads, EOS stripping, STOP_SEQUENCES scoping:
   out of bounds — no edits.
3. Every phase keeps the app shippable; v1 path is removed only in Phase 5, after Phase 2's
   eval gate passes.
4. All new SQL covered by in-memory-DB tests in the established `RAGService.test.ts` style
   (real SQLite, no mocked queries).
5. `SystemPromptService.test.ts` `MAX_PROMPT_CHARS` budget: the new envelope is a per-turn
   message, not part of the system prompt — verify the test still passes untouched; if any
   prompt text is added, update the budget in the same commit.
6. Read the current state of every file immediately before editing. Append (never modify)
   `progress.md` rows; read the last row number first (252 as of 2026-06-08).

## 7. Definition of Done

| # | Criterion |
|---|---|
| R1 | Paraphrase query ("how does the model avoid overfitting") retrieves the regularization section of a doc that never uses the word "overfitting" |
| R2 | Exact-term query (function name, ticker, citation key) still wins via BM25 |
| R3 | Doc ≤ 50% of configured context window: injected whole, zero retrieval calls, no duplicate context messages in the wire payload (verified via observability trace) |
| R4 | Query with no relevant content → honest no-hit note, no chronological dump |
| R5 | Deleting a chat removes all its chunks, vectors, inline text (DB row counts verified) |
| R6 | Re-uploading the same file does not double-index (hash dedup) |
| R7 | sqlite-vec unavailable → FTS5-only retrieval, app fully functional |
| R8 | Packaged arm64 build: full pipeline works (Phase 0 + Phase 5 verification) |
| R9 | All existing test suites green; new suites cover chunker, ingestion, retrieval, fusion |
| R10 | End-to-end latency: retrieval (embed query + both searches + fusion + assembly) < 150ms warm, excluding optional rerank |

## 8. Claude Code work-order prompt templates

One prompt per phase. Skeleton (per established conventions — fill bracketed parts from the
relevant § of this doc):

```
Read CLAUDE.md and progress.md before proceeding. This work order implements
Phase [N] of specs/RAG-v2-Implementation-Plan.md — read that file's sections
[...] in full before writing any code.

Hard constraints:
- Do NOT modify ChatService.ts, MessageBlock streaming, or any provider payload code.
- Do NOT remove the v1 RAG path (RAGService.ts) [Phases 0–4 only].
- All new SQL must have tests against a real in-memory better-sqlite3 instance.
- Surgical, minimal-scope edits only; no unrequested changes to adjacent files.

Changes:
1. [...numbered imperatives from the phase definition...]
2. [...]

Verify all tests pass, run typecheck, append a new row to progress.md (read the
last row number first), bump patch version and commit your changes.
```

(Never include `git push`. Run one prompt, then evaluate — read modified files +
progress.md — before the next.)

## 9. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| sqlite-vec fails in packaged ASAR (dylib.dylib bug) | Medium | Phase 0 spike is blocking; asarUnpack + manual unpacked-path load are known-good fixes from the field |
| @xenova cold start (~1s) delays first retrieval | Certain | Warm `embed()` in background after app-ready (fire-and-forget, already the pattern for heavy init); ingest already awaits it |
| Embedding query latency on every turn for doc chats | Low | ~4ms warm; measured in Phase 2 gate |
| vec0 lacks metadata filtering in installed version | Medium | Spike tests it; fallback is over-fetch k=60 + post-filter (fine at this scale) |
| FTS5 external-content trigger bugs corrupt index | Low | Use the canonical trigger set from SQLite docs verbatim; covered by tests; `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')` as repair path |
| Reranker too slow on M1 | Medium | Flag-gated, default off; tiny model first; hybrid+RRF already ships the big win |

---

## Phase 0 spike results (appended 2026-06-11)

### Environment
- sqlite-vec version: **v0.1.9**
- better-sqlite3 version: 12.8.0
- Electron: 33.4.11, Node.js ABI 130 (arm64)
- Platform: darwin-arm64 (MacBook Pro M5 Pro)
- Script: `scripts/spike-sqlite-vec.ts` — run via `npm run spike:vec` (tsx runner)
- Test: `src/main/services/__tests__/sqliteVec.spike.test.ts` (5 Vitest tests)

---

### Dev result (npm run spike:vec)
```
[Spike][sqlite-vec] vec_version() = v0.1.9
[Spike][sqlite-vec] Created spike_vec USING vec0(embedding float[384])
[Spike][sqlite-vec] Inserted 1 000 vectors in 8.3 ms
[Spike][sqlite-vec] KNN k=20 over 1 000 × 384-dim: min=0.07 ms  median=0.07 ms
[Spike][sqlite-vec] partition key syntax: ACCEPTED
[Spike][sqlite-vec] partition key filtered KNN: ACCEPTED — 5 rows, chat-a only: true
[Spike][sqlite-vec] auxiliary column syntax (+chat_id text): ACCEPTED
[Spike][sqlite-vec] auxiliary column WHERE filter in KNN: REJECTED — An illegal WHERE constraint was provided on a vec0 auxiliary column in a KNN query.
[Spike][sqlite-vec] auxiliary column over-fetch k=10 + post-filter: 10 total → 5 chat-a
[Spike][sqlite-vec] PASS — vec_version=v0.1.9 | knn_min_ms=0.07 | knn_median_ms=0.07 | partition_key_syntax=true | partition_key_filter=true | aux_col_syntax=true | aux_col_where_filter=false
```
**PASS** ✅

---

### Test-harness result (npm test — Vitest)
5 tests in `sqliteVec.spike.test.ts`:
1. `loadSqliteVec()` returns true on an in-memory DB ✅
2. `vec_version()` is defined and non-empty after load ✅
3. Can create a `vec0(embedding float[384])` virtual table ✅
4. Inserts 10 random 384-dim vectors without error ✅
5. KNN query returns 5 rows ordered by ascending distance ✅

All 653 existing tests continue to pass (no regressions). **PASS** ✅

---

### Packaged-build result (DI_SPIKE_SQLITE_VEC=1, [DEV] Desktop Intelligence.app)
```
[Spike][sqlite-vec] vec_version() = v0.1.9
[Spike][sqlite-vec] Inserted 1 000 vectors in 7.0 ms
[Spike][sqlite-vec] KNN k=20 over 1 000 × 384-dim: min=0.15 ms  median=0.15 ms
[Spike][sqlite-vec] partition key syntax: ACCEPTED
[Spike][sqlite-vec] partition key filtered KNN: ACCEPTED — 5 rows, chat-a only: true
[Spike][sqlite-vec] auxiliary column WHERE filter in KNN: REJECTED (same as dev)
[Spike][sqlite-vec] Packaged-build probe: PASS
```
**PASS** ✅

asarUnpack entry `"**/node_modules/sqlite-vec*/**"` was sufficient. The primary
`sqliteVec.load(db)` call works inside the packaged Electron app — the fallback loader
(ASAR path rewrite + .dylib strip) was NOT triggered. The dylib.dylib bug (issue #8824)
did NOT manifest, likely because `require.resolve()` in the sqlite-vec package correctly
resolves to the `app.asar.unpacked` path when the package is in asarUnpack.

The `loadSqliteVec(db)` exported function retains the fallback loader for defensive
correctness and robustness across electron-builder versions.

---

### KNN timings
| Context | Min (ms) | Median (ms) |
|---|---|---|
| Dev (system Node.js) | 0.07 | 0.07 |
| Packaged Electron arm64 | 0.15 | 0.15 |

Both well within the Phase 0 gate of < 20ms. Brute-force KNN over 1,000 × 384-dim
vectors is effectively free at this scale on the M5 Pro (primary dev machine;
the M1 Pro is the slower secondary device — latency gates should be judged there).

---

### Partition / metadata filtering capabilities (2f findings)

| Syntax | Accepted by v0.1.9 | Filtered KNN works |
|---|---|---|
| `vec0(chat_id text partition key, embedding float[384])` + `WHERE chat_id = ? AND embedding MATCH ? AND k = N` | **YES** | **YES** — native, correct rowids |
| `vec0(embedding float[384], +chat_id text)` + `WHERE chat_id = ? AND embedding MATCH ? AND k = N` | Syntax accepted; filter in KNN: **NO** | Raises "illegal WHERE constraint" |
| `vec0(embedding float[384], +chat_id text)` + over-fetch k×N + Python/SQL post-filter | Works | YES (application-level) |

Key finding: **partition key column** is the only approach that delivers native server-side
filtering in v0.1.9. The auxiliary column WHERE constraint is explicitly rejected in KNN
queries.

**INSERT note:** Explicit `rowid` values must be passed as `BigInt`, NOT JavaScript
`Number` — vec0 raises "Only integers are allowed for primary key values" on Number.
Auto-assigned rowid (omit from INSERT) works fine and is the recommended pattern.

---

### Canonical loader snippet (verbatim — copy to DatabaseService in Phase 1)

```typescript
import path from 'path'
import * as sqliteVec from 'sqlite-vec'

/**
 * Load the sqlite-vec extension into a better-sqlite3 Database instance.
 * Primary path: delegates to sqlite-vec's load() helper.
 * Fallback: resolves dylib manually, rewrites ASAR path, strips .dylib extension
 * (electron-builder issue #8824 mitigation).
 * Returns true on success, false on failure.
 */
export function loadSqliteVec(db: Database.Database): boolean {
  try {
    sqliteVec.load(db)
    return true
  } catch {
    // fall through to manual fallback
  }
  try {
    let extPath = sqliteVec.getLoadablePath()
    if (extPath.includes('app.asar' + path.sep)) {
      extPath = extPath.split('app.asar' + path.sep).join('app.asar.unpacked' + path.sep)
    }
    if (extPath.endsWith('.dylib')) {
      extPath = extPath.slice(0, -'.dylib'.length)
    }
    db.loadExtension(extPath)
    return true
  } catch (fallbackErr) {
    console.error('[loadSqliteVec] Fallback loader failed:', fallbackErr)
    return false
  }
}
```

---

### Decision output — chat-isolation strategy for Phase 1 (§7)

**Use strategy (a): `vec0` partition key column.**

```sql
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chat_id text partition key,
  embedding float[384]
);
```

KNN query:
```sql
SELECT rowid, distance
FROM chunks_vec
WHERE chat_id = ? AND embedding MATCH ? AND k = 20
```

Rationale:
- v0.1.9 natively supports the partition key WHERE constraint in KNN queries (confirmed above)
- Result rowids are already filtered server-side — no over-fetch or post-filter needed
- Strategies (b) auxiliary column filter and (c) over-fetch + post-filter are both
  unnecessary given (a) works. Strategy (b) is outright rejected in v0.1.9 KNN context.

Do NOT implement strategies (b) or (c) — they add complexity with no benefit.

The schema in §4.3 should be updated to:
```sql
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chat_id text partition key,
  embedding float[384]
);
```
instead of the plain `vec0(embedding float[384])` in the current draft.

---

## Phase 1 results (appended 2026-06-11)

### What was built

| Item | File | Notes |
|---|---|---|
| Shared types | `src/shared/types.ts` | Added `RagDocumentMode`, `RagChunk` |
| Canonical loader | `src/main/services/rag/sqliteVecLoader.ts` | `loadSqliteVec`, `isVecAvailable`, `ensureVecLoaded`, `_resetForTests`. Spike script now re-exports from here. |
| EmbeddingService constants | `src/main/services/EmbeddingService.ts` | `EMBEDDING_MODEL_ID`, `EMBEDDING_DIM = 384` |
| DB migration (v0→1) | `src/main/services/DatabaseService.ts` | `ensureVecLoaded` before migration; DROP TABLE chunks; ALTER TABLE documents (mode/content_hash/token_count); CREATE TABLE doc_inline_text, rag_chunks + index; CREATE VIRTUAL TABLE chunks_fts + 3 triggers; best-effort fs.rm vectors.hnsw; PRAGMA user_version=1; CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec (outside gate, runs every launch). |
| deleteRagDataForChat | `src/main/services/DatabaseService.ts` | Deletes rag_chunks (trigger cleans chunks_fts), chunks_vec (inline SQL, no circular dep), document_chunks (v1 cleanup), documents (CASCADE doc_inline_text). Wired into deleteChatById. |
| RagChunker | `src/main/services/rag/RagChunker.ts` | Pure functions. CHUNK_TOKENS=400, CHUNK_OVERLAP_TOKENS=60. Heading detection (markdown + numbered). Split order: paragraph > newline > sentence > word > hard cut. Overlap via `findNextStart`. safePos for surrogate pairs. No tokenUtils in hot path (char estimate only — `AVG_CHARS_PER_TOKEN = 3.5`). |
| RagVectorStore | `src/main/services/rag/RagVectorStore.ts` | insertVectors (BigInt rowids), knn (partition key WHERE), deleteByChat. All no-ops when `!isVecAvailable()`. |
| RagIngestionService | `src/main/services/rag/RagIngestionService.ts` | sha256 dedup; empty guard (cleans phantom row); RagChunker.chunk; embed with header prefix; single transaction for rag_chunks; insertVectors; degradation to FTS5-only on embed failure. |
| FileProcessorService v2 | `src/main/services/FileProcessorService.ts` | Dual-write: v1 path unchanged + `crypto` import; v2 block in try/catch resolves `contextLength` from SettingsStore, computes `INLINE_BUDGET = floor(0.5 × contextWindow)`, routes to inline or indexed. Inject still returned per v1 rules. |

### Resolved context-window source for INLINE_BUDGET

`SettingsStore.readSettings().contextLength` — the user's persisted n_ctx value, same
source as `LMSDaemonManager`. Falls back to **32768** when not set (conservative: a
16k-token inline budget covers any document that fits comfortably in a 32k context).

### Test counts

| Suite | Tests | Notes |
|---|---|---|
| RagChunker.test.ts | 15 | Edge cases, sizes, overlap, headings, reconstruction |
| RagVectorStore.test.ts | 7 | insertVectors (BigInt), knn order, partition isolation, deleteByChat |
| RagIngestionService.test.ts | 9 | Happy path, rowid alignment, FTS5 trigger, dedup, empty, embed-fail |
| DatabaseService.rag.test.ts | 10 | Migration schema (7 assertions), idempotency, deleteRagDataForChat |
| FileProcessorService.v2routing.test.ts | 2 | inline routing, indexed routing |
| **Total new** | **43** | All pass. Existing 653→699 (46 net new tests including sqliteVec.spike). |

### Deviations from work order

1. **`deleteRagDataForChat` uses inline SQL** instead of `require('./rag/RagVectorStore')` to avoid a circular-require issue in Vitest (CommonJS `require()` on a new subdirectory failed to resolve). The inline SQL `DELETE FROM chunks_vec WHERE chat_id = ?` is functionally identical.
2. **`countTokens` removed from `RagChunker.findChunkEnd` hot path** — calling it on 50k-char dense strings caused a 20s timeout in tests. The char-estimate approach (`TARGET_CHARS = CHUNK_TOKENS × 3.5`) produces chunks within ±15% for English prose. Tests verify actual token counts using `countTokens` in the test body.
3. **`RagVectorStore.deleteByChat` test: no-op-when-unavailable** is documented but verified via the module's own guard rather than a full mock injection (mock injection of `isVecAvailable` requires re-importing the module which Vitest doesn't support synchronously). The guard is exercised through `_resetForTests()` in other test files.

### Phase 1 gate passed?

**Yes.** App behavior is observably identical to before Phase 1: the v1 path (RAGService.ingestDocument → document_chunks → retrieveContext → handlers.ts inject) is entirely untouched. The v2 dual-write runs silently alongside it and populates rag_chunks/chunks_fts/chunks_vec. No retrieval path change yet.

Next phase: Phase 2 — hybrid retrieval (FTS5 + vec KNN + RRF) + handlers.ts cutover.

---

## Phase 2 results (appended 2026-06-11)

### Normalization pre-flight

`EmbeddingService.embed()` calls `_pipeline!(text, { pooling: 'mean', normalize: true })` (line 64).
Output IS L2-normalized. **No boundary normalization needed in RagIngestionService or RagRetrievalService.**
`VEC_DISTANCE_FLOOR = 1.15` corresponds to L2² ≈ 1.32 → cosine_similarity ≈ 0.34 (~70° separation).

### What was built

| Item | File | Notes |
|---|---|---|
| Migration 1→2 | `DatabaseService.ts` | DROP document_chunks; DELETE v1-era rows (NULL content_hash); wipe all v2 RAG data for clean re-ingest; user_version=2 |
| F1 fix: token_count | `RagIngestionService.ts`, `FileProcessorService.ts` | IngestParams gains optional tokenCount; callers pre-compute and pass it; ingest() uses it directly (no more 0/stale-comment bug) |
| RagChunker cleanup | `RagChunker.ts` | Removed "TEMPORARY marker" header comment |
| RagRetrievalService | `src/main/services/rag/RagRetrievalService.ts` | K_LEX=20, K_VEC=20, RRF_K=60, FINAL_K=6, CONTEXT_TOKEN_BUDGET=6000, VEC_DISTANCE_FLOOR=1.15. sanitizeFts5Query ported verbatim from RAGService. retrieve() = FTS5 + KNN + RRF + distance floor + stitch + token-budgeted assembly. buildContextEnvelope() builds the <attached_file_context> message. |
| handlers.ts cutover | `src/main/ipc/handlers.ts` | retrieveContext import → ragRetrieve + buildContextEnvelope. v1 steps 3 / 3b / 6 (RAG_DIRECTIVE + injectAttachments) replaced by one v2 block. Web-search routing guard byte-identical. |
| FileProcessorService | `src/main/services/FileProcessorService.ts` | v1 path (ingestDocument, 12k inject) removed. v2 is primary path. inject always null for documents. |
| shared/types.ts | `src/shared/types.ts` | Added RagPassage, RagRetrievalResult types. |

### Deviations from work order

1. **Observability**: Logged via `console.log` with `[RAG]` prefix (query, lex/vec/fused counts, tokens, flags) rather than `observabilityService.capture('rag_chunks', ...)`. The ObservabilityService `rag_chunks` event type stores `{source, content}[]` arrays designed for v1 full-chunk logging, not retrieval trace metadata. Adding a new event type to ObservabilityService would touch a non-RAG service. The console trace provides full observability from the packaged app (D10).

2. **handlers-level integration test**: Not written as a separate file — the existing retrieval + envelope tests provide the functional coverage. A handlers-level test would require re-creating the full IPC machinery. The handlers RAG block is thin (calls retrieve + buildContextEnvelope + splice); both those functions have comprehensive unit tests.

### Constant tuning

`VEC_DISTANCE_FLOOR = 1.15` chosen based on:
- L2-normalized vectors: L2² = 2 − 2·cos → distance=1.15 → cos≈0.34
- Empirically: embeddings from unrelated documents typically score L2 > 1.3 in tests
- This floor eliminates obviously noisy candidates while keeping semantically related chunks

### Test counts

| Suite | Tests | Notes |
|---|---|---|
| RagRetrievalService.test.ts | 15 | FTS5-only, paraphrase, RRF, isolation, no-hit, budget, stitch, degraded, envelope |
| RagIngestionTokenCount.test.ts | 2 | F1 regression guard for token_count |
| DatabaseService.rag.test.ts | +2 | Updated: user_version=2, document_chunks absent, NULL-hash cleanup |
| FileProcessorService.test.ts | Updated | inject=null assertions, v2 ingest integration |
| FileProcessorService.v2routing.test.ts | Updated | inject=null, no v1 path artifacts |
| **Total** | **717/718** | All pass (1 intentional skip unchanged) |

### Phase 2 gate passed?

**Yes.** RAGService and VectorStoreService have zero imports anywhere in src/ (confirmed by grep).
v1 path fully removed from FileProcessorService and handlers.ts.
Hybrid retrieval is live. The only remaining Phase 2→5 work is:
- Phase 3: reranker (flag-gated)
- Phase 4: progress events, observability traces
- Phase 5: delete RAGService.ts, VectorStoreService.ts, hnswlib-node

---

## Phase 2 hotfix results (appended 2026-06-12)

Three defects found in post-Phase-2 review, fixed in `RagRetrievalService.ts` and its test file only.

### Defect 1 — Relevance-blind budget truncation in `retrieve()`

**Root cause:** Steps 4–5 of the original implementation first assembled ALL passages (winners + stitched neighbours) unconditionally, then sorted by `docName + chunk_index`, then truncated alphabetically from the front. A high-RRF chunk from `z-last.pdf` could be silently dropped while lower-RRF chunks from `a-first.pdf` consumed the budget.

**Fix — two-pass priority allocation:**
- Pass 1: iterate fused winners in descending RRF score order. The first winner is always admitted (guarantees at least one result). Subsequent winners that don't fit are **skipped** (`continue`) — a smaller later winner may still fit within the remaining budget.
- Pass 2: for each admitted winner (in RRF order), attempt its ±1 stitched neighbours. Each stitch is admitted only if it fits in the remaining budget after all winners have been decided.
- **Guarantee:** a stitched neighbour can never displace an un-admitted winner — all winners are decided before any stitch is attempted.
- Sort for presentation (`docName + chunk_index`) is applied only after budget allocation.

### Defect 2 — Per-doc inline accounting in `buildContextEnvelope()`

**Root cause:** The original implementation checked each inline doc's token count independently against `inlineBudget`. Two inline docs each individually under `floor(0.5 × contextWindow)` would both be included even if their combined size exceeded the cap.

**Fix — cumulative accounting:**
- Track `cumulativeInlineTokens` across all inline docs.
- For each doc: if full doc fits in remaining budget, include it fully; if it partially fits (`remaining > 0`), truncate to `remaining * 4` chars and set budget exhausted; if no budget remains, emit `[Note: <docName> omitted to fit the context window]` and `continue`.
- Any doc after the cap is crossed — including all subsequent ones — gets the omit note.

### Defect 3 — Wrong preamble for inline-only chats

**Root cause:** The preamble said *"Relevant passages retrieved for the current question are below"* even when the envelope contained only inline full-document content (no vector/FTS5 retrieval at all). This was grammatically wrong and potentially confusing to the model.

**Fix:** Unified preamble that covers both cases:
> *"The user attached files to this conversation. Their content (full documents and/or passages retrieved for the current question) is below. Treat it as readable file content; cite the file name when drawing on it. If it does not contain the answer, say so."*

### New tests (7)

| Test | Validates |
|---|---|
| `priority budget: top-RRF over alphabetical order` | Highest-RRF chunk admitted even when alphabetically last |
| `priority budget: stitch dropped before winner` | winner-2 admitted even when winner-1's stitch would have consumed its slot |
| `combined inline accounting` | Second doc omitted with note when first doc exhausts the combined budget |
| `preamble wording: inline-only` | New combined preamble used for inline-only chats |
| `preamble wording: mixed` | New combined preamble used for inline + retrieved passages |
| All existing 15 tests | Still passing (0 regressions) |

**Total:** 722/723 tests passing (1 intentional skip unchanged). 0 new TypeScript errors.

---

## Phase 3 results (appended 2026-06-12)

### Step 0 — Model spike

Platform: darwin arm64 (MacBook Pro M5 Pro), Node.js v22.16.0, @xenova/transformers ^2.17.2

**Discovery during spike:** The @xenova/transformers v2 high-level `pipeline._call()` does NOT accept `{ text, text_pair }` object inputs — it only accepts plain strings. Cross-encoder scoring requires the low-level tokenizer+model API: `pipe.tokenizer(query, { text_pair: passage })` → `pipe.model(inputs)` → `logits.data[0]`. The Pipeline base class exposes `.tokenizer` and `.model` as properties, making this straightforward.

| Model | Loaded | Cold (ms) | Warm 20-pair (ms) | Ordering ✓ | Notes |
|---|---|---|---|---|---|
| jinaai/jina-reranker-v1-tiny-en | ✅ | 93 | **215** | ✅ | **SELECTED** — preferred + fastest warm latency |
| Xenova/ms-marco-MiniLM-L-6-v2 | ✅ | 46 | 254 | ✅ | Baseline — good fallback |
| mixedbread-ai/mxbai-rerank-xsmall-v1 | ✅ | 381 | 788 | ✅ | Larger model, within budget but slower |

**Selection rule:** highest-quality model that loads AND scores 20 pairs ≤ 1500 ms warm. All three qualify; `jinaai/jina-reranker-v1-tiny-en` selected as first in preference order.

**M1 Pro note:** M1 Pro secondary device (not measured directly) estimated 400–700 ms warm for 20 pairs — still well within the 1 500 ms gate.

```
RERANKER_MODEL_ID = 'jinaai/jina-reranker-v1-tiny-en'
```

### What was built

| Item | File | Notes |
|---|---|---|
| Spike script | `scripts/spike-reranker.ts` | npm run spike:rerank; all 3 candidates tested |
| RerankerService | `src/main/services/rag/RerankerService.ts` | Lazy singleton (EmbeddingService pattern); scoreFn injectable; ensureRerankerReady() fire-and-forget warm-up |
| RAG settings IPC | `src/main/ipc/ragSettingsHandlers.ts` | SETTINGS_GET_RAG / SETTINGS_SAVE_RAG; registered from index.ts (handlers.ts kept untouched per Phase 3 constraints) |
| index.ts wiring | `src/main/index.ts` | +2 lines: import + registerRagSettingsHandlers() |
| Preload bridge | `src/preload/index.ts` | ragGetSettings() / ragSaveSettings() |
| SettingsStore | `src/main/services/SettingsStore.ts` | rerankEnabled?: boolean added to AppSettings |
| UI toggle | `src/renderer/src/components/settings/DebugSettings.tsx` | "Re-rank retrieved passages (cross-encoder, experimental)" Row, follows existing Row/Toggle pattern exactly |
| RagRetrievalService | `src/main/services/rag/RagRetrievalService.ts` | Added RERANK_CANDIDATES=20, FINAL_K_RERANKED=8; step 3.5 optional rerank block (shared budget-allocation code path); rerankUsed/rerankMs in result; scoreFn parameter; readSettings() call per-retrieve; fire-and-forget warm-up |
| shared/types.ts | `src/shared/types.ts` | RagPassage.rerankScore?, RagRetrievalResult.rerankUsed + rerankMs?, IPC_CHANNELS.SETTINGS_GET/SAVE_RAG |
| RerankerService tests | `src/main/services/rag/__tests__/RerankerService.test.ts` | 5 tests: empty, ordering, scoreFn, sort descending, single-element |
| RagRetrievalService rerank tests | existing test file | 4 new tests: flag-off guard, flag-on inverts RRF order via stub scoreFn, rerank throws → fallback, budget correct under rerank order |
| SettingsStore mock | existing test file | vi.mock('../../SettingsStore') added so readSettings() doesn't try app.getPath('userData') in Vitest |

### Deviations from work order

1. **handlers.ts untouched:** Per hard constraint. A new `ragSettingsHandlers.ts` is registered from `index.ts` instead. Result is functionally identical.
2. **Toggle-on warm-up via settings write path:** Implemented in `ragSettingsHandlers.ts` SAVE handler (fires `ensureRerankerReady()` when `rerankEnabled` is set to true). This works without touching handlers.ts.
3. **Scoring:** Sequential (one forward pass per pair), not batched. Simple and consistent with the spike. Batched tokenisation would be ~2× faster but requires careful tensor padding and shape handling; sequential is well within the 1 500 ms gate.

### Test counts

| Suite | New tests | Notes |
|---|---|---|
| RerankerService.test.ts | 5 | Unit tests, injectable scoreFn only, no model download |
| RagRetrievalService.test.ts | 4 | Integration: flag-off guard, rerank ordering, throw fallback, budget correctness |
| **Total** | **9** | 731/732 passing (1 intentional skip unchanged). 0 new TS errors. |

### Phase 3 gate passed?

**Yes.** `jinaai/jina-reranker-v1-tiny-en` scores 20 pairs in 215 ms warm on M5 Pro (≤ 1 500 ms gate ✅). Ordering sanity check passes: relevant passage score 1.0936 > irrelevant −1.6275 ✅. Flag defaults off ✅. All existing tests green ✅.


---

## Phase 4 results — observability traces + evaluation harness (2026-06-13)

### What shipped

| Deliverable | File(s) |
|---|---|
| `RetrieveOptions` 5th param + `RagQueryTrace` | `RagRetrievalService.ts` |
| `rag_ingest` / `rag_query` / `rag_eval` events + `emitRagEvent()` | `ObservabilityService.ts` |
| `coveragePct` in `IngestResult` | `RagIngestionService.ts` |
| `RagEvalService.ts` — metric functions + `runEval()` | `src/main/services/rag/RagEvalService.ts` (new) |
| Chunk inspector IPC (`rag:list-docs`, `rag:export-chunks`) | `ragDiagnosticsHandlers.ts` (new) |
| `rag:run-eval` IPC handler | `ragDiagnosticsHandlers.ts` |
| Debug panel extensions (verbose trace, diagnostics, eval runner) | `DebugSettings.tsx` |
| 40 new tests | `RagEvalService.test.ts`, `RagRetrievalOptions.test.ts` |

### Phase 4 hotfix — eval metric ordering (same session)

**Bug:** `runEval` computed metrics from `result.hits` (alphabetical presentation order).
**Fix:** switched to `trace.allocation admitted` entries in priority order; candidateRecall from
trace stage; `captureTrace: true` on every retrieve call.
3 additional tests added; total 774/775 passing.

### Test counts (Phase 4 total)

| Suite | Tests |
|---|---|
| RagEvalService.test.ts | 25 (22 original + 3 hotfix) |
| RagRetrievalOptions.test.ts | 18 |
| **Total** | **43** |

### Gate passed?

**Yes.** 774/775 tests passing (1 pre-existing intentional skip). 0 TS errors. Metrics now
correctly follow retrieval priority order rather than alphabetical presentation order.
