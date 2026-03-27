# Desktop Intelligence

A native macOS desktop chat application that runs large language models entirely on your machine via [LM Studio](https://lmstudio.ai/). No cloud. No API keys. Full privacy.

Built for **Apple Silicon** (M-series) with the `mlx-community/Qwen3.5-35B-A3B-6bit` model as the primary target, sustaining ~71 tokens/second on an M5 Pro.

Built with Claude Code

---

## Features

### Chat
- Streaming token-by-token responses with a blinking cursor
- Full **Markdown rendering** — headings, bold/italic, tables, task lists, blockquotes, inline code
- **Syntax-highlighted code blocks** (highlight.js, dark theme)
- **LaTeX math** rendered with KaTeX (`$...$` inline, `$$...$$` display)
- **Mermaid diagrams** rendered as native SVG — flowcharts, sequence diagrams, class diagrams, Gantt charts, pie charts, mindmaps, timelines, and more
- Collapsible **Thought Process** accordion for Qwen's `<think>...</think>` reasoning blocks
- **Thinking / Fast mode toggle** — switch between deep reasoning (budget: 8 000 tokens) and direct fast replies mid-conversation

### Document Q&A (RAG)
- Attach **PDF files** to any message — the app extracts the full text, stores it in SQLite, and injects it into the context window before calling the model
- Each chat session has its own isolated document store; documents never leak between chats
- Supports images (passed as base64 vision payloads)

### Chat History
- Persistent chat history stored locally in SQLite (`better-sqlite3`)
- Sidebar groups chats by **Today / Yesterday / Earlier**
- Each chat retains its full message history including attached document metadata

### Reliability
- LM Studio daemon is auto-launched and health-checked with exponential backoff
- Connection overlay only appears after **two consecutive** health-check failures — a single timeout during GPU-intensive generation is silently absorbed
- Runaway generation is caught by both server-side stop sequences and a client-side repetition detector (same line three times → stream aborted)

### UX
- Smart auto-scroll: follows the live output as it streams; pauses the moment you scroll up; resumes when you scroll back to the bottom or send a new message
- Fully offline — no telemetry, no external network requests

---

## Tech Stack

| Layer | Technology |
|---|---|
| Shell | Electron 31 |
| Frontend | React 18 + Vite + TypeScript (strict) |
| Styling | Tailwind CSS v3 + shadcn/ui |
| Markdown | react-markdown + remark-gfm + remark-math + rehype-katex |
| Diagrams | Mermaid 11 |
| Syntax highlighting | highlight.js |
| Database | better-sqlite3 |
| AI backend | LM Studio (`/v1/chat/completions`, OpenAI-compatible SSE) |
| PDF parsing | pdf-parse |
| Packaging | electron-builder (macOS arm64 DMG) |

---

## Requirements

- **macOS** (Apple Silicon — arm64)
- [LM Studio](https://lmstudio.ai/) installed and the `lms` CLI available on `$PATH`
- Node.js 20+

---

## Getting Started

```bash
# Install dependencies
npm install

# Start in development mode (Electron + Vite hot-reload)
npm run dev

# Run the test suite (141 unit tests)
npm test

# Build a production DMG
npm run package
```

The packaged app is output to `dist/Desktop Intelligence-1.0.0-arm64.dmg`.

---

## Model Configuration

The default model is set in `src/shared/types.ts`:

```typescript
export const DEFAULT_MODEL_ID = 'mlx-community/Qwen3.5-35B-A3B-6bit'
```

Any LM Studio-compatible model can be used by changing this constant or selecting a different model in the top bar at runtime.

---

## Architecture Overview

```
Renderer (React)          Main Process (Node/Electron)
─────────────────         ──────────────────────────────
Layout / ChatArea         IPC handlers
MessageBubble             ├── FileProcessorService  (PDF → SQLite)
MarkdownRenderer          ├── RAGService            (SQLite full-text retrieval)
  └── MermaidBlock        ├── ChatService           (SSE streaming → renderer)
InputBar                  ├── SystemPromptService   (base prompt injection)
ModelStore (Context)      └── DatabaseService       (chat history)
                          Managers
                          ├── ModelConnectionManager (health polling)
                          └── LMSDaemonManager       (lms CLI lifecycle)
```

All heavy work (PDF parsing, database writes, LM Studio API calls) runs in the Electron main process. The renderer is purely presentational and communicates exclusively through typed IPC channels via `contextBridge`.

---

## Debugging (Packaged App)

Since Electron swallows stdout in the packaged `.app`, launch from Terminal to see logs:

```bash
/Applications/"Desktop Intelligence.app"/Contents/MacOS/"Desktop Intelligence"
```

Key sentinel log lines to watch:

| Log prefix | Meaning |
|---|---|
| `[FileProcessor] 📄` | File received and being processed |
| `📄 PDF-PARSE EXTRACTED CHARACTERS:` | PDF text extraction succeeded |
| `[RAG] 🧠 ingestDocument` | Document being written to SQLite |
| `🔥 VECTOR DB RESULTS COUNT:` | RAG retrieval result count |
| `🚀 FINAL LM STUDIO PAYLOAD:` | Full JSON sent to LM Studio |
| `[Mermaid] render failed:` | Diagram parse/render error with reason |
