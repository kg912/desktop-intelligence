# Chat Message Renderer Rebuild — Spec

## Status: Phase 0 — NOT STARTED

This document tracks the complete rebuild of the chat message renderer for Desktop Intelligence, following strict TDD methodology. Each phase is a separate commit; this file is updated upon completion of each phase.

---

## 1. Problem Statement

**Symptoms:**
- **Flicker during streaming**: Content above the viewport shifts/jumps as new tokens arrive.
- **Scroll stutter on M1 Pro**: Scrolling through long conversations (200+ messages) causes visible frame drops.
- **Unbounded memory growth**: Long sessions accumulate cached content with no eviction, including base64 PNGs.
- **Renderer process explosion**: Each stock chart spawns a new Electron `<webview>` renderer process; no reuse on scroll.

**Root Causes (from code audit):**

| # | File | Issue | Impact |
|---|------|-------|--------|
| P1 | `ChatArea.tsx` — `useSignalEffect` + `handleScroll` | `el.scrollTop = el.scrollHeight` runs inside a rAF on every `streamingBlocks` tick. Writing scrollTop forces synchronous layout; next handleScroll read of scrollHeight/scrollTop/clientHeight forces another. Classic read/write thrash. | Flicker + jank during streaming |
| P2 | `ChatArea.tsx` — measure effect | `virtualizer.measureElement(el)` called on every block/content change. Effect dep is `messages[messages.length-1]?.blocks` — new array identity per rAF tick. Full re-measure of growing row every frame. | Scroll position drift → "flicker loop" patched by 500ms `lastWheelTs` guard |
| P3 | `MarkdownRenderer.tsx` | `splitMarkdownIntoBlocks(answer)` + `escapeCurrencyDollars` + `parseThinkBlocks` re-run over entire answer on every token. O(n²) in response length. | Long answers degrade progressively |
| P4 | `MarkdownRenderer.tsx` | `buildComponents()` called twice per instance (`userComponents` + `components`). `MarkdownBlock.components` prop in memo comparison — new Components object defeats memoisation. | Every message re-parses on parent render |
| P5 | `MessageBubble.tsx` — `StockChartBlock` | Electron `<webview>` with `partition="persist:charts"`. Virtualisation unmounts/remounts on scroll. Each mount spawns new renderer process. | M1 Pro stutter — process-level cost, not React cost |
| P6 | `ThinkingAccordion` | One ResizeObserver per thinking block, plus setState from inside observer callback → layout → observer → layout feedback loop. | Worst during streaming |
| P7 | `MarkdownRenderer.tsx` — module-level Maps | 5 module-level Map instances with no eviction. Every distinct code string ever rendered retained, including base64 PNGs in `MATPLOTLIB_CACHE`. | Unbounded memory growth |
| P8 | `ChatArea.tsx` — AnimatePresence | `<AnimatePresence>` wraps CompactToast; key remounts whole list container on chat switch. | Flicker on chat switch |

---

## 2. Architecture: Rebuild Goals

### 2.1 Core Principles

1. **One Scroll Writer** — All auto-scroll through `scrollController`; scroll/wheel handlers only read into refs. No scrollTop writes inside scroll event handlers.
2. **CSS Overflow Anchor** — Let browser handle "content grew above viewport" in compositor, not JS.
3. **Append-Only Block Store** — Stable IDs, structural sharing, immutable appends.
4. **Incremental Markdown Parsing** — Closed fences never re-parsed; only active tail re-tokenized.
5. **Poster-First Charts** — Static PNG poster; webview mounts only on explicit user interaction ("Open interactive chart").
6. **Bounded LRU Cache** — Byte-budget accounting replaces unbounded Maps.

### 2.2 New Units (each independently testable)

