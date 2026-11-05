# M1 Pro UI Jank — Round 5 Investigation & Verification Report

**Date:** 2026-11-02 · **Repo:** `desktop-intelligence` · **Build inspected:** 3.2.71 / 3.2.86 packaged arm64 (`Electron 44.5.1`, Chromium `152.0.7977.130`)

> **Hardware note (§7.8):** The M1 Pro (`MacBookPro18,3`) is not attached to this environment. All trace, profile, and build-artifact verifications below come from the M5 Pro (`Mac17,9`, built-in 120.0006 Hz panel, 8.33 ms frame budget) on packaged builds (`scripts/perf-r3-gon-{a,b,c}`, `scripts/perf-r3-thr2-{a,b,c}`, `scripts/perf-r3-goff-{a,b,c}`, and `out/renderer/`).

---

## 1. Profile of the 719 ms Main-Thread Busy Time (§6.1 / G1)

Captured via `scripts/perf-scroll-capture.mjs` on the packaged 3.2.71 build (`perf-r3-gon-{a,b,c}-cpu-profile.json` and trace timelines, N = 3 runs on the 103-chart heavy chat `"what is -log(p)"`, 120 synthetic wheel events across 4 down/up cycles).

### 1.1 Top Functions by Self Time (Scroll Burst on Packaged Build)

| Function / Category | Self ms (1× Baseline) | % of 719 ms | Self ms (2× CPU Throttle) | Notes / Call Site |
|---|---:|---:|---:|---|
| `(program)` — Blink C++ native (layout / style / paint / composite) | **430 ms** | **59.8%** | ~650+ ms | Up from 243 ms on Electron 33; dominated by synchronous layout forced from JS and Chromium 152 `ScrollLayer` + `performPostLayoutTasks` |
| `updateScrollShadows` (`ThinkingAccordion`) | **80 ms** | **11.1%** | **161 ms** | `src/renderer/src/components/chat/MessageBubble.tsx:194–210` — largest single application JS function |
| `ScrollLayer` (Blink compositor/scroll step in >8.3 ms tasks) | **49 ms** | **6.8%** | **275 ms** | Chromium internal scroll layer update (was 3 ms in Electron 33) |
| `performPostLayoutTasks` (Blink post-layout in >8.3 ms tasks) | **49 ms** | **6.8%** | **271 ms** | Chromium post-layout step (was 3 ms in Electron 33) |
| Remaining App JS (`@tanstack/react-virtual` `measureElement`, React fiber commit/reconcile) | **87 ms** | **12.1%** | **316 ms** | Total App JS inside >8.3 ms tasks is **167 ms** at 1× (80 ms `updateScrollShadows` + 87 ms virtualizer/React) and **477 ms** at 2× |

### 1.2 Resolution of the Five Named Suspects (§6.1)

1. **`getBoundingClientRect` / forced synchronous layout:**
   - Triggered on every virtualized row mount during scroll via two paths:
     - `ThinkingAccordion`'s mount `useEffect` (`MessageBubble.tsx:207–210`) calls `updateScrollShadows(scrollRef.current)`, which reads `scrollTop`, `scrollHeight`, and `clientHeight` (`MessageBubble.tsx:195`) synchronously right after DOM mutation in the React commit phase — forcing synchronous Blink layout (**80 ms** self time attributed directly to `updateScrollShadows` at 1×, **161 ms** at 2×).
     - `@tanstack/react-virtual`'s `ref={virtualizer.measureElement}` (`ChatArea.tsx:257`) measures each newly mounted `[data-index]` row.
2. **Per-bubble `ResizeObserver` callbacks:**
   - In `ThinkingAccordion` (`MessageBubble.tsx:163–185`), the `ResizeObserver` has an early return: `if ((!isStreaming && !open) || !contentRef.current) return`. During historical chat scrolling (`!isStreaming && !open`), per-bubble `ThinkingAccordion` `ResizeObserver`s **do not attach**.
   - The active `ResizeObserver` during scroll is `@tanstack/react-virtual`'s item measurement observer attached via `ref={virtualizer.measureElement}` on the `[data-index]` wrapper divs (`ChatArea.tsx:257`). Note also that the imperative `virtualizer.measureElement(el)` in `ChatArea.tsx:162–169` is gated on `if (lastMsg?.isStreaming)` and does **not** double-fire on static scroll.
