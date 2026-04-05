# Desktop Intelligence — Features

A complete reference of every capability currently implemented in the app.

---

## Recommended Models

Desktop Intelligence is tested on Apple Silicon and optimised for local MoE models. These are the best options:

| Model | Notes |
|-------|-------|
| `google/gemma-4-26b-a4b` | **Top pick.** Gemma 4's 26B MoE with 4B active parameters. Exceptional reasoning, vision support, and fast inference. Available as GGUF directly in LM Studio — no MLX conversion needed. Native web search via mid-stream tool calls. |
| `mlx-community/Qwen3.5-35B-A3B-6bit` | Excellent thinking mode and coding. ~71 tok/s on M5 Pro. Best-in-class for complex reasoning tasks when using MLX. |
| Any Qwen3 14B–32B MLX | Strong balance of speed and quality. Fully supported: thinking mode, web search, tool calls. |
| Any DeepSeek-R1 MLX distil (7B–14B) | Good reasoning at lower RAM. Works well on 32 GB machines. |

All models above support Thinking mode. Gemma 4 and Qwen3 are the primary tested configurations.

---

## Chat

### Streaming Responses
- Token-by-token streaming with a live blinking cursor — output appears as the model generates it, not after
- Smooth auto-scroll follows live output; pauses when you scroll up; resumes when you scroll to the bottom or send a new message
- Stream can be aborted mid-generation (stop button)

### Markdown Rendering
- Full CommonMark + GFM support: headings, bold/italic/strikethrough, blockquotes, task lists, tables, horizontal rules
- Inline code and fenced code blocks with language labels
- Nested lists and deep indentation handled correctly

### Syntax Highlighting
- Powered by **highlight.js** with a dark theme matched to the app palette
- Auto-detects language from the fenced code block identifier
- One-click **Copy** button on every code block

### LaTeX Math
- Inline math: `$...$`
- Display (block) math: `$$...$$`
- Rendered with **KaTeX** — fast, no external fonts, no network requests

### Mermaid Diagrams
- Rendered as native **SVG** in the browser — no external service
- Supported diagram types: flowcharts, sequence diagrams, class diagrams, Gantt charts, pie charts, state diagrams, entity-relationship diagrams, mindmaps, timelines, block diagrams, quadrant charts, and more
- Graceful error fallback: if a diagram fails to parse, the raw code block is shown instead
- Diagrams are skipped while the model is still streaming (prevents half-parsed renders)