| Unit | File | Responsibility |
|------|------|----------------|
| `scrollController` | `src/renderer/src/logic/scrollController.ts` | Pure logic: given scroll state + gesture timing → {shouldAutoScroll, action}. No DOM. |
| `blockStore` | `src/renderer/src/logic/blockStore.ts` | Append-only block list with stable IDs and structural sharing. |
| `incrementalMarkdown` | `src/renderer/src/logic/incrementalMarkdown.ts` | Split into stable closed blocks + active tail. Cache by content hash. |
| `lruCache` | `src/renderer/src/logic/lruCache.ts` | Bounded cache with byte-budget accounting. |
| `estimateSize` | `src/renderer/src/logic/estimateSize.ts` | Per-block-type measurement estimates for virtualizer. |
| `useVirtualRows` | `src/renderer/src/hooks/useVirtualRows.ts` | Measurement strategy: estimateSize from table, measureElement only visible, scrollMargin anchoring. |
| `ScrollBehaviour` (component) | `src/renderer/src/components/chat/ChatArea.tsx` | Rebuilt component using scrollController + overflow-anchor. |
| `MessageRow` (memo) | `src/renderer/src/components/chat/MessageBubble.tsx` | Rebuilt with stable Components, memoisation. |
| `MarkdownBlock` (memo) | `src/renderer/src/components/chat/MarkdownRenderer.tsx` | Incremental parsing, stable Components object. |
| `StockChart` (poster) | `src/renderer/src/components/chat/MarkdownRenderer.tsx` | Poster `<img>` + opt-in webview mount. |
| `ThinkingAccordion` (fixed) | `src/renderer/src/components/chat/MarkdownRenderer.tsx` | Single shared observer, no setState loop. |

---

## 3. Test Plan — TDD Order (RED → GREEN)

### Phase 0: Test Infrastructure + Baseline Capture
**Goal:** Set up test environment so new tests can run; capture current (buggy) behaviour as assertions.

**Tasks:**
1. Add `src/renderer/src/**/__tests__/**/*.test.tsx` to vitest jsdom project includes.
2. Create `src/tests/setup/jsdom-setup.ts` with polyfills:
   - `ResizeObserver` (observe/unobserve/spy)
   - `IntersectionObserver` (rootMargin/intersecting)
   - `requestIdleCallback`, `cancelIdleCallback`
   - `Element.prototype.scrollTo` (spy, no-op)
3. Add `@testing-library/jest-dom` for assertion matchers.
4. Create shared mock for `@preact/signals-react`:
   - `useSignal`, `useComputed` — reuse pattern from existing `InputBar.test.tsx`.
5. Create **baseline capture test** — documents current buggy behaviour:
   - `src/renderer/src/__tests__/renderer-perf.baseline.test.ts`
   - Assert: scrollTop written ≥ N times per M streaming ticks (existing bug).
   - This test is rewritten in Phase 4 to assert fixed behaviour.

**Pass Criteria:**
- `npm run test` passes with existing tests unchanged.
- Baseline test documents current (bad) behaviour — green.

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

### Phase 1: Pure-Logic Tests (Node Env, No React)
**Goal:** Implement and test pure logic units in isolation before touching components.

| Unit | Test File | Cases |
|------|-----------|-------|
| `scrollController` | `scrollController.test.ts` | • Auto-scroll pauses on upward wheel<br>• Resumes only within threshold window<br>• Never resumes within gesture window<br>• No write when already at bottom<br>• Handles scrollHeight growth between frames<br>• Idempotent writes<br>• Handles zero-height container<br>• Programmatic-scroll flag consumption |
| `blockStore` | `blockStore.test.ts` | • Append reuses prior block identities (structural sharing)<br>• IDs stable across appends<br>• Content-hash dedup<br>• Out-of-order/duplicate block IDs rejected<br>• Empty→non-empty transition<br>• blocks array never mutates in place |
| `incrementalMarkdown` | `incrementalMarkdown.test.ts` | • Closed fences never re-parsed<br>• Tail re-parses on change<br>• Fence opened mid-stream not committed until closed<br>• splitMarkdownIntoBlocks output prefix-stable<br>• Blank-line handling<br>• Tilde fences (~~~)<br>• Nested backticks inside fences (CommonMark run-length rule) |
| `lruCache` | `lruCache.test.ts` | • Eviction at capacity<br>• Byte budget enforcement<br>• get() promotes recency<br>• has() does NOT promote<br>• clear()<br>• Oversized single entry rejected (1.5× budget)<br>• Stats tracking |
| `estimateSize` | `estimateSize.test.ts` | • Per-block-type estimates<br>• Monotonic with content length<br>• Clamped to min/max |