3. **`setShowBottomShadow` / `updateScrollShadows` → React commit cascade:**
   - **80 ms** on M5 baseline (11.1% of all main-thread busy time; **47.9% of all App JS time** in long tasks) and **161 ms** under 2× CPU throttle.
   - Root cause: `useEffect(() => { if (!scrollRef.current) return; updateScrollShadows(scrollRef.current) }, [open, isStreaming, measuredHeight])` at `MessageBubble.tsx:207–210` runs on **every mount** of a virtualized message row that contains a `ThinkingAccordion`, even when `!open && !isStreaming` (when the accordion is collapsed to `height: 0px` and the shadow DOM nodes at lines 253–272 aren't even rendered because they are gated on `{!isStreaming && open && isScrollable}`). Reading `scrollHeight` and `clientHeight` inside this mount effect forces a synchronous layout reflow on every row mount during fast scroll.
4. **Markdown re-parse (`react-markdown` / remark / rehype-katex):**
   - **On the scroll path** whenever virtualized rows leave the viewport (`overscan: 3`) and remount as the user scrolls back and forth. Because `ChatArea` unmounts rows outside the viewport + overscan window, `MarkdownRenderer` → `MarkdownBlock` (`ReactMarkdown` with `remarkGfm`, `remarkMath`, `rehypeKatex`) re-runs from scratch on every remounted bubble. (Module-level `LruMap` caches in `MarkdownRenderer.tsx:151–160` cache `HIGHLIGHT_CACHE`, `MERMAID_CACHE`, `ECHARTS_CACHE`, `MATPLOTLIB_CACHE`, and `SVG_CACHE`, avoiding async re-renders of charts/code, but `ReactMarkdown` AST parsing + KaTeX HTML generation still execute on row mount.)
5. **`react-markdown` / `highlight.js` / `framer-motion` breakdown:**
   - **`highlight.js`**: ~0 ms on scroll repeats because `HIGHLIGHT_CACHE` (`LruMap(500)`, `MarkdownRenderer.tsx:151`) serves cached HTML synchronously on initial state (`useState(() => HIGHLIGHT_CACHE.get(cacheKey))`), and `highlightAuto` was removed in row 356.
   - **`framer-motion`**: ~0 ms per message row during scroll (`motion.div` and inner `AnimatePresence` were removed from `MessageBubble` and `ChatArea` in earlier rounds; only the outer `CompactToast` `AnimatePresence` remains in `ChatArea.tsx:229`).
   - **`react-markdown` + React DOM mount**: accounts for the bulk of the remaining **87 ms** of App JS time (alongside `@tanstack/react-virtual`) and feeds the **430 ms** `(program)` Blink style/layout cost when mounting complex DOM subtrees per virtualized row.

---

## 2. The Fork Verdict (§5 & §6.2 / G2)

> **Fork Verdict: CPU-bound — Viz busy time stays completely flat at `27 ms` (baseline) vs `27 ms` (2× renderer CPU throttle), while renderer main-thread busy time scales linearly from `719 ms` → `1398 ms`.**

From `docs/perf/m1pro-round3.md` §1 (row E1 vs row E5, computed via `scripts/perf-scroll-metrics.mjs` across `perf-r3-gon-{a,b,c}.json` and `perf-r3-thr2-{a,b,c}.json`):

| Condition | Renderer Main Busy | Viz Compositor Busy | GPU Main Busy | Tasks > 8.33 ms | Tasks > 16 ms | Max Task | Dropped Frames (Smooth) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **Baseline (1×, packaged 3.2.71)** | **719 ms** (705–721) | **27 ms** | 162 ms | 23 | 5 | 32.5 ms | 13 (2) |
| **2× CPU Throttle (`CPU_THROTTLE=2`)** | **1398 ms** (1370–1420) | **27 ms** | 158 ms | 53 | 25 | 61.3 ms | 38 (7) |

Per the §5 decision matrix:
- Renderer busy is `~2× baseline` (`1398 / 719 = 1.94×`).
- Viz busy is **flat (`27 ms` → `27 ms`)**.
- GPU main thread busy is **flat (`162 ms` → `158 ms`)**.
- **Verdict:** **Strictly Renderer Main-Thread CPU-bound.** Compositor / `backdrop-filter` is not the bottleneck.

---

## 3. Build-Artifact Verification (§6.3 / G6, G7, G8–G11)

Verified directly against `out/renderer/` and packaged `app.asar` inspection (`docs/perf/m1pro-round3.md` §2 E4 & `out/renderer/assets/`):

1. **Is the packaged build React production? (G6)**
   - **Yes — Confirmed.** The shipped entry bundle (`index-CnM5BRt2.js` in 3.2.71 `app.asar`, `index-I-juvJtb.js` in current `out/renderer/assets/`) contains `"Minified React error"` and zero React development warnings. All numbers were captured on production React.
2. **Are `mermaid` and `echarts` in the shipped entry bundle, and what are the real chunk sizes? (G7)**
   - **Yes — Confirmed, with exact sourcemap-attributed sizes:**
   - Single entry script in `out/renderer/index.html`: `<script type="module" crossorigin src="./assets/index-I-juvJtb.js"></script>` — **6,294,831 bytes (6.29 MB / 6.0 MiB)** (unsplit entry chunk), plus `index-CGAqwiP1.css` (**164.3 KB**). Total renderer JS across `out/renderer/assets/` is **10.65 MB**.
   - Breakdown of the 6.29 MB entry chunk (`index-*.js`):
     | Library | Bundled Size in Entry Chunk | Notes |
     |---|---:|---|
     | `echarts` | **2.22 MB** | Eagerly bundled via static import in `MarkdownRenderer.tsx:51` |
     | `zrender` (ECharts dependency) | **0.51 MB** | Eagerly bundled with ECharts |
     | `mermaid` (core) | **0.71 MB** | Static import in `MarkdownRenderer.tsx:50`; diagram definitions split into ~110 lazy chunks (`cytoscape.esm` 934 KB, `wardley` 910 KB, `architectureDiagram` 406 KB, etc.) |
     | `katex` | **0.48 MB** | Static import via `rehype-katex` |
     | `framer-motion` | **0.25 MB** | Static import |
     | `react-dom` (production) | **0.21 MB** | Minified production build |
   - *Note:* While lazy-loading `echarts` and `mermaid` behind dynamic `import()` will cut initial bundle parse/compile time by ~3.44 MB, it does not change steady-state scroll busy time once loaded.
3. **Additional Gap Resolutions (G8–G11):**
   - **G8 (Streaming IPC / Poll intervals / `webPreferences` / `ResourceGovernor`):**
     - Streaming IPC chunks are buffered in `chunkBufferRef` and flushed to `@preact/signals-react` at most **once per `requestAnimationFrame`** (`scheduleStateFlush` in `useChat.ts:284–302`).
     - `ResourceGovernor` (`src/main/services/sandbox/ResourceGovernor.ts:27–49`) batches all watched PIDs into a **single** `ps -A -o pid=,ppid=,rss=` call every **5,000 ms** (rewritten in row 311/323; idle cost verified at 0.0% in row 363).
     - `webPreferences` (`src/main/index.ts:138–144`): `contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true`, opaque `#0f0f0f` window, zero GPU switches by default.
   - **G9 (`InputTextArea`):** Signal-controlled (`value={textAreaSignal.value}` in `InputTextArea.tsx:25`); row 357 verified via React commit hook that typing a keystroke re-renders **only** `InputTextArea` (1 component) and never `Layout`, `ChatArea`, or `Sidebar`.
   - **G10 (`Sidebar` list):** Unvirtualized (`Sidebar.tsx:895–949`), with `useState` `hovered` in `ChatItem` (`Sidebar.tsx:132`). Does not fire during chat-column wheel scroll, but hovering across sidebar items triggers React state updates on `ChatItem`.
   - **G11 (Electron 33 vs 44 inconsistency):** Resolved in `docs/perf/m1pro-round3.md` §1 & §2. Recomputing the raw `perf-e33-{a,b,c}.json` and `perf-e44-{a,b,c}.json` traces with the unified `scripts/perf-scroll-metrics.mjs` script yields consistent numbers:
     - **Electron 33 (beta-83):** `500 ms` main busy (`499–515 ms`), `21.1 ms` wheel p95, `37.7 ms` 1st-scroll-update p95, `14` tasks >8.3 ms, `23 ms` Viz busy.
     - **Electron 44 (beta-85):** `665 ms` main busy (`649–675 ms`), `29.9 ms` wheel p95, `86.6 ms` 1st-scroll-update p95, `19` tasks >8.3 ms, `25 ms` Viz busy.
     - The earlier "31–32 vs 37–40" and "650 vs 719" discrepancies were caused by an uncommitted prior metric script and minor code growth between beta-85 (665 ms) and 3.2.71 (719 ms).

---

## 4. `backdrop-filter` Status (§6.4 / G4)

Per §5 and §6.4 ("only after §5" / "only if §5 pointed there"):
- Because §5 proved the bottleneck is **CPU-bound** (Viz busy flat at `27 ms` under 2× throttle), `backdrop-filter` is **not** on the critical path of the scroll jank.
- Furthermore, in the standard single-chat scroll repro, **zero** `backdrop-filter` elements are mounted in the DOM:
  - `.ma-glass-pill` (`Layout.tsx:782`) only mounts when `shownRun || reviewableChat === activeChatId` (multi-agent chats only), and `.ma-pill-dot` (`animation: ma-glow`) only mounts when `dockOpen && shownRunActive`.
  - `.ma-focus` (`AgentFocusView.tsx`) only mounts when the multi-agent full-screen focus modal is open.
  - `Layout.tsx:746` (`backdrop-blur-sm`) only mounts when an MCP permission or FS access modal is actively waiting for user input.
  - `SettingsModal`, `TopBar` popover, and `ConnectionStatus` blurs were already removed in row 360.

---

## 5. Burst Duration & Main-Thread Utilization % (§6.1 / G3 & §9.5)

From `scripts/perf-scroll-capture.mjs` (`lines 135–146, 188–190`):
- **Synthetic gesture dispatch window:** `4 cycles × 2 legs × 15 wheel events = 120 wheel events`. Each event awaits `setTimeout(12 ms)` plus ~1.7 ms CDP round-trip ≈ **1,650 ms** of active wheel dispatch, followed by a `500 ms` post-scroll settle wait before `Profiler.stop()` = **~2,150 ms total trace window** (~258 vsyncs at 120 Hz; ~198 vsyncs during active scroll).
- Comparing utilization against both the **1.65 s active scroll window** and the **2.15 s total capture window**:

| Machine / Condition | Main-Thread Busy | Active Scroll Window (~1.65 s) Utilization | Full Trace Window (~2.15 s) Utilization | Viz Thread Busy (Util %) | Tasks > 8.33 ms (120 Hz budget) | Tasks > 16.67 ms (60 Hz budget) | Dropped Frames |
|---|---:|---:|---:|---:|---:|---:|---:|
| **M5 Pro — Electron 33 (beta-83)** | 500 ms | **30.3%** | 23.3% | 23 ms (1.4%) | 14 | 3 | 7 (0 smooth) |
| **M5 Pro — Electron 44 Baseline (3.2.71, 1×)** | **719 ms** | **43.6%** *(71.9% of a 1 s burst)* | 33.4% | 27 ms (1.6%) | **23** | **5** | **13 (2 smooth)** |
| **M5 Pro — GPU Off (Software Compositing)** | 727 ms | **44.1%** | 33.8% | **999 ms (60.5%)** | 25 | 5 | 13 (2 smooth) |
| **M5 Pro — 2× Renderer CPU Throttle (M1 Pro Proxy)** | **1398 ms** | **84.7%** *(139.8% of a 1 s burst)* | 65.0% | 27 ms (1.6%) | **53** | **25** | **38 (7 smooth)** |

*Key insight:* During the ~1.65 s active scroll gesture (or normalized to a 1 s burst), the 2× throttled renderer main thread is at **84.7%–139.8% saturation**, with **53 tasks exceeding the 8.33 ms 120 Hz frame budget** (up from 23) and **25 tasks exceeding 16 ms** (up from 5).

---

## 6. The Single Next Change (§9.6)

### Recommendation

**In `ThinkingAccordion` (`src/renderer/src/components/chat/MessageBubble.tsx:206–210`), guard the `updateScrollShadows` effect so it does not run when the accordion is collapsed (`!open && !isStreaming`):**

```tsx
  // Update scroll shadows when state or size changes
  useEffect(() => {
    if ((!open && !isStreaming) || !scrollRef.current) return
    updateScrollShadows(scrollRef.current)
  }, [open, isStreaming, measuredHeight])
```

### Measurement that Justifies It

1. **Direct CPU profile attribution:** `updateScrollShadows` is the **#1 application JS function** in the scroll profile, consuming **80 ms** of self time per scroll burst on the M5 Pro (**11.1%** of total main-thread busy time, and **47.9%** of all App JS time in >8.3 ms tasks) and **161 ms** under the 2× CPU throttle.
2. **Mechanism:** Every time `@tanstack/react-virtual` mounts a message row containing a `ThinkingAccordion` during scrolling, this `useEffect` fires on mount even though `open === false` and `isStreaming === false`. Inside `updateScrollShadows`, reading `target.scrollTop`, `target.scrollHeight`, and `target.clientHeight` (`MessageBubble.tsx:195`) forces a synchronous Blink layout reflow right after React's DOM commit, while the container is `height: 0px` and the shadow elements (`lines 253–272`) aren't even rendered.
3. **Zero visual or behavioural regression:** When `!open && !isStreaming`, the scroll shadows are not in the DOM (`{!isStreaming && open && isScrollable && (...)}`). The moment the user clicks to open the accordion (`open` becomes `true`) or streaming starts (`isStreaming` becomes `true`), the effect runs normally.

---

## 7. What Could Not Be Tested and Why (§9.7)

1. **Physical M1 Pro (`MacBookPro18,3`) trace (G5):** No M1 Pro machine is connected to this environment. All measurements use the M5 Pro baseline and the 2× renderer CPU throttle (`Emulation.setCPUThrottlingRate({ rate: 2 })`) on the packaged build.
2. **Skia Graphite vs. Ganesh on Apple Silicon (§2.1):** Untestable in Electron 44 without changing Electron major versions, because `--disable-skia-graphite` and `--disable-features=SkiaGraphite` disable hardware GPU acceleration entirely on macOS arm64 (`Viz` jumps from `27 ms` → `999 ms`).
3. **Live A/B trace of `backdrop-filter` in a multi-agent active run (§6.4):** Skipped per §5/§6.4 because the fork test proved the scroll jank is renderer main-thread CPU-bound (`Viz` flat at `27 ms`), and none of the `backdrop-filter` scrims are mounted in single-chat scroll.

---

## 8. Result of the §6 change (measured 2026-11-05, 3.2.89)

The guard shipped as recommended (`MessageBubble.tsx`, the `updateScrollShadows` effect returns early when `!open && !isStreaming`).
Unit tests: `src/tests/hitl/ThinkingAccordion.test.tsx` (collapsed mount reads neither `scrollHeight` nor `clientHeight`;
opening still shows the bottom shadow only; streaming starting still reads the geometry).

A/B on the M5 Pro, two packaged `--dir` builds of the same tree that differ only in that one line (confirmed by diffing the
two renderer bundles), same chat (`"what is -log(p)"`) and window as round 3 (scroll container 634 px tall at (794,369) in
all six runs), 1× CPU, N = 3, run back to back: `scripts/perf-r5-{base,change}-{a,b,c}.json`.

| Metric | Baseline (no guard) | Change (guard) | Δ median |
|---|---:|---:|---:|
| Renderer main busy ms | **705** (679–756) | **684** (663–722) | −21 (−3%) |
| `updateScrollShadows` self ms (CPU profile) | **77** (75–80) | **0** (0–0) | −77 |
| `(program)` self ms (Blink native) | 490 (462–506) | 550 (524–556) | +60 |
| Tasks > 8.33 ms | 23 (20–26) | 22 (21–25) | −1 |
| Tasks > 16 ms | 2 (2–3) | 2 (1–4) | 0 |
| Wheel p95 ms | 27.8 (23.4–29.0) | 28.5 (22.6–30.5) | +0.7 |
| Dropped frames (smooth) | 15 (1) | 12 (1) | −3 |

(The round 3 `perf-r3-gon-a` profile gives 80 ms for `updateScrollShadows` with the same self-time method, so the baseline matches.)

**Verdict: no clear win.** The function's 77 ms is gone, but about 60 ms of it reappears as Blink native `(program)` time:
the forced layout the effect triggered still has to happen at the next frame's normal layout, so the effect was mostly
moving layout earlier, not adding it. The −21 ms median busy change is smaller than the 77 ms baseline spread, and frame
metrics (long tasks, wheel p95) did not move. The change stays in because it removes wasted JS with no behaviour change,
but it does not fix the jank; the remaining cost is layout/style of remounted rows (`(program)`), which this guard cannot touch.
