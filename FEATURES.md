# Desktop Intelligence — Features

A complete reference of every capability currently implemented in the app.

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
- **Thinking mode** (🧠): enables Qwen's internal chain-of-thought reasoning (`budget_tokens: 8000`). Higher quality for complex tasks — math, code review, document analysis, multi-step reasoning
- **Fast mode** (⚡): direct responses with no reasoning step. Lower latency, ideal for conversational queries and simple lookups
- Toggle is visible in the input bar; switching mid-conversation inserts a labelled divider
- Mode automatically elevates to Thinking when a PDF or image is attached
- `<think>...</think>` blocks are stripped from conversation history before re-sending to the model, reducing context usage by 60–80% in long thinking-mode sessions

### Thought Process Accordion
- The model's internal reasoning (`<think>...</think>`) is rendered in a collapsible accordion — dimmed, muted style so it doesn't dominate the UI
- Collapsed by default; click to expand

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
- When the model writes a `python` code block containing `matplotlib` code, the app executes it natively via `python3 -c` subprocess and renders the output as an inline PNG image
- Charts appear directly in the chat — no external viewer, no file exports
- Rendering happens asynchronously; a spinner shows while the chart is being generated

### Dark-Theme Styling
- All charts are automatically styled to match the app's dark palette (`#0f0f0f` background, muted grid lines, red/blue/green/orange colour cycle)
- No additional styling code required in model-generated plots

### Safety Shims
The Python execution environment includes several safety shims that silently correct common model code mistakes:
- **`plt.show()` / `plt.savefig()` / `plt.close()`** are replaced with no-ops — the engine captures the figure itself
- **`_FlexAxes`**: when subplot count is capped, out-of-bounds axis access (e.g. `axes[2]` when only 2 exist) returns a hidden off-screen axis instead of raising `IndexError`
- **`_fix_cov()`**: 1-D covariance vectors are automatically promoted to diagonal 2×2 matrices (fixes common GMM/multivariate normal errors)
- **`_mvn_safe_pdf()`**: misshapen meshgrid arrays `(d, N)` are auto-transposed to `(N, d)` for `scipy.stats.multivariate_normal.pdf`
- **`_auto_norm_imshow()`**: 2D float arrays are auto-normalised to `[min, max]` so feature maps don't render as all-white

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

## Model Settings

### Context Length Control
- Adjust the model's context window (`n_ctx`) at runtime via the settings cog (⚙️) in the bottom-left of the sidebar
- Slider with preset chips: **4K / 8K / 16K / 32K / 64K / 128K**
- Custom values accepted via number input
- "Reload Model" button is only active when the value has changed from the current loaded value

### Persistent Context Length
- Your chosen context length is saved to `app-settings.json` in `app.getPath('userData')`
- On every app launch, the daemon manager reads this file and passes `--context-length <N>` to `lms load` automatically — no manual re-configuration needed after restarts

### Reload Process
- Reload runs `lms unload --all` → waits → `lms load <model> --context-length <N>` via the `lms` CLI
- 120-second timeout with live progress shown in the modal
- After reload, `lms ps` is queried to confirm the actual loaded context length

---

## Reliability & Safety

### Daemon Management
- LM Studio server is auto-launched via the `lms` CLI on app startup
- Pre-flight check: if LM Studio is already running, `lms server start` is skipped
- Exponential-backoff health polling; connection overlay only appears after **two consecutive** failures — a single timeout during GPU-intensive generation is silently absorbed

### Runaway Generation Protection
- **Server-side**: every LM Studio payload includes a `stop` sequences array (`<|im_end|>`, `<|endoftext|>`, and Qwen loop-trigger phrases)
- **Client-side**: if the same line appears 3+ consecutive times in the SSE stream, the stream is aborted immediately

### Context Overflow Protection
- A sliding context window trims the oldest messages when the conversation history approaches the model's context limit
- Thinking blocks (`<think>...</think>`) are stripped from assistant history before re-sending to LM Studio, recovering 60–80% of the context they would otherwise occupy

---

## Web Search

- For queries that look like web searches (detected by keyword heuristics), the app performs a **DuckDuckGo** search and injects the results as a system message before calling the model
- Web search is skipped entirely when the active chat has attached documents — local RAG always takes priority

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

- [ ] KaTeX rendering for LaTeX in thinking blocks
- [ ] Multi-document RAG (multiple PDFs in the same chat)
- [ ] Conversation export (PDF / Markdown)
- [ ] System prompt customisation UI
- [ ] Model performance overlay (tokens/sec, context used %)
- [ ] Web search results with source citations
- [ ] Keyboard shortcuts (Cmd+K for new chat, etc.)
- [ ] Model switching from the settings pane (without restarting)

---

*Last updated: 2026-03-30*