**Pass Criteria:**
- All pure-logic tests green.
- `npm run typecheck` passes for all new files.

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

### Phase 2: Existing-Suite Regression Lock
**Goal:** Run and freeze the current behaviour of all existing tests. Nothing breaks during rebuild.

**Existing Tests to Preserve (must pass unchanged):**
- `markdownUtils.test.ts` — parseThinkBlocks, classifyCodeBlock, isValidMermaidSyntax, escapeCurrencyDollars, prepareUserContent, splitMarkdownIntoBlocks
- `chunkBuffer.test.ts`
- `InputBar.test.tsx`, `ModelStore.test.tsx`, `ConnectionStatus.test.tsx`
- `InputTextArea.test.tsx`, `ModelSettingsPanel.test.tsx`
- `InferenceProviderSettingsPanel.test.tsx`, `AppMtplxModelRestore.test.tsx`
- Main-process: `ChatService`, `RAGService`, `FileProcessorService`, `SystemPromptService`, `WebSearchService`

**Tasks:**
1. Run full test suite, record pass count and duration.
2. Fix any pre-existing failures (not introduced by this rebuild).
3. Document pass count as regression baseline.

**Pass Criteria:**
- All existing tests green, same pass count before and after Phase 2.

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

### Phase 3: Component Tests (JS DOM, New)
**Goal:** Test new component behaviour in isolation before integration.

| Component | Test File | Cases |
|-----------|-----------|-------|
| `MessageRow` | `MessageRow.test.tsx` | • Renders user/assistant/divider<br>• Memo does not re-render on unrelated parent update<br>• Re-renders on own message identity change<br>• Streaming row re-renders, completed rows do not |
| `MarkdownBlock` | `MarkdownBlock.test.tsx` | • Stable Components object → no re-parse when only isStreaming flips<br>• Closed block content identical → identical DOM<br>• StreamingCtx propagation |
| `VirtualList` | `VirtualList.test.tsx` | • Renders only visible+overscan rows<br>• Row count matches getVirtualItems()<br>• Measurement not called for offscreen rows<br>• Scroll position preserved when row above grows |
| `ScrollBehaviour` | `ScrollBehaviour.test.tsx` | • **Regression test for reported bug**: simulate 60 streaming ticks while user scrolled up → assert scrollTop written **zero** times<br>• Simulate scroll-to-bottom → assert exactly one write per frame max |
| `BlockRenderer` | `BlockRenderer.test.tsx` | • Each block type routes correctly<br>• Unknown type renders nothing without throwing<br>• Error boundary catches throwing block, renders fallback |
| `ThinkingAccordion` | `ThinkingAccordion.test.tsx` | • Single shared observer<br>• No setState loop (assert render count bounded)<br>• Expand/collapse<br>• Scroll shadows |
| `StockChart` | `StockChart.test.tsx` | • Poster `<img>` renders without `<webview>`<br>• Webview mounts only after interaction<br>• Unmount tears down |

**Pass Criteria:**
- All component tests green.
- `npm run typecheck` passes for all new files.

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

### Phase 4: Integration + Perf Assertion Tests
**Goal:** Prove the rebuild actually fixes the reported issues with quantitative assertions.

| Test File | Assertions |
|-----------|------------|
| `perf.streaming.test.ts` | • 500-token stream into 200-message chat<br>• Total parse calls bounded by frame count, NOT token count<br>• scrollTop writes ≤ 1 per frame max when at bottom |
| `perf.memory.test.ts` | • Render 300 distinct code blocks<br>• Cache size stays ≤ budget (not unbounded)<br>• Old entries evicted |
| `perf.remount.test.ts` | • Scroll 200-row list top→bottom→top<br>• Each row mounts exactly once (no remount churn)<br>• No webview process creation on scroll |
| `perf.baseline-updated.test.ts` | • Rewritten baseline test: scrollTop writes = 0 when scrolled up during streaming<br>• Parse calls per tick ≤ constant |

**Pass Criteria:**
- All perf tests green.
- Baseline test now asserts fixed behaviour (was documenting buggy behaviour in Phase 0).

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

