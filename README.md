# Desktop Intelligence

A native macOS chat application for local and cloud language models. It connects to LM Studio, Ollama, NVIDIA Build, or OpenRouter, and can run entirely offline when privacy matters more than raw capability.

---

## Local inference: hardware requirements and disclaimer

The requirements in this section apply only to local inference through LM Studio. Cloud backends (NVIDIA Build, Ollama, OpenRouter) have no hardware requirements beyond what the application itself needs.

When running local models, memory usage depends on the model you load.

| RAM         | Status                                                                |
| ----------- | --------------------------------------------------------------------- |
| 64 GB+      | Ideal. Runs large MoE models (35B+) with full performance and headroom  |
| 48 GB       | Recommended minimum for large models                                  |
| 32 GB       | Workable with smaller models (7B to 14B). Avoid 35B+ models            |
| Under 32 GB | Not recommended. Insufficient for most capable models                  |

Apple Silicon (M-series) only. Intel Macs are not supported.

Local inference is computationally intensive and generates significant heat. Running large models places sustained load on the SoC in ways typical workloads do not. On Apple Silicon MacBooks, lighter models (3B to 14B) run warm but remain manageable. Dense 27B+ models cause the machine to run very hot under prolonged use. Ensure adequate ventilation and avoid running intensive models on a blocked or poorly ventilated surface for extended periods. Cloud backends generate no local heat and have no hardware constraints.

This project was built for personal use and learning on the author's own hardware. It is not a polished commercial product and is not recommended unless you understand the risks. The author accepts no responsibility for hardware damage, thermal throttling, reduced component lifespan, or any other adverse effects resulting from running this software. Use at your own risk.

---

![Desktop Intelligence chat interface](app_images/home.png)

---

## Overview

Built for Apple Silicon. Four inference backends are supported and can be switched from Settings at any time.

| Backend       | Description                                                                     |
| ------------- | ------------------------------------------------------------------------------- |
| LM Studio     | Local inference via MLX. Fully offline, maximum privacy. Requires the `lms` CLI. |
| Ollama        | Local inference via Ollama. Point it at any running Ollama instance.             |
| NVIDIA Build  | Cloud inference via NVIDIA's free API tier. No local model required.             |
| OpenRouter    | Cloud inference via OpenRouter. Hundreds of models behind one API key.           |

![Inference backend selector](app_images/inference_backends.png)

Tested with `mlx-community/Qwen3.5-35B-A3B-6bit` via LM Studio, sustaining roughly 71 tokens per second on an M5 Pro. Gemma 4 (`google/gemma-4-26b-a4b`) is the current pick for local reasoning and vision.

- [Full feature list](FEATURES.md): chat, RAG, visualizations, diagrams, math rendering, thinking mode, web search
- [Installation guide](INSTALLATION.md): install LM Studio, download a model, and get running
- [Changelog](CHANGELOG.md): what changed in each release

---

## Screenshots

### First launch: model selection

![First-launch model selector](app_images/setup_screen_model_selector_form.png)

On first launch, choose any model you have downloaded in LM Studio and set an initial context window. The selection is saved and applied automatically on every subsequent launch.

RAM note: models of 35B or larger require 48 GB of unified memory or more. Loading a 35B model at 128K context can use 40 to 55 GB of RAM, which will compress other applications. On 32 GB machines, stay with 7B to 14B parameter models.

---

### Rich text formatting in user and assistant bubbles

![Rich text formatting in chat with Markdown and MathJax](app_images/rich_text_formatting_demo.png)

User messages are fully rendered. Markdown headings, bold and italic text, code blocks, lists, and tables display correctly in user bubbles rather than as raw text. Assistant responses support the same Markdown features alongside LaTeX math, Mermaid diagrams, and syntax-highlighted code.

### Markdown, code, and math

![Markdown and math rendering](app_images/markdown_demo.png)

Full Markdown rendering with syntax-highlighted code blocks, tables, and task lists. LaTeX math is rendered through KaTeX.

![Math demo](app_images/math_demo.png)

### Native data visualizations

![Charts and visualizations](app_images/charts-demo-1.png)

Ask the model to plot anything: distributions, decision boundaries, neural network activations, time series. Charts render natively through a `python3` subprocess running `matplotlib`, styled to match the dark interface.

![Charts and visualizations, second example](app_images/charts-demo-2.png)

### Settings: model and generation parameters

![Model settings with model selection, context length, and generation parameters](app_images/settings_screen_model_selection_and_context_length.png)

