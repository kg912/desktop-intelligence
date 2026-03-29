# CLAUDE.md — Desktop Intelligence: AI Orchestration Layer
## Authoritative Project Bible & Autonomous Agent Instructions

> **READ THIS ENTIRE FILE BEFORE TOUCHING A SINGLE LINE OF CODE.**
> This is not optional. Every architectural decision, every aesthetic rule, every
> bug and its status lives here. Violating any rule here breaks the product.

---

## 0. CHANGE HISTORY LOG (MANDATORY — UPDATE ON EVERY SESSION)

This section is your persistent memory. Every time you make a meaningful change,
append a row. Never delete rows. This is how you know what has and hasn't been done.

| # | Date | File(s) Changed | What Was Done | Status |
|---|------|-----------------|---------------|--------|
| 1 | 2026-03-21 | All | Initial commit — 44 files, 15,733 lines. Full app scaffold. | ✅ Done |
| 2 | 2026-03-21 | ipc/fileProcessor.ts, rag/ingestor.ts | Fixed IPC file transfer — switched from DOM File object to ArrayBuffer + absolute path to cross Electron IPC boundary correctly | ✅ Done |
| 3 | 2026-03-21 | rag/ingestor.ts, rag/retriever.ts | Added diagnostic sentinel logs: PDF-PARSE EXTRACTED CHARACTERS, VECTORS INSERTED INTO HNSWLIB, VECTOR DB RESULTS COUNT, FINAL LM STUDIO PAYLOAD | ✅ Done |
| 4 | 2026-03-21 | main/lmsDaemonManager.ts | Fixed false-positive 180s timeout — implemented exponential backoff, non-blocking health stream, graceful auto-recovery | ✅ Done |
| 5 | 2026-03-21 | .gitignore, all source | Initialised git repo, wrote .gitignore, made first commit | ✅ Done |
| 6 | 2026-03-23 | LM Studio config | Removed Jinja template thinking suppression — thinking mode now controlled by application layer | ✅ Done |
| 7 | 2026-03-26 | src/main/services/DatabaseService.ts, RAGService.ts, FileProcessorService.ts, handlers.ts | Phase 8: Added documents.chat_id column (ALTER TABLE migration), scoped ingestDocument and retrieveContext per chatId via SQL JOIN filter, added SYSTEM DIRECTIVE prefix to RAG injection, deduped attachments in InputBar/Layout | ✅ Done |
| 8 | 2026-03-26 | src/renderer/src/hooks/useChat.ts, Layout.tsx, DatabaseService.ts, preload/index.ts, handlers.ts, MessageBubble.tsx, mocks/api.mock.ts | Phase 9: Fixed activeChatId block-scope bug (let inside bare {} → function scope), added attachments_json column to chat_messages, propagated through 8-file chain, hardcoded DEFAULT_MODEL_ID in shared/types.ts | ✅ Done |
| 9 | 2026-03-26 | src/renderer/src/store/ModelStore.tsx, TopBar.tsx, Sidebar.tsx, Layout.tsx, App.tsx, main.tsx, handlers.ts, ChatService.ts | Phase 9: Created ModelStore React Context with DEFAULT_MODEL_ID as zero-latency default; TopBar/Sidebar read from store; useChat passes model: selectedModel in payload; handlers.ts reads payload.model ?? DEFAULT_MODEL_ID | ✅ Done |
| 10 | 2026-03-26 | src/renderer/src/components/layout/Layout.tsx, hooks/useChat.ts | Phase 10: Fixed chatId race — Layout.handleSend now pre-creates chat row BEFORE processFile so documents are ingested with correct chat_id (not NULL). useChat.sendMessage accepts overrideChatId to skip duplicate creation. | ✅ Done |
| 11 | 2026-03-26 | src/main/services/FileProcessorService.ts | Phase 10 ROOT CAUSE FIX: Killed fire-and-forget ingest. ingestDocument is now awaited inside processFile. Timing measured: @xenova/transformers cold-start ≈ 1056ms — retrieveContext was running while embedding still loading → zero chunks always. | ✅ Done |
| 12 | 2026-03-26 | src/main/services/EmbeddingService.ts | Phase 10: Added full diagnostic logging to ensureReady — pipeline load time, cache dir path, failure with _initPromise reset so next call retries instead of hanging | ✅ Done |
| 13 | 2026-03-26 | package.json | Phase 10: Added @xenova/transformers and onnxruntime-web to asarUnpack — ESM package and WASM files must be on real filesystem in packaged app | ✅ Done |
| 14 | 2026-03-26 | src/main/services/FileProcessorService.ts, RAGService.ts, handlers.ts, ChatService.ts | Phase 10: Added full sentinel log chain: filePath validation + throw if empty, PDF buffer size, PDF-PARSE EXTRACTED CHARACTERS, ingest timing, VECTORS INSERTED, VECTOR DB RESULTS COUNT + preview, RAG INJECTING log, FINAL LM STUDIO PAYLOAD | ✅ Done |
| 15 | 2026-03-26 | src/main/services/ChatService.ts | P0 runaway loop fix: added STOP_SEQUENCES array to every LM Studio payload (server-side guard); added client-side repetition detector in SSE loop — if same line appears 3+ consecutive times the stream is aborted. Both layers are required: stop sequences fire first at LM Studio, detector catches any that slip through. | ✅ Done |
| 16 | 2026-03-26 | src/main/services/RAGService.ts, DatabaseService.ts | P0 RAG complete rewrite — hnswlib-node was silently broken: dynamic import() of CJS native module returns undefined for all named exports (HierarchicalNSW was undefined every call, zero vectors ever stored). Replaced entire embedding+vector pipeline with direct SQLite full-text storage. ingestDocument now INSERTs rawText into documents.content. retrieveContext SELECTs all docs for chatId, concatenates up to 12000 chars, returns formatted context block. No more @xenova/transformers, no more hnswlib-node in the RAG path. | ✅ Done |
| 16 | 2026-03-26 | src/shared/types.ts, ModelStore.tsx, ChatService.ts, MessageBubble.tsx, useChat.ts, InputBar.tsx, Layout.tsx | Phase 12: Implemented Thinking/Fast mode toggle. ThinkingMode type in shared/types added to ChatSendPayload. ModelStore holds thinkingMode state (default 'fast'). ChatService sends thinking:{type,budget_tokens} field to LM Studio. Message.role now accepts 'divider' for mode-switch label; filtered from wire before LM Studio. InputBar shows Brain/Zap toggle button. Layout auto-switches to thinking on file attach. useChat inserts divider message on mode change mid-conversation. | ✅ Done |
| 18 | 2026-03-26 | src/main/services/FileProcessorService.ts, ChatService.ts | P0 RAG fix: inject field was placeholder text "stored in vector database" — model never saw document content. Fixed: inject now contains actual extracted text (up to 12 000 chars). Also fixed fast mode reasoning: added /no_think or /think soft-prompt prefix on the last user message after buildMessages() — reliable across all LM Studio/MLX builds, safe with vision inputs. | ✅ Done |
| 19 | 2026-03-26 | src/main/managers/ModelConnectionManager.ts | P1 FIX: False-positive offline overlay during PDF generation. Root cause: single health-check timeout (5s) while GPU pegged → immediate 'offline' transition. Fix: (1) added FAILURES_BEFORE_OFFLINE=2 consecutive-failure threshold — a single blip never shows the overlay; (2) health-check timeout 5s→8s so a busy-but-alive LM Studio instance has time to respond; (3) forcePoll() resets consecutiveFailures so manual Retry always gets a clean slate. | ✅ Done |
| 20 | 2026-03-26 | src/main/services/ChatService.ts, src/main/services/FileProcessorService.ts, vitest.config.ts, package.json, src/main/services/__tests__/* | P1 TEST SUITE: 64 unit tests across RAGService, FileProcessorService, ChatService. Critical regression guards: inject field never placeholder text; chatId isolation; truncation at 12 000 chars; STOP_SEQUENCES integrity; applyThinkingPrefix correctness (extracted as exported pure function). better-sqlite3 ABI rebuild handled in test script. | ✅ Done |
| 21 | 2026-03-26 | src/renderer/src/lib/markdownUtils.ts (new), src/renderer/src/lib/__tests__/markdownUtils.test.ts (new), src/renderer/src/components/chat/MarkdownRenderer.tsx, src/renderer/src/styles/globals.css, vitest.config.ts, package.json | Mermaid diagram rendering: extracted parseThinkBlocks + new classifyCodeBlock + isValidMermaidSyntax into markdownUtils.ts (59 unit tests). Installed mermaid@11. Added MermaidBlock component with dark-palette themeVariables, lazy async load (import() only on first diagram), isStreaming guard (placeholder while model generates), error fallback to text display. CodeBlock now routes mermaid language to MermaidBlock vs hljs. buildComponents() factory passes isStreaming to CodeBlock. CSS overrides in globals.css force transparent SVG backgrounds. 123 tests passing. | ✅ Done |
| 22 | 2026-03-26 | src/renderer/src/lib/markdownUtils.ts, src/renderer/src/lib/__tests__/markdownUtils.test.ts | REGRESSION FIX: parseThinkBlocks used non-greedy regex ([\s\S]*?) which matched the FIRST </think>. Qwen models mention </think> inside their own thought while reasoning about formatting, causing thought content to leak into the answer area and the real </think> to appear as literal rendered text. Fix: switched to lastIndexOf('</think>') — always splits at the LAST closing tag. Added 3 regression tests that fail on the old code. | ✅ Done |
| 23 | 2026-03-26 | src/main/services/SystemPromptService.ts (new), src/main/services/__tests__/SystemPromptService.test.ts (new), src/main/ipc/handlers.ts | ASCII diagram fix: Created BASE_SYSTEM_PROMPT constant that tells the model about Mermaid SVG rendering and KaTeX math. Always prepended as the first system message in handlers.ts. 11 unit tests guard the prompt content (must contain mermaid, ```mermaid syntax, flowchart, sequenceDiagram, pie, LaTeX hints, SVG mention; must NOT suggest ASCII art as fallback; must fit in 512-token budget). 137 tests passing total. | ✅ Done |
| 24 | 2026-03-26 | src/renderer/src/components/chat/MarkdownRenderer.tsx | MERMAID RENDERING FIX: Switched from dynamic import('mermaid') to static `import mermaid from 'mermaid'`. Changed securityLevel from 'antiscript' to 'loose' — 'antiscript' pipes SVG through DOMPurify which strips xmlns attrs in Electron's renderer; 'loose' injects SVG via innerHTML directly. Moved mermaid.initialize() to module level (eliminated ensureMermaid() lazy-init). Replaced unstable Date.now()+random ID with module-level counter (_mermaidIdCounter). Removed unused `inline` parameter from CodeBlock destructuring. 137/137 tests passing. | ✅ Done |
| 17 | TBD | src/renderer/src/components/ErrorBanner.tsx (or equivalent) | **P1 OPEN:** Stale daemon error banner — never clears after daemon recovers. FIX: dispatch clear-error on first successful health check | 🟡 OPEN |
| 25 | 2026-03-27 | package.json, package-lock.json, src/renderer/index.html, src/renderer/src/components/layout/ChatArea.tsx, src/renderer/src/components/ConnectionStatus.tsx, src/main/services/SystemPromptService.ts, src/main/services/DatabaseService.ts, src/renderer/src/main.tsx, README.md, CLAUDE.md | Full rebrand: "Qwen Studio" → "Desktop Intelligence" across all files. DB filename qwen-studio.db → desktop-intelligence.db. Tagline updated to "Local Inference. Zero Latency." Demo globals renamed __qwenDemo → __desktopIntelligenceDemo. | ✅ Done |
| 26 | 2026-03-27 | src/main/managers/ModelConnectionManager.ts, src/main/ipc/handlers.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx, src/renderer/src/components/layout/ChatArea.tsx, package.json, .gitignore | Simplify pass + security audit: (1) ModelConnectionManager.transitionTo() now skips emit when status/model/error unchanged — stops 4+ no-op IPC pushes/min in steady state; (2) MarkdownRenderer: parseThinkBlocks memoized with useMemo([content]) — was called 10–50x/sec during streaming; (3) ChatArea.handleScroll short-circuits when already at bottom; (4) handlers.ts: replaced 3 dynamic await import() calls with static top-level imports; (5) DiagramCard component extracted to remove ~30 lines of duplicate JSX; (6) CopyButton: consolidated duplicate setCopied+setTimeout into markCopied helper; (7) package.json appId fixed com.local.qwenstudio → com.local.desktopintelligence; (8) .gitignore: added .claude/ entry. 141/141 tests passing. New DMG built: Desktop Intelligence-1.0.0-arm64.dmg | ✅ Done |
| 27 | 2026-03-28 | src/main/services/SystemPromptService.ts, src/main/ipc/handlers.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx, src/renderer/src/lib/markdownUtils.ts, src/renderer/src/mocks/api.mock.ts, src/shared/types.ts, src/preload/index.ts, scripts/test-prompts.py | matplotlib native renderer + visualization quality pass: (1) Added python:render IPC channel — spawns python3, wraps model code with dark-theme rcParams preamble + base64 epilogue, returns PNG. (2) MatplotlibBlock React component — shows spinner, renders img tag on success, error fallback. (3) scipy pre-imported in PREAMBLE alongside numpy/matplotlib. (4) SystemPromptService rewritten: matplotlib PREFERRED for distributions/GMMs/curves, explicit decision guide, stronger "no formatter" and Mermaid colour rules. (5) sanitizeFormatters updated: now allows multi-token ECharts label templates ({c}\n{b}, {b}: {c}) while still stripping function strings and arbitrary text. (6) Pipeline order fix: sanitizeFormatters runs BEFORE fixYearAxes so model-added bad formatters are stripped before fixYearAxes decides whether to inject {value}. (7) History trimming in ChatService: HISTORY_WINDOW=20 prevents context overflow with large base64 images. (8) Empty-response guard in ChatService: if stream produces 0 tokens, emits CHAT_ERROR with human-readable message. (9) Live test suite (scripts/test-prompts.py): 9/9 passing. 155/155 unit tests passing. | ✅ Done |
| 28 | 2026-03-29 | src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx, scripts/test-prompts.py | matplotlib UX + robustness fixes: (1) PREAMBLE safety shims — plt.show/savefig/close replaced with no-ops, engine epilogue uses _real_savefig/_real_close; suptitle(pad=) monkey-patched to strip invalid kwarg. (2) MatplotlibBlock: removed isStreaming block — 400ms debounce during streaming means chart renders 400ms after code block closes, not waiting for full response. (3) System prompt: banned sklearn/pandas/seaborn, restricted subplots to 1×2 max, added np.arange() guidance, added numbered-list rule. (4) figure.figsize raised to (10,6). 9/9 live tests. 155/155 unit tests. New DMG built. | ✅ Done |
| 29 | 2026-03-29 | src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts, scripts/test-prompts.py | Visualization quality pass 2: (1) PREAMBLE: plt.subplots() capped at 2 columns with proportional figsize rescaling. (2) PREAMBLE: Axes.imshow auto-normalises 2D float arrays to actual [min,max] range — prevents all-white washed-out feature map charts. (3) System prompt: Historical timelines → matplotlib (barh with event labels) instead of ECharts. Decision guide default is now matplotlib. ECharts only for numeric comparisons/pie. 9/9 live tests. 155/155 unit tests. New DMG built. | ✅ Done |
| 30 | 2026-03-29 | src/renderer/src/components/chat/MarkdownRenderer.tsx | MatplotlibBlock UX fixes: (1) Spinner shown immediately when code block appears (isWaiting state: code present, not yet running, no image, no error) — label "Rendering…" vs "Running Python…" once subprocess starts. (2) Error display condensed: shows only last non-empty error line instead of full traceback; raw code wrapped in collapsible <details> element so error cards are no longer overwhelming. | ✅ Done |
| 31 | 2026-03-29 | src/renderer/src/components/chat/MarkdownRenderer.tsx, src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | Stability pass for GitHub: (1) Spinner now shows from the moment model starts writing a matplotlib block (condition uses isStreaming || Boolean(code)) — eliminates blank PLOT card body during streaming. (2) Subplot cap raised 2→3 columns (original problem was 4-col grids; capping at 2 broke axes[2] IndexError). (3) PREAMBLE: added scipy.stats.multivariate_normal.pdf auto-transpose shim — auto-corrects (d,N) → (N,d) when model passes wrong-shaped meshgrid. (4) System prompt: corrected subplot limit to 3, added "2D Gaussian/GMM grids: pos = np.column_stack([X.ravel(), Y.ravel()])" guidance. 155/155 unit tests passing. New DMG built. | ✅ Done |
| 35 | 2026-03-29 | src/renderer/src/components/settings/SettingsModal.tsx (new), src/renderer/src/components/layout/Sidebar.tsx, Layout.tsx, src/main/ipc/handlers.ts, src/preload/index.ts, src/shared/types.ts | Settings modal: cog wheel in sidebar bottom-left opens a full-screen modal (same aesthetic as ConnectionStatus). Shows active model name (read-only) + context length slider/number/presets. Reload button only active when value differs from fetched config. Calls LM Studio /api/v0/models/unload then /load with new contextLength. Overlay blocks rest of app while open. Modal built modular for future model-switching. New IPC channels: settings:getModelConfig, settings:reloadModel. 155/155 tests. DMG built. | ✅ Done |
| 38 | 2026-03-30 | src/main/ipc/handlers.ts | Settings getModelConfig regression fix: (1) Removed parseLmsPs pattern 3 (/(\d{4,6})\s*(?:tokens?|ctx)/i) — was matching token-usage counts like "4096 ctx used" and returning 4096 instead of the real n_ctx. (2) Rewrote SETTINGS_GET_MODEL priority: SettingsStore (written on reload) is now source-of-truth → lms ps (first launch only) → REST API → 32768 default. This eliminates all lms ps parsing ambiguity once the user has set a preference. | ✅ Done |
| 39 | 2026-03-30 | src/shared/types.ts, src/main/services/SettingsStore.ts, src/main/index.ts, src/main/ipc/handlers.ts, src/preload/index.ts, src/renderer/src/App.tsx, src/renderer/src/store/ModelStore.tsx, src/renderer/src/components/settings/FirstLaunchModal.tsx (new), src/renderer/src/components/settings/SettingsModal.tsx | Model selector + first-launch onboarding: (1) Added AvailableModel and AppInitPayload types + 3 IPC channels (APP_IS_FIRST_LAUNCH, SETTINGS_GET_AVAILABLE_MODELS, APP_INITIALIZE) to shared/types.ts. (2) SettingsStore: added modelId? to AppSettings. (3) index.ts: reads saved modelId on startup — if present loads it, if absent starts server only (first-launch path). (4) handlers.ts: added APP_IS_FIRST_LAUNCH (checks modelId in settings), SETTINGS_GET_AVAILABLE_MODELS (fetches /api/v0/models, maps to AvailableModel[]), APP_INITIALIZE (saves model+ctx, runs lms load); SETTINGS_RELOAD now also writes modelId to SettingsStore. (5) preload: exposed isFirstLaunch(), getAvailableModels(), initializeApp(). (6) ModelStore: removed DEFAULT_MODEL_ID default — selectedModel starts empty, populated by App.tsx after IPC. (7) App.tsx: rewritten to check isFirstLaunch on mount; first launch shows FirstLaunchModal (no ConnectionStatus overlay); returning user restores modelId from getModelConfig then shows normal overlay. (8) FirstLaunchModal: full-screen dark-red welcome modal with model dropdown + context length slider/presets — calls initializeApp, fires onComplete(modelId) on success. (9) SettingsModal: added model selector dropdown (getAvailableModels); draftModel state tracks selected model; Reload button activates when model OR context changes; setSelectedModel called on success. | ✅ Done |
| 37 | 2026-03-29 | src/main/services/SettingsStore.ts (new), src/main/managers/LMSDaemonManager.ts, src/main/ipc/handlers.ts | Context length persistence: created SettingsStore.ts (read/write app-settings.json in app.getPath('userData')). SETTINGS_RELOAD now calls writeSettings({contextLength}) after a successful reload. LMSDaemonManager.runLoadModel() reads saved contextLength and passes --context-length to `lms load` at every startup — chosen context now survives app restarts. | ✅ Done |
| 36 | 2026-03-29 | src/main/ipc/handlers.ts | Settings modal RELOAD FIX: Replaced broken /api/v0/models/load + /api/v0/models/unload REST calls (returned {"error":"Unexpected endpoint or method."}) with lms CLI commands. Added 3 module-level helpers: findLmsBinAsync() (same binary discovery as LMSDaemonManager), runLmsArgs() (Promise-wrapped spawn, non-blocking), parseLmsPs() (flexible regex: context/n_ctx/token count/table cell patterns). SETTINGS_GET_MODEL now runs `lms ps` first, falls back to REST API with case-insensitive isTarget() and state="loaded" preference. SETTINGS_RELOAD runs `lms unload --all` → `lms load <id> --context-length <N>` (120s timeout) → `lms ps` to confirm. extractModelConfig() fallback no longer uses max_context_length (that is the model's capacity, not n_ctx). | ✅ Done |
| 34 | 2026-03-29 | src/main/services/ChatService.ts, src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | Think-block stripping + CNN subplot fix: (1) stripThinkBlocks() strips <think>…</think> from assistant history before sending to LM Studio — reduces context usage by 60-80% in thinking-mode conversations. Uses lastIndexOf for closing tag. (2) _FlexAxes now only applied when orig_ncols > ncols (actual capping occurred) — fixes CNN axes.flatten() AttributeError on plt.subplots(2,2). (3) System prompt trimmed to fit 3000-char limit. 155/155 tests. New DMG built. | ✅ Done |
| 33 | 2026-03-29 | src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | GMM covariance fix: added _fix_cov() helper that auto-converts 1-D cov vectors [sx,sy] into diagonal matrices np.diag([|sx|,|sy|]). Patched both scipy.stats.multivariate_normal.pdf and np.random.multivariate_normal. Also fixed _FlexAxes regression: wrapper now only applied when ncols>1 — single-subplot plt.subplots(figsize=...) was being wrapped causing AttributeError on ax.contourf(). System prompt: added "GMM covariances MUST be 2×2 matrices" rule. 155/155 unit tests. New DMG built. | ✅ Done |
| 32 | 2026-03-29 | src/renderer/src/components/chat/MarkdownRenderer.tsx, src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | Three-way stability fix: (1) ECharts JSON repair — repairEChartsJson() strips trailing commas and stray { before key-value pairs before second JSON.parse attempt; recovers common model JSON mistakes silently. (2) _FlexAxes PREAMBLE class — axes list subclass returns hidden off-screen axes for out-of-bounds index access (axes[2] when cap=2) instead of IndexError; tuple unpacking (ax1, ax2 = axes) still works because list has real count. Reverted cap back to 2. (3) System prompt: banned ECharts scatter/line types — bar and pie only; added scatter/decision boundaries to matplotlib PREFERRED list. (4) REGRESSION FIX: _FlexAxes only applied when ncols>1 — single-subplot calls (plt.subplots(figsize=...)) were being wrapped in _FlexAxes causing AttributeError on every axes method call. 155/155 unit tests. New DMG built. | ✅ Done |

**INSTRUCTIONS FOR UPDATING THIS LOG:**
- Before starting work each session, read every row.
- After completing any fix or feature, add a new row immediately.
- Use status: ✅ Done / 🔴 OPEN / 🟡 Minor / 🚧 In Progress
- If you abandon an approach, add a row marked ❌ Abandoned with the reason.
- Never summarise — be specific about which files and what changed.

---

## 1. HARDWARE & PERFORMANCE BASELINE

**Target Machine:**
- Apple MacBook Pro 14-inch, M5 Pro
- 18-core CPU, 20-core GPU, 64GB Unified Memory, 1TB Storage

**Target Model:**
- `mlx-community/Qwen3.5-35B-A3B-6bit` via LM Studio / MLX
- Sustained performance: ~71 tokens/second
- This is a **reasoning/thinking model** — it supports both thinking and fast modes

**Performance Mandates:**
- Zero-latency UX. Never block the main thread.
- Strict memory management — no memory leaks in streaming handlers.
- All heavy operations (PDF parsing, embedding, vector search) run in background workers or async queues, never on the IPC main thread.
- Stream processing must forward tokens to renderer as they arrive — no buffering entire response before display.

---

## 2. TECH STACK (FROZEN — DO NOT CHANGE WITHOUT EXPLICIT USER INSTRUCTION)

### Frontend (Renderer Process)
- **Framework:** React 18 + Vite + TypeScript (strict mode)
- **Styling:** Tailwind CSS v3 + shadcn/ui components
- **Markdown:** react-markdown + remark-gfm (tables MUST render correctly)
- **State:** Global React state via ModelStore (Zustand or Context — check existing impl)
- **No additional UI libraries without user approval**

### Backend (Electron Main Process)
- **Runtime:** Node.js via Electron main process
- **IPC:** Strict typed IPC channels — no `ipcRenderer.send` without a corresponding typed handler
- **Process management:** Node.js `child_process` for LMS daemon

### Native Modules (CRITICAL — handle with care)
- **`better-sqlite3`** — chat history persistence
- **`hnswlib-node`** — vector store for RAG
- Both are native modules. They MUST be in `asarUnpack` in electron-builder config.
- NEVER move these to dependencies that get bundled into the asar archive.
- After any `npm install`, always run `electron-builder install-app-deps`.

### AI / ML Tools
- **`@xenova/transformers`** — local embeddings using `all-MiniLM-L6-v2`
- **`pdf-parse`** — PDF text extraction
- **`duckduckgo-search`** — web search tool
- Embeddings run in a separate worker thread — never block IPC with embedding generation.

### Packaging
- **`electron-builder`** — target: `--mac --arm64`
- Always test the packaged `.dmg` — behaviour in dev vs packaged differs significantly for native modules and file paths.

---

## 3. UI/UX AESTHETIC (STRICTLY ENFORCED — NON-NEGOTIABLE)

### Colour Palette
```
Background primary:   #0f0f0f
Background secondary: #121212
Background elevated:  #1a1a1a
Border subtle:        #2a2a2a
Border strong:        #3a3a3a

Accent primary:       #8b0000  (dark red)
Accent hover:         #b91c1c
Accent active:        #dc2626
Accent glow:          rgba(220, 38, 38, 0.15)

Text primary:         #f5f5f5
Text secondary:       #a3a3a3
Text muted:           #525252
```

### Layout
- **Gemini/ChatGPT clone layout:**
  - Left sidebar: collapsible, shows chat history grouped by TODAY / YESTERDAY / EARLIER
  - Central area: wide chat panel, messages top-to-bottom
  - Bottom: sticky input bar with auto-expanding textarea
  - Input bar contains: paperclip attachment icon (left), textarea (centre), send button (right)
- **User message bubbles:** `bg-red-950/30` with red-tinted border
- **Assistant messages:** no bubble, left-aligned, full width
- **Thinking accordion:** muted/collapsed by default, expandable — shows `<think>` content in a dimmed style

### Component Rules
- All buttons use the dark red accent on hover/active states
- Glowing UI states use `box-shadow: 0 0 12px rgba(220, 38, 38, 0.3)`
- No white backgrounds anywhere. Ever.
- Scrollbars: thin, dark, webkit-styled
- Fonts: system font stack, no external font imports (performance)
- Icons: lucide-react only

---

## 4. ARCHITECTURE: DATA FLOW (READ CAREFULLY)

### 4.1 Chat Message Flow
```
User types message + optional attachments
        ↓
[Renderer] Validate, build payload, call ipcRenderer.invoke('chat:send', payload)
        ↓
[Main IPC Handler] Receives payload
        ↓
[FileProcessor] If attachments exist:
  - Read file as Buffer (NOT DOM File object)
  - For PDF: run pdf-parse → extract text → chunk → embed → insert into hnswlib
  - For images: pass as base64 to vision payload
        ↓
[RAG Retriever] Vector search hnswlib with user query
  - Returns top-k chunks with similarity scores
  - MUST inject these chunks into system prompt BEFORE calling LM Studio
        ↓
[LM Studio API Call] POST /v1/chat/completions
  - Messages array: [system (with RAG context), ...history, user message]
  - Stream: true
        ↓
[Stream Handler] Process SSE stream token by token
  - Detect and buffer <think> blocks
  - Forward non-think tokens to renderer immediately
  - Repetition detection safety net
        ↓
[Renderer] Display streamed tokens, render markdown, handle think accordion
```

### 4.2 IPC File Transfer Rule (CRITICAL)
**The DOM `File` object CANNOT cross the IPC boundary.** It arrives empty in the main process.

**Correct approach:**
```typescript
// RENDERER — convert before sending
const buffer = await file.arrayBuffer();
const payload = {
  fileName: file.name,
  fileType: file.type,
  fileBuffer: buffer,  // ArrayBuffer serialises correctly over IPC
  // OR: filePath if using dialog.showOpenDialog
};
```

**Never do this:**
```typescript
// WRONG — File object is not serialisable over IPC
ipcRenderer.invoke('chat:send', { file: fileObject });
```

### 4.3 RAG Injection Rule (CRITICAL — CURRENTLY BROKEN)
Retrieved chunks MUST be in the messages array before the fetch call:

```typescript
// CORRECT pattern
const ragChunks = await vectorSearch(query, chatId);
const ragContext = ragChunks.map(c => c.text).join('\n\n---\n\n');

const systemPrompt = `You are Desktop Intelligence assistant.
${ragContext.length > 0 ? `\n\nRELEVANT DOCUMENT CONTEXT:\n${ragContext}` : ''}`;

const messages = [
  { role: 'system', content: systemPrompt },
  ...chatHistory,
  { role: 'user', content: userMessage }
];

// THEN call LM Studio
fetch('http://localhost:1234/v1/chat/completions', {
  body: JSON.stringify({ messages, stream: true, ...options })
});
```

---

## 5. THINKING MODE (NEW FEATURE — IMPLEMENT THIS)

Qwen3.5 supports two modes. The app MUST support toggling between them.

### 5.1 Thinking Mode (Deep / Slow)
- Model reasons step by step before answering
- Higher quality for complex tasks: math, code, analysis, PDFs
- Controlled via API: include `"thinking": {"type": "enabled", "budget_tokens": 8000}` in payload
- OR via chat template token: `/think` prefix in user message for some MLX builds
- The `<think>...</think>` block is rendered as a collapsible accordion in the UI
- UI indicator: 🧠 icon or "Thinking" badge on the model selector

### 5.2 Fast Mode (Quick / No Thinking)
- Direct response, no reasoning chain
- Lower latency, good for simple queries, casual chat
- Controlled via API: include `"thinking": {"type": "disabled"}` OR `budget_tokens: 0`
- OR send `/no_think` prefix for MLX builds
- DO NOT use Jinja template suppression — it causes broken state with vision inputs
- UI indicator: ⚡ icon or "Fast" badge

### 5.3 UI Toggle Implementation
- Add a toggle in the input bar area (near the model selector at bottom)
- Default: Fast mode for general chat, auto-switch to Thinking for PDF/image queries
- Persist preference per-session in React state (ModelStore)
- When switching modes mid-conversation, add a subtle divider in chat: "— Switched to Thinking Mode —"

### 5.4 Stop Sequences (ALWAYS include these)
```typescript
const stopSequences = [
  "<|im_end|>",
  "<|endoftext|>",
  "Final Answer: Your final answer here",  // Qwen runaway loop prevention
  "Your final answer here"
];
```

---

## 6. KNOWN BUGS & REQUIRED FIXES (PRIORITY ORDER)

### 🔴 P0 — RAG Context Not Injected
**Symptom:** Model only sees filename, hallucinates document content. Qwen's own reasoning confirms: "I cannot see document content, only the filename."
**Root cause:** RAG chunks are retrieved from hnswlib but never concatenated into the system prompt before the LM Studio fetch call.
**Fix location:** `rag/retriever.ts` + wherever the messages array is assembled for the LM Studio API call.
**Acceptance criteria:** Ask "what is in this PDF?" → model answers with actual content from the document, not hallucinated content from the filename.

### 🔴 P0 — Runaway Generation Loop
**Symptom:** After 5-8 messages (especially with image/vision input), model loops infinitely outputting "I hope this helps! Final Answer: Your final answer here"
**Root cause:** Thinking suppression via Jinja left model in broken state. Thinking block never properly closed → model emits the post-thinking response skeleton repeatedly.
**Fix:** 
1. Stop sequences array (see Section 5.4)
2. Stream repetition detector: if identical line appears 3+ consecutive times, abort stream
3. Switch thinking control to API payload (see Section 5.2), remove all Jinja template hacks
**Acceptance criteria:** Send 20 messages including images → no loops, clean stop every time.

### 🟡 P1 — Stale Error Banner
**Symptom:** "LMS Daemon error — lms load timed out after 180s" banner persists even when model is responding correctly.
**Root cause:** UI error state is set on timeout but never cleared when health check subsequently succeeds.
**Fix:** In the daemon health check handler, dispatch a "clear error" action on first successful ping after an error state.
**Acceptance criteria:** Banner disappears within 5 seconds of model becoming responsive.

### 🟡 P1 — Tool Routing Confusion
**Symptom:** Asking "What is this file about?" triggers Web Search tool instead of RAG retrieval.
**Root cause:** Tool router has no documents in vector DB (because of P0 bug above), falls through to web search as default.
**Fix:** After fixing P0, add explicit routing rule: if active chat has associated documents, always prioritise RAG retrieval over web search for document-related queries. Keyword triggers: "this file", "this document", "this PDF", "what does it say", "according to".

---

## 7. FEATURE ROADMAP (DO NOT IMPLEMENT UNLESS USER EXPLICITLY ASKS)

These are known desired features. Do not spontaneously implement them. Wait for instruction.

- [ ] MathJax / KaTeX rendering for LaTeX expressions in responses
- [ ] Image generation tool integration
- [ ] Multi-document RAG (multiple PDFs in same chat session)
- [ ] Conversation export (PDF / markdown)
- [ ] Prompt templates / system prompt customisation UI
- [ ] Model performance stats overlay (tokens/sec, context length used)
- [ ] Web search results rendering with source citations
- [ ] Keyboard shortcuts (Cmd+K for new chat, etc.)

---

## 8. FILE STRUCTURE (REFERENCE)

```
desktop-intelligence/
├── electron/
│   ├── main/
│   │   ├── index.ts              — App entry, window creation
│   │   ├── ipc/
│   │   │   ├── chatHandler.ts    — Main chat IPC handler, assembles messages array
│   │   │   ├── fileProcessor.ts  — Receives file buffers, routes to PDF/image handlers
│   │   │   └── toolRouter.ts     — Decides: RAG vs web search vs direct answer
│   │   ├── rag/
│   │   │   ├── ingestor.ts       — pdf-parse → chunking → @xenova embeddings → hnswlib insert
│   │   │   ├── retriever.ts      — Query hnswlib, return top-k chunks
│   │   │   └── vectorStore.ts    — hnswlib-node initialisation and management
│   │   ├── lmsDaemonManager.ts   — Spawns/monitors lms CLI, health check with backoff
│   │   └── db/
│   │       └── database.ts       — better-sqlite3 schema and queries
├── src/
│   ├── components/
│   │   ├── Layout.tsx            — Main layout, sidebar + chat area
│   │   ├── ChatArea.tsx          — Message list, auto-scroll
│   │   ├── MessageBubble.tsx     — User/assistant message rendering
│   │   ├── ThinkAccordion.tsx    — Collapsible <think> block renderer
│   │   ├── InputBar.tsx          — Sticky bottom input with attachment + send
│   │   ├── Sidebar.tsx           — Chat history, grouped by date
│   │   └── ErrorBanner.tsx       — Daemon error state display
│   ├── stores/
│   │   └── ModelStore.ts         — Global: active model, thinking mode, chat state
│   └── hooks/
│       └── useChat.ts            — Chat send logic, streaming handler
├── electron-builder.config.js    — Build config with asarUnpack for native modules
└── CLAUDE.md                     — THIS FILE
```

---

## 9. ELECTRON PACKAGING RULES (NON-NEGOTIABLE)

```javascript
// electron-builder.config.js — must include these
{
  asarUnpack: [
    "node_modules/better-sqlite3/**",
    "node_modules/hnswlib-node/**",
    "@xenova/transformers/dist/**"
  ],
  afterPack: "scripts/install-native-deps.js"
}
```

- After ANY `npm install` of a native module: run `electron-builder install-app-deps`
- Test native module loading in the packaged app, not just dev mode
- Use `app.getPath('userData')` for the hnswlib index file path in production — never `__dirname` relative paths, they break in packaged apps
- SQLite database also lives in `app.getPath('userData')`
- Log file path for packaged app: `app.getPath('logs')`

---

## 10. DIAGNOSTIC LOGGING (KEEP THESE FOREVER)

These sentinel logs must remain in the codebase permanently. They are the only way to debug the packaged app since Electron swallows stdout.

```
[FileProcessor] 📄 Received: filePath="..." fileName="..." 
[FileProcessor] 📦 PDF buffer read: N bytes
📄 PDF-PARSE EXTRACTED CHARACTERS: N
[RAG] 🧠 ingestDocument: fileName="..." chatId=<uuid> rawTextLen=N
[RAG] 🍖 Chunks created: N for "fileName"
💾 VECTORS INSERTED INTO HNSWLIB: N (fileName="..." chatId=<uuid>)
[Routing] chatId=<uuid> hasDocuments=true/false (N doc(s))
🔥 VECTOR DB RESULTS COUNT: N (chatId=<uuid>, candidates=N, sqlRows=N)
🔥 VECTOR DB RESULTS (first chunk preview): <first 200 chars>
[RAG] INJECTING RAG CONTEXT ...
🚀 FINAL LM STUDIO PAYLOAD: <full JSON>
```

To view these logs from the packaged `.dmg`, launch from Terminal:
```bash
/Applications/"Desktop Intelligence.app"/Contents/MacOS/"Desktop Intelligence"
```

---

## 11. LM STUDIO API CONTRACT

**Base URL:** `http://localhost:1234`
**Endpoint:** `POST /v1/chat/completions`

```typescript
interface LMStudioPayload {
  model: string;              // From ModelStore — e.g. "mlx-community/Qwen3.5-35B-A3B-6bit"
  messages: Message[];        // [system, ...history, user] — RAG context in system
  stream: true;
  temperature: number;        // 0.7 default, lower for factual/RAG queries
  max_tokens: number;         // 4096 default
  stop: string[];             // ALWAYS include stop sequences from Section 5.4
  thinking?: {                // Thinking mode control
    type: "enabled" | "disabled";
    budget_tokens?: number;   // e.g. 8000 for deep thinking
  };
}
```

**Never hardcode the model string.** Always read from `ModelStore.activeModel`.

---

## 12. WORKING PRINCIPLES FOR CLAUDE CODE

1. **Read before you write.** Before editing any file, read it fully. State what you found.

2. **Trace the full data flow.** For any bug, trace from the source event (user clicks send) to the final output (LM Studio receives payload). The bug lives somewhere in that chain.

3. **Fix one thing at a time.** Don't refactor while fixing bugs. Don't add features while fixing bugs.

4. **Show before applying.** For any fix, show the before/after diff and state your reasoning. Apply only after confirming the logic is sound.

5. **Update the change log.** After every fix, add a row to Section 0. This is mandatory.

6. **Test the packaged app.** Dev mode behaviour is unreliable for native modules and IPC. Always validate that fixes work in the built `.dmg`.

7. **Never assume something works.** The previous sessions assumed the RAG pipeline worked because the code looked correct. It didn't. Always verify with actual output.

8. **Preserve the aesthetic.** No white backgrounds. No light mode. No UI regressions. Every new component must follow Section 3.

9. **Respect the frozen stack.** Do not introduce new dependencies without flagging it and getting user approval. The stack is frozen.

10. **When in doubt, ask.** A 30-second clarification is better than 30 minutes of wrong work.

---

## 13. CURRENT SESSION OBJECTIVES (UPDATE AS COMPLETED)

**Session started:** 2026-03-26

**Priority order:**

- [x] **P0:** Fix RAG injection — root causes: fire-and-forget ingest (timing race), chatId = NULL on first message, @xenova/transformers missing from asarUnpack. All three fixed. Sentinel logs added throughout entire pipeline.
- [x] **P0:** Fix runaway loop — stop sequences added to every LM Studio payload; client-side repetition detector aborts stream on 3 consecutive identical lines.
- [ ] **P1:** Implement Thinking vs Fast mode toggle in UI (Section 5)
- [ ] **P1:** Clear stale error banner after daemon recovery
- [ ] **P1:** Fix tool routing — documents present → always try RAG first

**Do not start the next item until the current one is verified working.**

---

*Last updated: 2026-03-27 | Version: 1.2 | Maintained by: Claude Code (update this on every session)*