### Thinking / Fast Mode Toggle
- **Thinking mode** (🧠): enables the model's chain-of-thought reasoning (`budget_tokens: 8000`). Higher quality for complex tasks — math, code review, document analysis, multi-step reasoning. Works with any reasoning-capable model (e.g. Qwen3, DeepSeek-R1)
- **Fast mode** (⚡): direct responses with no reasoning step. Lower latency, ideal for conversational queries and simple lookups
- Toggle is visible in the input bar; switching mid-conversation inserts a labelled divider
- Mode automatically elevates to Thinking when a PDF or image is attached
- `<think>...</think>` blocks are stripped from conversation history before re-sending to the model, reducing context usage by 60–80% in long thinking-mode sessions
- Gemma 4 thinking is activated via a `<|think|>` system prompt token (Gemma's native mechanism). The `/think` and `/no_think` soft-prompt prefixes are Qwen-specific and are automatically skipped for Gemma models.

### Thought Process Accordion
- The model's internal reasoning is rendered in a collapsible accordion — dimmed, muted style so it doesn't dominate the UI. Collapsed by default; click to expand. Supports both `<think>...</think>` (Qwen3, DeepSeek) and `<|channel>thought\n...<channel|>` (Gemma 4 native format); both are normalised to the same accordion component.

### Context Utilisation Indicator
- A slim progress bar in the top-right corner shows how much of the model's context window is currently in use
- Colour transitions from muted → amber → red as context fills, giving an early warning before overflow
- Hover over the bar to see exact token counts: e.g. "Used: 12,450 / 65,536 tokens (19%)"
- Updates after every completed response; resets when you start a new chat

---

## Document Q&A (RAG)

### PDF Attachment
- Attach a PDF via the paperclip icon in the input bar
- The app extracts the full document text using **pdf-parse** (runs in the main process, not the renderer)
- Extracted text is stored in SQLite alongside the chat, scoped per chat session

### Context Injection
- On every message in a chat that has attached documents, the full document text (up to 12 000 characters) is injected as a dedicated `system` message immediately before the user's latest turn
- A mandatory directive prefix instructs the model to treat the text as directly readable content — preventing it from claiming it "cannot access files"
- Documents from different chats are never mixed; isolation is enforced at the SQL query level

### Image / Vision Support
- Images attached to a message are passed as base64-encoded `image_url` payloads inside the user message
- Compatible with vision-capable LM Studio models

---

## Native Data Visualizations

### Matplotlib Rendering
- When the model writes a `python` code block containing `matplotlib` code, the app executes it natively and renders the output as an inline PNG image directly in the chat
- A **persistent Python worker process** pre-imports `numpy`, `matplotlib`, and `scipy` once at app startup. Each chart render takes ~200ms instead of 3–4s
- Multiple charts in a single response are queued (FIFO) on the warm worker — no fallback spawns
- Each code block is monitored independently: rendering begins as soon as a block's code has been stable for 800ms, so Chart 1 can be rendering while the model is still writing Chart 2
- Rendering happens asynchronously; a spinner shows while the chart is being generated

### Dark-Theme Styling
- All charts are automatically styled to match the app's dark palette (`#0f0f0f` background, muted grid lines, red/blue/green/orange colour cycle)
- No additional styling code required in model-generated plots

### Safety Shims
The Python execution environment includes safety shims that silently correct common model code mistakes:
- **`plt.show()` / `plt.savefig()` / `plt.close()`** — replaced with no-ops; the engine captures the figure itself
- **`matplotlib.use()`** — patched to no-op; `Agg` is already set at worker startup
- **`_FlexAxes`** — out-of-bounds subplot axis access returns a hidden off-screen axis instead of `IndexError`
- **`_fix_cov()`** — 1-D covariance vectors auto-promoted to diagonal 2×2 matrices (fixes GMM / multivariate normal errors)
- **`_mvn_safe_pdf()`** — misshapen meshgrid `(d, N)` auto-transposed to `(N, d)` for `scipy.stats.multivariate_normal.pdf`
- **`_auto_norm_imshow()`** — 2D float arrays auto-normalised to `[min, max]` so feature maps don't render all-white
- **`_safe_barh()` / `_safe_bar()`** — Python list labels auto-converted to `np.array` before axis calls; prevents `TypeError: only integer scalar arrays can be converted to a scalar index`
- **`_safe_scatter()`** — mismatched `x`/`y` arrays truncated to `min(len(x), len(y))`; prevents `ValueError: x and y must be the same size`
- **`_safe_plot()`** — same truncation for two-argument `plot(x, y)` calls

### Supported Plot Types (tested)
LASSO regression paths, K-Nearest Neighbours decision boundaries, SGD convergence curves, backpropagation weight updates, Gaussian Mixture Models, 2D GMM contour plots, convolutional neural network feature maps, and general scientific plots (distributions, histograms, scatter plots, bar charts, heatmaps, time series)

### ECharts (Interactive Charts)
- JSON-based ECharts specs are rendered as interactive charts in the browser
- Automatic JSON repair for common model output mistakes (trailing commas, stray braces)
- Restricted to bar and pie chart types for reliability

---

## Chat History

- All conversations are persisted locally in **SQLite** via `better-sqlite3`
- Database lives in `app.getPath('userData')` — never inside the app bundle
- Sidebar groups chats chronologically: **Today / Yesterday / Earlier**
- Each chat stores: message content, role, timestamp, and any attachment metadata (file name, type)
- Individual chats can be deleted from the sidebar
- History survives app restarts and model reloads

---

## Settings Panel

Click ⚙️ in the sidebar to open the full-screen settings panel. Three tabs:

### Model Tab
- **Active model** — dropdown listing every model you have downloaded in LM Studio; switch at runtime
- **Context Length** — slider with preset chips: **4K / 8K / 16K / 32K / 64K / 128K**; custom values via number input
- **Reload Model** button — active only when model or context length differs from the current loaded value
- Reload runs `lms unload --all` → `lms load <model> --context-length <N>` via the `lms` CLI (120-second timeout)
- Your chosen model and context length are saved to `app-settings.json` in `app.getPath('userData')` and applied automatically on every subsequent launch

### Web Search Tab (MCP)
- Toggle to enable/disable Brave Search
- API key field (password input with show/hide toggle)
- Save button with unsaved-changes indicator and save confirmation feedback
- Live key-status dot: green = active key, amber = no key configured

### About Tab
- App version and author
- Link to the changelog

---

## Reliability & Safety

### Daemon Management
- LM Studio server is auto-launched via the `lms` CLI on app startup
- Pre-flight check: if LM Studio is already running, `lms server start` is skipped
- Exponential-backoff health polling; connection overlay only appears after **two consecutive** failures — a single timeout during GPU-intensive generation is silently absorbed

### Runaway Generation Protection
- **Server-side**: every LM Studio payload includes a `stop` sequences array (`<|im_end|>`, `<|endoftext|>`, and common loop-trigger phrases)
- **Client-side**: if the same line appears 3+ consecutive times in the SSE stream, the stream is aborted immediately

### Context Overflow Protection
- A sliding context window trims the oldest messages when the conversation history approaches the model's context limit
- Thinking blocks (`<think>...</think>`) are stripped from assistant history before re-sending to LM Studio, recovering 60–80% of the context they would otherwise occupy

---

## Web Search (Brave Search MCP)

Requires a free [Brave Search API key](https://brave.com/search/api/) configured in Settings → Web Search.

- Real-time web search via the **Brave Search API** — fetches live results for time-sensitive queries
- A **smart trigger heuristic** limits search to queries that genuinely need live data: explicit keywords (`search`, `latest`, `current`, `today`), time-sensitive domains (stock prices, weather, scores, crypto), and proper nouns paired with a recency signal. Knowledge questions, coding help, and PDF chats skip search entirely.
- **Two-step request pattern**: a lightweight non-streaming Step 1 (150 token budget, thinking disabled) detects whether the model wants to search; if so, results are injected before streaming the final answer in Step 2
- For Gemma 4, Step 1 is bypassed — the model reasons during Step 2 streaming and emits a tool call mid-stream if it decides to search, which the app intercepts and handles transparently
- Format F pipe-delimited tool calls (`<|tool_call>...<tool_call|>`) from Gemma 4 are detected and executed; the raw XML never reaches the UI
- A **raw tool call fallback parser** handles five additional formats models may emit instead of structured `tool_calls` (XML arg tags, key=value pairs, JSON objects, Qwen function tags, code fences)
- **Search notification UI**: spinner while searching, collapsible pill showing query + up to 5 source links, error card on failure
- Notifications **persist** — the "Searched the web" pill is saved to SQLite and restored when you re-open a conversation
- PDF chats never trigger web search — when a document is attached, the RAG pipeline answers the question instead

---

## UI / UX

- **Fully dark UI** — `#0f0f0f` primary background, dark red (`#8b0000` → `#dc2626`) accent
- **No white backgrounds anywhere** — every surface, modal, and overlay uses the dark palette
- Sidebar: collapsible, shows chat list grouped by date with a model badge and settings button
- Input bar: auto-expanding textarea, paperclip attachment icon, thinking/fast mode toggle, send button
- User message bubbles: red-tinted border, subtle background
- Assistant messages: full-width, left-aligned, no bubble
- Smooth **Framer Motion** animations on modals and overlays
- System font stack — no external font requests
- Thin dark webkit-styled scrollbars throughout
- **Fully offline** — no telemetry, no analytics, no external network requests (except optional DuckDuckGo search)

---

## Planned / Roadmap

Features that are designed but not yet implemented:

- [ ] Multi-document RAG (multiple PDFs in the same chat)
- [ ] Conversation export (PDF / Markdown)
- [ ] System prompt customisation UI
- [ ] Web search results with source citations
- [ ] Keyboard shortcuts (Cmd+K for new chat, etc.)

---

*Last updated: 2026-04-05 — v1.6.0*
