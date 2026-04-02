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
| 40 | 2026-03-30 | src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx | matplotlib reliability pass: (1) MatplotlibBlock: removed 400ms streaming debounce — no execution while isStreaming=true; execute with 200ms settle delay after streaming ends, preventing false error states on incomplete code. (2) PREAMBLE: added banned import guard (_guarded_import overrides __builtins__.__import__) — sklearn/pandas/seaborn/torch/tensorflow/keras now raise clear ImportError instead of ModuleNotFoundError. (3) PREAMBLE: matplotlib.use() monkey-patched to no-op — prevents crash if model writes matplotlib.use('Agg') after preamble already set it. (4) PREAMBLE: subplot cap raised 2→3 columns. (5) extractPythonError(): new helper maps Python traceback line numbers back to user code (PREAMBLE lines computed dynamically), returns "Line N: <offending line>\n<error>" — concise, actionable. (6) MatplotlibBlock error display: shows up to 3 lines (was: last line only). (7) SystemPromptService: rewrote matplotlib section — structured rules format, removed 35-line cap → 50-line cap, clarified 2D Gaussian covariance syntax, removed prose ambiguity. 155/155 tests. New DMG built. | ✅ Done |
| 34 | 2026-03-29 | src/main/services/ChatService.ts, src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | Think-block stripping + CNN subplot fix: (1) stripThinkBlocks() strips <think>…</think> from assistant history before sending to LM Studio — reduces context usage by 60-80% in thinking-mode conversations. Uses lastIndexOf for closing tag. (2) _FlexAxes now only applied when orig_ncols > ncols (actual capping occurred) — fixes CNN axes.flatten() AttributeError on plt.subplots(2,2). (3) System prompt trimmed to fit 3000-char limit. 155/155 tests. New DMG built. | ✅ Done |
| 33 | 2026-03-29 | src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | GMM covariance fix: added _fix_cov() helper that auto-converts 1-D cov vectors [sx,sy] into diagonal matrices np.diag([|sx|,|sy|]). Patched both scipy.stats.multivariate_normal.pdf and np.random.multivariate_normal. Also fixed _FlexAxes regression: wrapper now only applied when ncols>1 — single-subplot plt.subplots(figsize=...) was being wrapped causing AttributeError on ax.contourf(). System prompt: added "GMM covariances MUST be 2×2 matrices" rule. 155/155 unit tests. New DMG built. | ✅ Done |
| 32 | 2026-03-29 | src/renderer/src/components/chat/MarkdownRenderer.tsx, src/main/ipc/handlers.ts, src/main/services/SystemPromptService.ts | Three-way stability fix: (1) ECharts JSON repair — repairEChartsJson() strips trailing commas and stray { before key-value pairs before second JSON.parse attempt; recovers common model JSON mistakes silently. (2) _FlexAxes PREAMBLE class — axes list subclass returns hidden off-screen axes for out-of-bounds index access (axes[2] when cap=2) instead of IndexError; tuple unpacking (ax1, ax2 = axes) still works because list has real count. Reverted cap back to 2. (3) System prompt: banned ECharts scatter/line types — bar and pie only; added scatter/decision boundaries to matplotlib PREFERRED list. (4) REGRESSION FIX: _FlexAxes only applied when ncols>1 — single-subplot calls (plt.subplots(figsize=...)) were being wrapped in _FlexAxes causing AttributeError on every axes method call. 155/155 unit tests. New DMG built. | ✅ Done |
| 41 | 2026-03-30 | resources/python/worker_harness.py (new), src/main/services/PythonWorkerService.ts (new), src/main/index.ts, src/main/ipc/handlers.ts, package.json | Persistent Python worker: replaced per-render python3 subprocess (3–4s cold-start each time) with a long-lived worker process that pre-imports matplotlib/numpy/scipy once at app startup. Protocol: newline-delimited JSON over stdin/stdout. worker_harness.py signals {"ready":true} after imports, then loops on stdin reading {"code":...} requests and writing {"success":bool,"imageBase64":...} responses. PythonWorkerService manages lifecycle: start() (15s ready timeout), stop() (graceful exit + kill fallback), render() (30s per-request timeout with auto-restart on hang), fallbackRender() (one-shot spawn for startup race). Auto-restart on unexpected crash (stopping flag guards intentional stops). handlers.ts PYTHON_RENDER now delegates to pythonWorker.render() instead of spawning fresh process. index.ts starts worker at app launch and stops it in gracefulShutdown. package.json: added extraResources to bundle resources/python/*.py into Contents/Resources/python/ in packaged .app. Result: chart render latency drops from 3–4s to ~200ms. 155/155 tests passing. New DMG built. | ✅ Done |
| 43 | 2026-03-30 | src/main/services/SystemPromptService.ts, resources/python/worker_harness.py | Chart fixes: ASCII tree ban + list numpy indexing + scatter/plot shims: (1) SystemPromptService: added "BANNED: ASCII/text trees using ├──, └── characters — use \`\`\`mermaid mindmap instead." to RESPONSE FORMAT; updated mermaid section to include mindmap and hierarchies/taxonomies in its use-case; changed "NOT for … non-code narrative" → "NOT for … numeric data"; added "- Taxonomy, concept map, topic tree → \`\`\`mermaid mindmap" to DECISION GUIDE; shortened historical timeline guide entry; added matplotlib CODE RULE 7: "List indexing: np.array(labels)[sorted_idx], never labels[sorted_idx]." Prompt: 2923 → 2993 chars (budget 3000). (2) worker_harness.py: added _safe_barh and _safe_bar shims — auto-convert Python list labels to np.array before barh/bar call, preventing TypeError when model passes a list directly as y/x argument; added _safe_scatter — auto-truncates mismatched x/y arrays (plus c/s kwargs) to min length instead of crashing with ValueError; added _safe_plot — auto-truncates mismatched x/y in 2-arg plot() calls. Note: inline list[ndarray] indexing (feature_names[sorted_idx]) still fails before reaching the shim — rule 7 instructs the model to use np.array(labels)[idx] pattern instead. 155/155 tests passing. New DMG built. | ✅ Done |
| 44 | 2026-03-30 | src/renderer/src/components/chat/MarkdownRenderer.tsx, src/main/services/SystemPromptService.ts | Mermaid mindmap fix — missing header recovery + syntax rules: (1) MermaidBlock useEffect: replaced hard `isValidMermaidSyntax` rejection with recovery attempt — if first line starts with root(, prepend 'mindmap\n' and retry; only falls through to error if the diagram type is truly unrecognised. All subsequent references within the effect use codeToRender instead of code so the corrected version is passed to mermaid.render() and stored in lastRenderedCode. (2) SystemPromptService: added MERMAID HARD RULES 7 and 8 — rule 7: mindmap first line MUST be exactly 'mindmap', never jump to root(); rule 8: mindmap labels plain text only, no ^/math symbols. Trimmed 6 other prompt lines to stay within 3000-char budget (2993 → 2992 chars after additions). 155/155 tests passing. | ✅ Done |
| 42 | 2026-03-30 | src/renderer/src/components/chat/MarkdownRenderer.tsx, src/main/services/PythonWorkerService.ts, resources/python/worker_harness.py | Chart rendering Fix 2 — per-block execution + worker queue + exec scope: (1) MatplotlibBlock: replaced `if (isStreaming) return` gate with per-block code-stabilisation debounce using lastCodeRef. While streaming: 800ms of code-prop stability fires execution (closing ``` received, model moved on); after streaming: 200ms settle. Charts in a multi-chart response now start rendering as soon as each block is complete, not waiting for the whole response to finish. (2) PythonWorkerService: replaced single pendingResolve slot with a FIFO queue (QueueItem[]). Multiple concurrent render() calls queue behind each other on the warm persistent worker — no more "Worker busy — falling back to one-shot spawn" for charts 2 and 3. processNext() called after each response to drain queue. close handler drains entire queue with error on unexpected exit. (3) worker_harness.py execute_chart(): replaced sparse exec_globals dict with dict(globals()) — full module namespace copied into exec scope so all shims (_FlexAxes, _fix_cov, _mvn_safe_pdf, _auto_norm_imshow), pre-imported names (io, base64, traceback), and banned import guard are available to user code without explicit import. dict() copy prevents cross-request namespace pollution. Fixes NameError: name 'i' is not defined comprehension scoping edge cases. 155/155 tests passing. New DMG built. | ✅ Done |
| 49 | 2026-03-31 | src/renderer/src/hooks/useChat.ts, src/main/services/ChatService.ts, src/renderer/src/components/chat/ToolCallNotification.tsx | Web search notification timing + hallucination prevention + unknown topic handling: (1) useChat.ts: error events from WEB_SEARCH_STATUS are now buffered in liveToolCallRef without rendering — CHAT_STREAM_END decides whether to surface the error card by checking if the model's response mentions "search fail/unavailable/unable"; if model answered normally from training, no error card is shown. (2) ChatService.ts WEB_SEARCH_SYSTEM_ADDENDUM: added CRITICAL DATA INTEGRITY rules — model must only state facts explicitly present in search result snippets, must direct user to source URLs if the specific value wasn't in snippets, must not fill gaps from training memory. (3) messageNeedsSearch() expanded: added 'what is'/'who is'/'tell me about' to explicit triggers; added proper noun heuristic — short queries (≤8 words) with a capitalised non-common word trigger search so unknown topics (TurboQuant, recent papers, new products) are looked up rather than hallucinated. (4) Added [MCP] 📋 Search result injected log in both structured and raw tool call paths. (5) ToolCallNotification.tsx: error card layout fixed — label and query now on separate lines with min-w-0/shrink-0 to prevent overflow wrapping. 155/155 tests. DMG built. | ✅ Done |
| 48 | 2026-03-31 | src/main/services/ChatService.ts, src/renderer/src/hooks/useChat.ts | Web search over-triggering fix + raw tool call parser + cost optimisation: (1) Added messageNeedsSearch() heuristic — checks explicit trigger words (search/look up/today/latest/current/news/update), time-sensitive domains (price/stock/weather/score/bitcoin/crypto/election etc.), and regex patterns (who is the current X). Non-streaming tool-call detection round only fires when heuristic returns true — conversational and knowledge questions skip it entirely, saving one LM Studio request per message. (2) Added parseRawToolCall() — model-agnostic fallback parser for models that emit tool calls as <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call> text in the content field rather than structured tool_calls array. Executes search, injects synthetic tool result into currentMessages, proceeds to streaming final answer. Raw markup never leaks to UI. (3) Rewrote BRAVE_SEARCH_TOOL description to be selective (CURRENT/REAL-TIME only, explicit DO NOT USE list). Replaced MANDATORY BEHAVIOUR system addendum with selective USE/DO NOT USE rules — model no longer searches for philosophy, coding, history, or casual questions. (4) useChat.ts: added transient error dismissal — if liveToolCall.phase=error at stream end but the model produced content anyway, liveToolCall is cleared so the error card disappears. 155/155 tests. DMG built. | ✅ Done |
| 47 | 2026-03-31 | src/main/ipc/handlers.ts, src/main/services/BraveSearchService.ts, src/renderer/src/components/settings/MCPSettingsPanel.tsx, src/renderer/src/components/settings/SettingsPage.tsx | MCP settings persistence bugs + Save button + traffic light fix: (1) handlers.ts MCP_SAVE_SETTINGS: now builds cleanPatch by only including defined fields — spreading undefined was silently erasing the API key on every toggle change. (2) BraveSearchService.ts: removed env var priority — resolveBraveApiKey() now reads SettingsStore only. (3) MCPSettingsPanel.tsx: replaced auto-save debounce with explicit Save button; draft/saved state split so UI edits don't affect active chat until saved; isDirty flag drives button enabled state and "⚠ You have unsaved changes" indicator; "✓ Settings saved" / "Failed to save" feedback; keyIsActive derives from saved (not draft) so the green indicator only shows what's actually active; removed hasEnvKey / mcpGetEnvKeyStatus / "Loaded from .env" branch. (4) SettingsPage.tsx: left-nav header uses paddingLeft:80 + WebkitAppRegion:drag so "Settings" title clears macOS traffic light buttons. 155/155 tests. DMG built. | ✅ Done |
| 46 | 2026-03-31 | src/renderer/src/components/layout/Layout.tsx, src/renderer/src/components/settings/SettingsPage.tsx, src/renderer/src/components/layout/Sidebar.tsx | Settings page layout + tab styling fixes: (1) Layout.tsx: settings now replaces the ENTIRE view — sidebar and chat are not rendered when settingsOpen=true; previously SettingsPage was nested inside the main column so the sidebar remained visible. (2) SettingsPage.tsx: TabItem rewritten to use exact ChatItem active/inactive classes (bg-accent-950/60 border border-accent-900/40, text-accent-500 icon, text-content-primary label) — removed invented border-l-2 border-red-700 / bg-red-950/20 classes. Added cn import. (3) Sidebar.tsx: removed model name badge (redundant — shown in settings Model tab); cog button now stands alone; removed unused useModelStore import and selectedModel destructure. 155/155 tests. DMG built. | ✅ Done |
| 52 | 2026-03-31 | src/main/services/ChatService.ts, src/renderer/src/lib/markdownUtils.ts, src/renderer/src/lib/__tests__/markdownUtils.test.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx, src/renderer/src/hooks/useChat.ts | Qwen Thinking + Brave Search blank-answer fix: (1) Fix 1 — Step 1 (tool-detection round) now uses a separate step1Body with thinking:disabled and max_tokens:512 — eliminates the ~11s TTFT caused by Qwen spending 8000 thinking tokens just to decide whether to call a tool. (2) Fix 2 — Step 2 uses adaptive thinking budget: toolCallRound=true (search happened) → 4000 tokens; no search → 8000 tokens. Both step1Body and step2Body explicitly exclude tools from Step 2. toolCallRound flag set at both structured and raw tool-call injection points. (3) Fix 3 — parseThinkBlocks gains optional streamEnded param (default false). When streamEnded=true and think block is still open (truncated by max_tokens), surfaces thought content as the answer instead of empty string — user sees the reasoning rather than a blank card. MarkdownRenderer passes !isStreaming to parseThinkBlocks; useMemo deps include isStreaming. 6 new unit tests. (4) Fix 4 — useChat.ts: thinkStartedAt ref tracks first-chunk time; if think block open for >45s without closing, abortChat() is called as a belt-and-suspenders timeout guard. (5) Fix 5 — WEB_SEARCH_SYSTEM_ADDENDUM: added brevity instruction telling model to keep think block short when search results are available. 161/161 tests. New DMG built. | ✅ Done |
| 51 | 2026-03-31 | src/main/services/ChatService.ts, src/main/services/DatabaseService.ts, src/shared/types.ts, src/renderer/src/hooks/useChat.ts, src/renderer/src/components/layout/Layout.tsx, src/main/ipc/handlers.ts, src/preload/index.ts, resources/python/worker_harness.py, src/main/services/SystemPromptService.ts, src/renderer/src/components/chat/MarkdownRenderer.tsx | Six-Fix Master: (1) Fix 1 — stripLeadingThinkClose(): strips orphaned </think> tag from non-streaming Step 1 response content and from first SSE delta chunk — prevents Qwen thinking-mode leak showing literal </think> in rendered output. (2) Fix 2 — toolCall DB persistence: added toolcall_json TEXT column migration to chat_messages, updated saveMessage() to accept and store toolCallJson, getChatMessages() returns toolCallJson, StoredMessage type adds toolCallJson field, useChat.ts passes JSON.stringify({query,results}) to saveMessage on stream-end when search phase=done, Layout.tsx restores toolCall from toolCallJson on chat load — "Searched the web" pill now survives chat switching. (3) Fix 3 — pandas unblocked as yfinance internal dep: removed 'pandas' from _BANNED frozenset in worker_harness.py; removed pandas from SystemPromptService "Do NOT import" line — model still writes numpy code but yfinance internal pandas imports no longer crash the worker. (4) Fix 4 — dollar signs as plain text: added { singleDollarTextMath: false } to remarkMath plugin — $164.65 to $174.63 renders as text; $$...$$ block math unaffected. (5) Fix 5 — date injection: buildMessages() now prepends "Current date and time: ..." to system prompt on every request — models use 2026 not training-cutoff year in search queries. 155/155 tests. New DMG built. | ✅ Done |
| 50 | 2026-03-31 | src/renderer/src/components/settings/SettingsPage.tsx, src/main/services/ChatService.ts, src/main/services/BraveSearchService.ts, src/main/services/PythonWorkerService.ts, resources/python/worker_harness.py, src/main/services/SystemPromptService.ts | Master fix — settings centering, search honesty, markdown sanitisation, yfinance finance charts: (1) SettingsPage.tsx: content panel now uses mx-auto with maxWidth:720 so settings fields are centred rather than left-aligned. (2) ChatService.ts WEB_SEARCH_SYSTEM_ADDENDUM: added IMPORTANT EXCEPTION for versioned content (documentation, release notes, version-specific APIs) that training data may have outdated — model must search for those too; added SELF-HONESTY RULE. (3) BraveSearchService.ts formatSearchResults(): added sanitise() helper that strips **, *, __, _ (converted to space), and backticks from snippet text before injecting into model context — prevents markdown syntax in search snippets from bleeding into rendered response. (4) PythonWorkerService.ts: added execSync import; pre-flight check in start() runs 'python3 -c "import yfinance"' before spawning worker — if missing, runs 'pip3 install yfinance --break-system-packages --quiet' (60s timeout); non-fatal if install fails. (5) worker_harness.py: added optional yfinance import after scipy (try/except with yf=None fallback); yf available in exec_globals via dict(globals()) copy. (6) SystemPromptService.ts: added CRITICAL rule banning manual code for finance charts; updated Pre-imported list to include yfinance as yf; added FINANCE subsection with yf.Ticker().history() pattern, period/interval table, empty-data guard; updated DECISION GUIDE finance entry. Prompt trimmed to 2999 chars to stay under 3000-char budget. 155/155 tests. DMG Desktop Intelligence-1.5.1-arm64.dmg built. | ✅ Done |
| 45 | 2026-03-31 | src/main/services/BraveSearchService.ts (new), src/main/services/ChatService.ts, src/main/services/SettingsStore.ts, src/main/ipc/handlers.ts, src/preload/index.ts, src/shared/types.ts, src/renderer/src/components/settings/SettingsPage.tsx (new), src/renderer/src/components/settings/ModelSettingsPanel.tsx (new), src/renderer/src/components/settings/MCPSettingsPanel.tsx (new), src/renderer/src/components/chat/ToolCallNotification.tsx (new), src/renderer/src/components/layout/Layout.tsx, src/renderer/src/hooks/useChat.ts, src/renderer/src/components/chat/MessageBubble.tsx | MCP Tool Calling + Brave Search + Settings page redesign: (1) Settings replaced as full-page panel in Layout (SettingsPage.tsx) with left-nav tabs — sidebar stays visible, no more floating modal. ModelSettingsPanel extracted verbatim. MCPSettingsPanel: Brave Search card with toggle, API key input (password/show), .env priority (shows "Loaded from .env" label when BRAVE_SEARCH_API_KEY env var is set), amber/green key-status indicator. (2) BraveSearchService.ts: braveSearch() fetches api.search.brave.com/res/v1/web/search, formatSearchResults(), resolveBraveApiKey() (env var > settings). (3) ChatService.ts: BRAVE_SEARCH_TOOL definition, WEB_SEARCH_SYSTEM_ADDENDUM (mandatory search instructions), WEB_SEARCH_DISABLED_ADDENDUM (informs model search is off). Two-step request: non-streaming round when Brave enabled to detect tool_calls; if finish_reason=tool_calls → executes braveSearch, appends assistant+tool messages, streams final answer; if direct answer → emits as single chunk. Full error classification (401/429/network). (4) ToolCallNotification.tsx: searching spinner, done collapsible pill (click to expand query + up to 5 sources), error card. (5) useChat.ts: liveToolCall state + ref, reset on sendMessage; WEB_SEARCH_STATUS handler updates liveToolCall and patches assistant message; on CHAT_STREAM_END persists toolCall onto message if search phase=done. (6) MessageBubble.tsx: renders ToolCallNotification above content using liveToolCall (live) or message.toolCall (history). (7) types.ts: WebSearchStatus updated to {phase,query,results?,error?}; StoredMessage.toolCall added; IPC_CHANNELS: MCP_GET_SETTINGS, MCP_SAVE_SETTINGS, MCP_GET_ENV_KEY_STATUS. (8) Fixed WebSearchService.ts to use new phase shape (was {status}). 155/155 tests. DMG built. | ✅ Done |
| 57 | 2026-04-02 | src/main/services/ChatService.ts, src/renderer/src/hooks/useChat.ts | Fix mid-stream tool call chunks leaking to renderer: (1) ChatService.ts SSE loop: moved send(CHAT_STREAM_CHUNK) and totalTokens update to AFTER the mid-stream tool call check — previously chunks were sent first, then buffered, so the chunk containing <tool_call> text was committed to React state before the RETRACT could clean it. Now: streamBuffer += cleanedDelta → check for tool call → if intercepted: RETRACT+search+retry and break without sending; if not intercepted: totalTokens += ... and send chunk. (2) useChat.ts: added retractedContentRef (useRef<string|null>) — set by retract handler, read+cleared by next chunk handler; chunk handler now sets content to streamingContentRef.current (full accumulated string) instead of prev.content+chunk, eliminating the React 18 automatic-batching stale-closure race where a chunk in the same microtask as RETRACT would append to un-retracted content. retractedContentRef reset to null in sendMessage. 164/164 tests passing. | ✅ Done |
| 56 | 2026-04-02 | src/main/services/ChatService.ts, src/shared/types.ts, src/preload/index.ts, src/renderer/src/hooks/useChat.ts, src/renderer/src/components/layout/ChatArea.tsx, src/renderer/src/components/layout/Layout.tsx | Three-fix pass — mid-stream tool call recovery, scroll-on-send, relative scroll threshold: (1) Fix 1A (inline recovery): direct-answer else branch now checks parseRawToolCall+extractQueryFromCodeFenceToolCall before streaming content; if a hidden query is found, search executes and falls through to Step 2 — raw tool call XML is never streamed. (2) Fix 1B (mid-stream SSE interception): Step 2 loop accumulates chunks in streamBuffer; on </tool_call>, query extracted, stream aborted, CHAT_STREAM_RETRACT sent with clean pre-tool-call content, search executes, new AbortController + inline retry SSE loop streams the final answer. IPC_CHANNELS.CHAT_STREAM_RETRACT='chat:streamRetract' added to types.ts + preload; useChat.ts handler resets streamingContentRef and message content to clean version. (3) Fix 2: ChatArea user-message useEffect now calls scrollIntoView immediately after React commits the new message — fires after the DOM is ready, replacing the Layout.handleSend premature scrollToBottom() call. (4) Fix 3: handleScroll re-enable threshold replaced from hardcoded 150px → Math.min(clientHeight*0.20, 300) — zoom-independent. 164/164 tests passing. | ✅ Done |
| 55 | 2026-04-01 | src/main/services/ChatService.ts, src/main/services/SystemPromptService.ts, src/renderer/src/components/layout/ChatArea.tsx | Web Search + Mermaid Stabilisation — 7-fix pass: (1) parseRawToolCall() extended to handle all observed formats: A=XML arg_key/arg_value, B=unquoted key=value, C=quoted key="value" (was broken), D=JSON object. Formats tried in priority order, early-return on first match. (2) extractQueryFromCodeFenceToolCall() added — detects when model wraps tool call in ```BRAVE_WEB_SEARCH...``` fence or emits bare JSON array of queries; first query extracted and search executed; raw fence never reaches renderer. Code-fence detection inserted before the direct-answer branch in Step 1 handling — falls through to Step 2 with results injected. (3) WEB_SEARCH_SYSTEM_ADDENDUM: added TOOL CALL FORMAT block — explicitly bans JSON arrays, code-fence wrapping, raw XML; one search per response. (4) SystemPromptService mindmap RULE 7 rewritten: indentation now explicitly required, example shown inline (mindmap → root((Topic)) → 2-space children); rule 8 adds parentheses to banned label chars. (5) Direct-answer CHAT_STREAM_END: tps→tokensPerSec field name fixed; aborted:false added. (6) ChatArea.tsx auto-scroll deps extended with messages[-1].isSearching and messages[-1].isThinking so scroll fires when search spinner or thinking indicator appears, not only on content changes. (7) Step 1 max_tokens raised 512→2048 — prevents truncation of complete direct answers from Step 1. 164/164 tests. | ✅ Done |
| 54 | 2026-04-01 | src/main/services/ChatService.ts | Critical regression fix — think-block duplication: stripLeadingThinkClose() was applied to every SSE delta chunk. Qwen3/GLM emit a standalone "</think>" as its own SSE chunk; stripping it on every iteration swallowed that token, leaving the <think> block unclosed. parseThinkBlocks(content, true) hit Case 3 → answer = thought = full content → content appeared in both accordion and chat body. Fix: added firstChunkProcessed flag; stripLeadingThinkClose() now applied only to the first delta chunk. 164/164 tests. New DMG built. | ✅ Done |
| 53 | 2026-04-01 | src/main/services/SystemPromptService.ts, src/main/services/__tests__/SystemPromptService.test.ts, src/main/services/ChatService.ts | MCP Bug Fix — think-block leak + streaming animation: (1) Bug 1 ROOT CAUSE: GLM-4.7-flash (and other non-Qwen models) output structured CoT reasoning ("1. Analyze the Request…", "2. Analyze the Search Results…") as plain text OUTSIDE </think>. parseThinkBlocks correctly routes it to answer where it renders to the user. FIX: Added THINKING RULE to BASE_SYSTEM_PROMPT: "Keep ALL reasoning inside <think>…</think>. Outside <think> = final answer only. Never write numbered analysis steps outside the think block — not even after web search." Also reinforced in WEB_SEARCH_SYSTEM_ADDENDUM. Token budget bumped 3000→3500, test updated with history note. (2) Bug 2 ROOT CAUSE: messageNeedsSearch() was too broad — 'what is', 'who is', 'tell me about', all proper nouns in ≤8-word queries triggered Step 1 non-streaming even for pure knowledge questions. Step 1 direct-answer path sent the entire response as ONE chunk + immediate STREAM_END → React batched both updates → isStreaming never rendered true → typewriter cursor never appeared. FIX A: tightened messageNeedsSearch — removed broad triggers, narrowed proper-noun heuristic to require a recency signal (recent/current/latest/now/2025/2026), expanded COMMON_CAPS to include Python/React/Java/etc. FIX B: added streamContentInChunks() helper that sends content in 80-char chunks at 16ms intervals; Step 1 direct-answer branch now uses it instead of one-shot send, restoring typewriter animation. totalTokens now correctly estimateTokens(cleaned) instead of 0. 161/161 tests passing. | ✅ Done |
| 56 | 2026-04-01 | src/main/services/ChatService.ts, src/main/services/tokenUtils.ts, src/main/services/DatabaseService.ts, src/main/services/PlotStore.ts, src/main/ipc/handlers.ts, src/renderer/src/components/layout/ChatArea.tsx, src/renderer/src/components/layout/Layout.tsx, src/renderer/src/components/chat/MarkdownRenderer.tsx, src/preload/index.ts, src/shared/types.ts | Token-budget trimming + Plot RAG: (1) tokenUtils.ts calculates rigorous token usage with tiktoken. (2) ChatService.ts: replaced naive HISTORY_WINDOW=20 with strict token budget trim (walks newest->oldest accumulating tokens) and matplotlib code string stubbing for older history. ContextSliderService gutted. (3) Plot RAG DB: defined plot_store table in DatabaseService.ts, added PlotStore.ts storage service. (4) handlers.ts: CHAT_SEND adds PlotRAG heuristic that injects past plots as vision attachments when referenced ("that chart"); added plot:store handler. (5) MarkdownRenderer.tsx MatplotlibBlock saves successful plots via window.api.storePlot, leveraging activeChatId passed down from Layout.tsx -> ChatArea.tsx context. | ✅ Done |
| 58 | 2026-04-02 | src/main/services/ChatService.ts | Fixed mid-stream tool call leaks — implemented `detectMidStreamToolCall` helper to intercept unclosed `<tool_call>` tags and unclosed code fences seamlessly during SSE streaming. Resolves raw XML leaking into the chat UI when models hit a stop token immediately after JSON arguments. | ✅ Done |
| 59 | 2026-04-02 | src/main/services/ChatService.ts | Fixed mid-stream tool call parsing for Qwen specific XML format (`<function=...><parameter=...></parameter></function>`) by adding Format E to `parseRawToolCall`, and updated `detectMidStreamToolCall` unclosed tag heuristic to catch `</parameter>`. This resolves the issue where raw tool call XML leaked to the chat window because the parser didn't recognize the tag structure. | ✅ Done |
| 60 | 2026-04-02 | src/main/services/ChatService.ts, src/renderer/src/hooks/useChat.ts | UI Regressions & Context Memory fixes: (1) Fixed mid-stream tool call interception to check for unclosed `<think>` tags in the pre-tool-call buffer and automatically append `\n</think>\n` before dispatching `CHAT_STREAM_RETRACT`. Ensures the reasoning accordion closes cleanly before generating the tool-augmented answer. (2) Extracted `call_${Date.now()}` to a variable to prevent race-condition tag mismatches. (3) Solved contextual amnesia where the model hallucinates or repeats tool intentions on sub-queries by augmenting `useChat.ts`. Previous tool results are now embedded as `[System Note: ...]` into the active prompt payload (`wire`) so the LLM retains functional execution memory without leaking plain-text XML into the frontend. | ✅ Done |
| 61 | 2026-04-02 | src/main/ipc/handlers.ts, src/main/services/ChatService.ts, src/renderer/src/hooks/useChat.ts, src/shared/types.ts | Search repetition & memory optimisations: (1) Removed redundant performWebSearch check in `handlers.ts` since search must exclusively use MCP logic. (2) Mapped `toolCall` results dynamically into `role: 'tool'` and `role: 'assistant'` pair inside `WireMessage`, bypassing the earlier `[System Note]` technique. (3) Added `cleanAssistantHistory` to automatically strip any orphaned `[System Note]`s from past chats during payload traversal. (4) Added Tool Result context pruning in `buildMessages` so that tool-call responses beyond the active newest round are stubbed out with `[Previous Search Results for query]` to save 1000s of tokens from older contexts. (5) Fast-tracked UI chunk sync by refactoring `stripLeadingThinkClose` outside the `streamContentInChunks` for loop so chunks stream natively. (6) Reduced hallucinated searches by adding a new size-based validation (`<= 3` word conversational phrases) to `messageNeedsSearch` to skip the search detection phase entirely if there are no explicit nouns. | ✅ Done |
| 62 | 2026-04-03 | src/renderer/src/hooks/useChat.ts | Context amnesia fix: in the wire flatMap, track the index of the LAST message with a toolCall. All earlier toolCall messages now produce a stubbed tool result (`[Previous search: <query>]`) instead of re-sending full JSON results — prevents stale search data from prior turns dominating context and causing the model to re-answer the old question. | ✅ Done |
| 63 | 2026-04-03 | src/main/services/ChatService.ts | Think-block duplication fix: in the Step 1 direct-answer branch, extract content AFTER the last `</think>` tag before passing to `streamContentInChunks`. Previously `stripLeadingThinkClose` only stripped a bare `</think>` at the start; full `<think>…</think>` blocks in the direct answer reached the renderer and `parseThinkBlocks` surfaced them in both the accordion AND the answer body (Case 3 duplication). | ✅ Done |
| 64 | 2026-04-03 | src/main/services/SystemPromptService.ts | Matplotlib cross-block NameError fix: added CODE RULE 8 telling the model that each matplotlib block runs in a completely isolated Python scope, variables from previous blocks do not persist, and every block must be fully self-contained. Also trimmed FINANCE, MERMAID RULES, and other lines to stay within the 3500-char budget. 142/142 tests passing. | ✅ Done |
| 65 | 2026-04-03 | src/renderer/src/components/layout/ChatArea.tsx | Scroll-on-send fix: replaced the `last?.role === 'user'` guard in the scroll-on-send useEffect with a check for the fresh assistant placeholder (role=assistant, content='', isThinking=true, secondLast.role=user). Since sendMessage inserts user + assistant in one setMessages call, the last message after the update is the assistant placeholder — the old guard never fired, causing the page to stay in place until the first streaming chunk arrived. | ✅ Done |
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