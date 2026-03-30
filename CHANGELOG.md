# Changelog

All notable changes to Desktop Intelligence are documented here.

---

## [1.5.0] — 2026-03-30

This is the first stable release. It represents the full feature-complete build as of March 2026 and is the recommended version for daily use.

### Highlights

- **Model-agnostic** — works with any model you have downloaded in LM Studio. Pick it from a dropdown on first launch; switch models at runtime from the settings pane.
- **Native matplotlib charts** — rendered via a persistent Python worker process (~200ms render time vs 3–4s cold-start in earlier builds).
- **Per-block chart execution** — in multi-chart responses, each chart starts rendering as soon as its code block is complete, not waiting for the entire response to finish.
- **Mermaid mindmaps** — hierarchical diagrams (taxonomies, concept maps, topic trees) now render as SVG via `mindmap` blocks.

---

### New Features

#### First-Launch Onboarding & Model Selector
On first launch, a welcome screen prompts you to choose any model you have downloaded in LM Studio and set your initial context length. Your selection is saved and applied automatically on every subsequent launch — no manual LM Studio configuration needed.

![First-launch model selector](app_images/setup_screen_model_selector_form.png)

#### Settings Pane (⚙️)
- Change your active model or context length at runtime without restarting the app
- Slider with preset chips: 4K / 8K / 16K / 32K / 64K / 128K
- Reload runs `lms unload --all` → `lms load <model> --context-length <N>` via the CLI
- Your chosen context length persists across app restarts

#### Persistent Python Worker
The matplotlib rendering pipeline now keeps a warm Python process alive for the lifetime of the app session. Imports (`numpy`, `matplotlib`, `scipy`) happen once at startup; each chart render pays only for user code execution.

- **Before:** 3–4 second cold-start per chart
- **After:** ~200ms per chart after first load
- Multiple charts in a single response are queued (FIFO) on the warm worker — no fallback to slow one-shot spawns

#### Per-Block Chart Stabilisation
Charts no longer wait for the entire response to finish streaming before rendering. Each code block is monitored independently: 800ms of code-content stability while the model is still writing signals that the closing ` ``` ` has been received, and execution begins immediately. Chart 1 can be rendering while the model is still writing Chart 2's prose.

#### Thinking / Fast Mode Toggle
- **Thinking mode** (🧠): enables chain-of-thought reasoning (`budget_tokens: 8000`). Best for complex tasks — code review, document analysis, multi-step math.
- **Fast mode** (⚡): direct responses with no reasoning step. Lower latency for conversational queries.
- Toggle is in the input bar; switching mid-conversation inserts a labelled divider.
- Mode auto-elevates to Thinking when a PDF or image is attached.
- `<think>...</think>` blocks are stripped from conversation history before re-sending to the model — recovers 60–80% of the context they would otherwise occupy.

#### Mermaid Mindmaps & Extended Diagram Types
- `mindmap` added as a supported Mermaid diagram type — renders hierarchical concept maps, taxonomies, and topic trees as native SVG
- ASCII box-drawing trees (`├──`, `└──`) are explicitly banned from prose output; the model is instructed to use `mindmap` instead

---

### Improvements

#### Chart Safety Shims (worker_harness.py)
The Python execution environment now includes additional runtime guards:

| Shim | What it fixes |
|------|--------------|
| `_safe_barh` / `_safe_bar` | Auto-converts Python list labels to `np.array` before axis calls — prevents `TypeError: only integer scalar arrays can be converted to a scalar index` |
| `_safe_scatter` | Truncates mismatched `x`/`y` arrays to `min(len(x), len(y))` — prevents `ValueError: x and y must be the same size` |
| `_safe_plot` | Same truncation for two-argument `plot(x, y)` calls |
| `_FlexAxes` | Out-of-bounds subplot axis access returns a hidden off-screen axis instead of `IndexError` |
| `_fix_cov()` | 1-D covariance vectors auto-promoted to diagonal 2×2 matrices for GMM/multivariate normal calls |
| `_mvn_safe_pdf()` | Misshapen meshgrid arrays `(d, N)` auto-transposed to `(N, d)` |
| `_auto_norm_imshow()` | 2D float arrays auto-normalised to `[min, max]` — prevents washed-out feature maps |

#### exec Scope Fix
The Python worker's `execute_chart()` now runs user code with `dict(globals())` as the exec namespace, so all pre-imported names and shims are available to user code without explicit imports. Each render gets a fresh copy of the namespace — no cross-request pollution.

#### False-Positive "Offline" Overlay Fix
The connection health check requires **two consecutive** failures before showing the offline overlay. A single timeout during GPU-intensive generation is silently absorbed. The overlay now reliably represents a genuine disconnect.

#### History Window Trimming
Conversation history is capped at 20 messages before being sent to LM Studio. This prevents context overflow in long sessions, particularly important when large base64 chart images are part of the history.

#### Empty Response Guard
If the LM Studio stream produces zero tokens, the app emits a human-readable error message instead of silently hanging.

---

### Bug Fixes

- **"MODEL" shown on startup instead of model name** — `SETTINGS_GET_MODEL` now reads `modelId` directly from the settings store rather than parsing `lms ps` output, eliminating regex mismatches against table headers.
- **RAG context not injected** — fire-and-forget ingest replaced with `await`; `chat_id` race on first message fixed by pre-creating the chat row before PDF processing begins.
- **Runaway generation loop** — `stop` sequences array added to every LM Studio payload; client-side repetition detector aborts the stream if the same line appears 3+ consecutive times.
- **Mermaid `antiscript` security level** — switched to `loose` to prevent DOMPurify from stripping SVG `xmlns` attributes in the Electron renderer.
- **`<think>` leak on models that mention `</think>` mid-thought** — regex switched from non-greedy (first match) to `lastIndexOf` (final match), so thought content never leaks into the answer area.
- **False-positive offline during PDF generation** — health-check timeout raised 5s → 8s; consecutive-failure threshold set to 2.

---

### Reliability & Safety

- **Stop sequences** included in every LM Studio payload: `<|im_end|>`, `<|endoftext|>`, and common loop-trigger phrases.
- **Banned imports** in the Python sandbox: `sklearn`, `pandas`, `seaborn`, `torch`, `tensorflow`, `keras` — raise a clear `ImportError` immediately.
- **`matplotlib.use()`** patched to no-op — prevents crash if model code calls it after `Agg` is already set.
- **`suptitle(pad=...)`** patched to silently drop the invalid kwarg.
- **Worker auto-restart** — if the Python worker crashes unexpectedly, it restarts automatically after 1 second. Any in-flight render falls back to a one-shot spawn.

---

## [1.0.0] — 2026-03-21

Initial scaffold. Core Electron + React + Vite + TypeScript application with:

- Streaming chat via LM Studio `/v1/chat/completions`
- SQLite chat history (better-sqlite3)
- PDF attachment and text extraction (pdf-parse)
- IPC file transfer via ArrayBuffer
- LM Studio daemon management with exponential-backoff health polling
- Base Markdown rendering, syntax highlighting, KaTeX math
- Mermaid SVG diagrams

---

*For a detailed technical change log, see [CLAUDE.md](CLAUDE.md) Section 0.*