### Phase 5: Manual Verification + Documentation
**Goal:** Capture real-world performance metrics and document the rebuild.

**DevTools Performance Recording Protocol:**
- Open 200-message chat with mixed content (text, code blocks, charts).
- Rapid scroll up/down 5x.
- Concurrent streaming simulation.

**Metrics to Capture:**

| Metric | Current (Baseline) | Target |
|--------|-------------------|--------|
| Scripting time / 5s scroll | baseline (capture) | ≤ 40% reduction |
| Long tasks (>50ms) | baseline (capture) | 0 long tasks |
| scrollTop writes / s | ~60 (documented in baseline) | ≤ 1 per frame, 0 when scrolled up |
| Renderer processes after 20 charts | 20+ (one per webview) | 1 (poster image, no webviews until interaction) |
| Heap after 300 code blocks | unbounded growth | Flat (LRU eviction) |
| Parse calls per streaming tick | O(n²) response length | Constant (incremental only) |

**Documentation:**
- Update `progress.md` with rebuild summary.
- Version bump changelog entry.
- Add inline comments in scrollController.ts explaining the flicker fix (future-proofing).

**Date Started:** ___ | **Date Completed:** ___
**Commit Hash:** ___

---

## 4. Risk Register & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `<webview>` → `<img>` changes chart UX | High | Medium | Poster + explicit "Open interactive" button. Behaviour locked by StockChart.test.tsx assertions. |
| Virtualizer measurement changes shift scroll position | Medium | High | `scrollMargin` + CSS `overflow-anchor`. ScrollBehaviour.test.tsx asserts position preservation. |
| `@preact/signals-react` + jsdom flaky (existing pattern) | High | Low | Reuse exact mock pattern from InputBar.test.tsx. Add shared signals.mock.ts for consistency. |
| jsdom lacks ResizeObserver/IntersectionObserver | Certain | Low | Polyfills in setup file. Tests assert call counts, not actual observer behaviour. |
| Mermaid/ECharts heavy in jsdom (memory/time) | Medium | Low | `vi.mock` at module boundary. Test routing logic, not library rendering. |
| Breaking existing signal-based subscriptions | Medium | High | Preserved in Phase 2 regression lock. All signal consumers tested unchanged. |
| Main-process service contracts change | Low | Critical | No main-process changes in scope. Renderers only touch renderer-side logic. |

---

## 5. Non-Negotiable Constraints (from project rules)

1. **TDD Strictly Enforced** — Every unit of functionality must have failing tests before implementation. No exceptions.
2. **No changes to main-process code** — Only renderer-side modifications.
3. **Preserve signal-based architecture** — `@preact/signals-react` is the state management layer. New code uses signals, existing consumers unchanged.
4. **No new external dependencies** — Only use what's already in package.json or testing infrastructure (vitest, jsdom-polyfills are dev-only).
5. **TypeScript strict mode** — All new code must pass `npm run typecheck`.
6. **ESLint rules preserved** — No lint changes, only code that passes existing rules.
7. **One commit per phase** — Each phase is a separate, bisectable commit.
8. **No ASCII trees in output** — Use mermaid for architecture diagrams only (this doc is markdown spec, not UI output).

---

## 6. Decisions Confirmed by Stakeholder (Karan)

1. **`<webview>` → `<img>` poster with opt-in interactive mount** — AGREED. This is the largest single M1 Pro performance win and acceptable UX trade-off.
2. **Scope of regression lock** — AGREED to include main-process services that the renderer depends on (`ChatService`, `chunkBuffer`) in Phase 2 lock.

---

## 7. Execution Order Summary

```
Phase 0: Test infra + baseline capture → commit
         ↓
Phase 1: Pure-logic tests (red→green) + implement 5 units → commit
         ↓
Phase 2: Existing-suite regression lock → record pass count → commit
         ↓
Phase 3: Component tests (red→green) + rebuild ChatArea/MessageBubble/MarkdownRenderer → commit
         ↓
Phase 4: Perf tests (red→green) + tune → commit
         ↓
Phase 5: Manual verification + progress.md update + version bump
```

---

*Document last updated: [TO BE FILLED AFTER PHASE 0]*
*Next action: Await stakeholder go-ahead to begin Phase 0.*