Change the active model, adjust the context window, and tune generation parameters (temperature, top P, max output tokens, repeat penalty) from the Settings panel. A custom system prompt can be set to give the model persistent instructions across all chats. All choices persist across restarts.

### Chat-level system instructions

![Chat-level system instructions panel](app_images/chat_level_system_instructions.png)

Each chat can carry its own instructions, separate from the global system prompt. Click the scroll icon in the top bar to open the panel, type your instructions, then click anywhere to dismiss. They save automatically.

Instructions stack on top of the global system prompt in this order: the application base prompt, your global settings prompt, then the chat instructions. Chat instructions come last, so they take priority on any conflict. This lets you scope a chat to a specific task without touching your global configuration. Instructions persist until the chat is deleted.

### Settings: MCP (Model Context Protocol)

Desktop Intelligence supports the [Model Context Protocol](https://modelcontextprotocol.io/), an open standard that lets the application call external tools and services on demand. MCP servers are configured from the Settings panel and invoked by the model during chat.

Add a server with the settings form:

![Adding an MCP server through the settings form](app_images/add_mcp_settings_form.png)

Enter a name, a URL or command, and any required parameters, then click Add to register the server.

![Adding an MCP server through JSON configuration](app_images/add_mcp_settings_json_form.png)

You can also paste a raw MCP server configuration in JSON format. This is useful when you have a server definition from documentation or want to import several servers at once.

![Added MCP servers listed in settings](app_images/mcp_added_settings_example.png)

Each registered server appears as a card in the settings list with its name and status. Servers can be toggled on or off, edited, or removed.

If a server exposes extra tools, individual tools can be disabled:

![Selective MCP tool use](app_images/mcp_selective_tool_use.png)

### Built-in Brave Search MCP

Brave Search ships as a built-in MCP server. See the Web Search tab.

![Brave Search MCP settings](app_images/settings_screen_brave_search_mcp_api_key_and_toggle.png)

Enable real-time web search by pasting a [Brave Search API key](https://brave.com/search/api/). The application performs a targeted search before answering time-sensitive questions. Results are injected into the model's context rather than recalled from training data.

![Brave Search in chat with live web results inline](app_images/brave_search_mcp_chat_demo.png)

### MCP tool calls in chat

When the model decides to use an MCP tool during a conversation, the call is rendered inline. You can see which tool was invoked and what it returned without leaving the chat.

![MCP tool calls appearing inline during chat](app_images/mcp_tool_use_demo.png)

Tool invocations are handled transparently. The application sends the request to the MCP server, captures the result, and feeds it back into the model's context. Each call and its output appear as a structured entry in the transcript.

### Human in the loop: MCP tool approval

Desktop Intelligence gives you control over which MCP tools the model can call and when. The human-in-the-loop system sits between the model and every tool invocation, letting you approve, review, or block calls before they execute. This matters most for tools that write files, send messages, or interact with external services, where actions can have real consequences and should not happen silently.

Tool approval popup during chat:

![Human-in-the-loop tool approval popup appearing inline during a conversation](app_images/HITL_demo_tool_permission_popup.png)

When a call requires approval, a popup appears inline in the chat showing the tool name, the server it belongs to, and the full arguments the model intends to pass. You can approve the call, deny it (which cancels the invocation and informs the model), or allow all future calls from that server for the rest of the session. The popup does not block the rest of the interface and resolves as soon as you choose.

Per-server permission controls in Settings:

![Per-server human-in-the-loop permission controls in Settings](app_images/HITL_demo_per_server_controls.png)

Each MCP server has its own permission mode, configurable from the Settings panel. A server can require approval for every call, allow all calls automatically, or be blocked entirely. These preferences persist across sessions, so read-only servers can be trusted once while sensitive servers always pause for review.

Per-chat override to require permissions:

![Chat-level button to require permissions for all MCP tools](app_images/HITL_demo_chat_require_permissions_button.png)

A button in the chat toolbar enforces approval for all MCP tool calls in the current conversation, regardless of the server-level setting. This is useful when you want stricter oversight for a specific task without changing your global configuration. The toggle stays visible so you can change it at any point mid-conversation.

Per-chat override to bypass permissions:

![Chat-level button to bypass permissions for all MCP tools](app_images/HITL_demo_bypass_permissions_button.png)

The inverse is also available. If a trusted server is set to require approval and you want to run a long agentic task without interruption, you can bypass permission checks for the duration of the conversation. The bypass is scoped to the current chat and resets when you start a new one, so default settings are never permanently changed.

---

### Context compaction

![Context bar with the Compact button enabled](app_images/context_compacting_option.png)

When the context bar approaches its limit, the Compact button summarises the conversation and frees context window space. The model produces a structured summary, then all prior messages are replaced atomically in SQLite.

![Compaction running with a blocking overlay and progress bar](app_images/context_compacting_running.png)

A full-screen overlay blocks input while the summary is generated. The chat then reloads from the condensed history.

![Toast message after compaction showing tokens before and after](app_images/context_compacting_finished_toast_message.png)

A toast confirms how many tokens were freed. The context bar resets and the conversation continues from the summary. Context substance is preserved, only the verbatim history is reduced.

---

### Observability logs

![Observability logs in debug settings](app_images/observability_logs.png)

Desktop Intelligence includes a session-tracing observability system, enabled from the Settings panel under the Debug tab. It compiles detailed traces for each conversation. Every log records the raw system prompt, RAG retrieved context, model thinking blocks, tool calls and their results, messages sent, and the final answer.

With the optional image capture setting enabled, rendered charts and base64 images from the chat are saved as individual files alongside a linked Markdown log of the session. Logs are stored locally on your machine, which keeps session data private while making the model's internal behaviour inspectable.

---

## Quick start (development)

End users should follow [INSTALLATION.md](INSTALLATION.md) instead.

```bash
# Install dependencies
npm install

# Start in development mode (Electron + Vite hot reload)
npm run dev

# Run the test suite
npm test

# Build a production DMG
npm run package
```

The packaged app is written to `dist/Desktop Intelligence-<version>-arm64.dmg`.

---

## Tech stack

| Layer               | Technology                                                        |
| ------------------- | ----------------------------------------------------------------- |
| Shell               | Electron 44                                                       |
| Frontend            | React 18, Vite, TypeScript (strict)                               |
| Styling             | Tailwind CSS v3, shadcn/ui                                        |
| Markdown            | react-markdown, remark-gfm, remark-math, rehype-katex             |
| Diagrams            | Mermaid 11 (native SVG)                                           |
| Syntax highlighting | highlight.js                                                      |
| Database            | better-sqlite3 (SQLite)                                           |
| AI backends         | LM Studio, Ollama, NVIDIA Build, OpenRouter                       |
| Visualizations      | matplotlib via a persistent python3 worker                        |
| MCP                 | Model Context Protocol server manager, form and JSON config       |
| Web search          | Brave Search API (optional MCP tool)                              |
| PDF parsing         | pdf-parse                                                         |
| Packaging           | electron-builder (macOS arm64 DMG)                                |
| Observability       | Session tracer writing text and image logs locally                |

---

## Architecture

| Renderer (React)     | Main process (Node, Electron)                          |
| -------------------- | ------------------------------------------------------ |
| Layout, ChatArea     | IPC handlers                                           |
| MessageBubble        | FileProcessorService, PDF to SQLite                    |
| MarkdownRenderer     | RAGService, SQLite full-text retrieval                 |
| MermaidBlock         | ChatService, SSE streaming to the renderer             |
| MatplotlibBlock      | SystemPromptService, base prompt plus user prompt      |
| InputBar             | DatabaseService, chat history                          |
| ModelStore (context) | SettingsStore, settings persistence                    |
|                      | ModelConnectionManager, health polling                 |
|                      | LMSDaemonManager, `lms` CLI lifecycle                  |

All heavy work runs in the Electron main process: PDF parsing, database writes, Python rendering, and LM Studio API calls. The renderer is presentational and communicates exclusively through typed IPC channels exposed via `contextBridge`.

---

## Debugging a packaged build

Electron swallows stdout in the packaged `.app`, so launch from Terminal to see logs:

```bash
/Applications/"Desktop Intelligence.app"/Contents/MacOS/"Desktop Intelligence"
```

Sentinel log lines to watch for:

| Log prefix                           | Meaning                             |
| ------------------------------------ | ----------------------------------- |
| `[FileProcessor]`                    | File received and being processed   |
| `PDF-PARSE EXTRACTED CHARACTERS:`    | PDF text extraction succeeded       |
| `[RAG] ingestDocument`               | Document being written to SQLite    |
| `VECTOR DB RESULTS COUNT:`           | RAG retrieval result count          |
| `FINAL LM STUDIO PAYLOAD:`           | Full JSON sent to LM Studio         |
| `[Python] matplotlib render OK`      | Chart rendered successfully         |
| `[Settings] Reload complete`         | Model reloaded with new settings    |

---

Version 3.2.91. Built with [Claude Code](https://claude.ai/claude-code).
