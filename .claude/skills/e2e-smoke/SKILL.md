---
name: e2e-smoke
description: Run the manual end-to-end smoke checks on the real Electron app (tool calls on LM Studio / OpenRouter / Ollama / MTPLX, Stop mid-stream, indexed PDF chat, PDF export, new chat, LM Studio reload, first-launch flow, packaged [DEV] build) by driving it over CDP with scripts/e2e/di.mjs. Use when asked to "run the e2e checks", "smoke test the app", "run the manual checklist", or to verify a change in the running app with a given provider.
---

# e2e-smoke

You drive the real app with one CLI. Run everything from the repo root.

```
D=scripts/e2e/di.mjs        # always invoke as: node scripts/e2e/di.mjs <command>
```

## Rules

- Write nothing to the app source. This skill only observes. If a check fails, report it with evidence, don't fix it.
- Never print, echo or `cat` `.env.e2e.local`; it holds API keys. To type a key into the UI, use `type "<css>" --env VAR`.
- Run one check at a time. Each check starts with `launch`, which replaces any running instance, and ends when you have the evidence.
- Every check needs evidence: a screenshot path and/or the exact log or state lines. Look at each screenshot with the Read tool before you call a check PASS.
- If a command errors, read the message: `click` lists the visible candidates on a miss. Retry at most twice with a corrected label, then mark the check BLOCKED with the error and move on.
- A provider whose lines in `.env.e2e.local` are empty makes `launch` stop with `… is empty`. That is SKIPPED, not FAIL.
- When you finish, or if you stop early, run `node scripts/e2e/di.mjs stop`.

## Setup (once)

1. `.env.e2e.local` must exist (the user creates it from `.env.e2e.example`). If it is missing, stop and ask for it.
2. LM Studio checks need LM Studio running: `curl -s -m 3 http://localhost:1234/v1/models`. MTPLX checks need MTPLX at its `MTPLX_BASE_URL`.
3. `launch` rebuilds native modules for Electron itself (about 20 s). After the run, `npm test` rebuilds them for Node again, which is expected.

## Driver reference

| Command | What it does |
|---|---|
| `launch <lmstudio\|openrouter\|ollama\|mtplx\|nvidia>` | Fresh throwaway profile seeded with that provider's keys and model, starts `electron-vite dev`, waits for the window, prints `state` |
| `launch --fresh` | Empty profile: the app opens on the first-launch modal |
| `launch <provider> --packaged "<path>.app"` | Same, using a packaged app instead of dev |
| `state` | JSON: `streaming`, `sendEnabled`, `alerts` (error banners), `dialogs` (modal text), `chatTail` (last 1500 chars of the chat) |
| `send "<msg>"` | Types into the composer and presses Enter |
| `wait-streaming [s]` / `wait-idle [s]` | Waits for the Stop button to appear, or for the stream to finish (`wait-idle` prints `state`) |
| `wait-text "<text>" [s]` | Waits until the text is anywhere on screen |
| `click "<label>"` | Clicks by aria-label, title or visible text (an exact match is preferred) |
| `type "<css>" "<text>"` / `type "<css>" --env VAR` | Types into a field |
| `key Enter\|Escape\|Tab` | Presses a key |
| `attach <file>` | Puts a file into the composer's file input |
| `screenshot [path]` | Saves a PNG and prints its path; read it with the Read tool |
| `stub-save-dialog [path]` | Makes native save dialogs return `path` without showing (default `/tmp/di-e2e/export.pdf`) |
| `log "<substring>" [n]` | Last n main-process log lines containing the substring (`/tmp/di-e2e/app.log`) |
| `eval "<js>"` / `main-eval "<js>"` | Evaluates JS in the renderer, or in the main process with `require` available |
| `stop` | Kills the app |

Useful log markers: `FINAL` (the payload sent to the provider), `[Routing]`, `VECTOR DB RESULTS COUNT`, `[RAG]`, `[Settings]`, `[Chat] chatService.send() threw`.

## Checks

### 1. Tool call per provider: run once each for `lmstudio`, `openrouter`, `ollama`, `mtplx`
```
node scripts/e2e/di.mjs launch <provider>
node scripts/e2e/di.mjs send "Use the get_ticker_price tool to get the current price of AAPL, then tell me the price in one sentence."
node scripts/e2e/di.mjs wait-idle 240
node scripts/e2e/di.mjs screenshot /tmp/di-e2e/1-<provider>.png
node scripts/e2e/di.mjs log "ticker" 10
```
PASS when `alerts` is empty, `chatTail` has an answer with a dollar price for AAPL, and the screenshot shows the tool pill/notification above the answer. FAIL on an error banner, an empty answer, a raw tool-call JSON/XML blob in the answer, or `wait-idle` timing out.

### 2. Stop mid-stream (use `lmstudio`, or any provider that is set up)
```
node scripts/e2e/di.mjs launch lmstudio
node scripts/e2e/di.mjs send "Write a 1500-word essay on the history of the printing press."
node scripts/e2e/di.mjs wait-streaming 60
node scripts/e2e/di.mjs click "Stop generating"
node scripts/e2e/di.mjs wait-idle 30
node scripts/e2e/di.mjs send "Reply with just the word OK."
node scripts/e2e/di.mjs wait-idle 120
```
PASS when the first `wait-idle` returns within about 5 s with a partial essay in `chatTail`, and the follow-up message gets an answer, which shows the app recovered. FAIL if it keeps streaming, the partial text vanishes, or the follow-up errors.

### 3. Chat with an indexed PDF
Use a real multi-page PDF that is large enough to be indexed rather than inlined (a paper or manual of 20+ pages). Ask the user for one if none is at hand. Pick a fact from page 5 or later that you can check.
```
node scripts/e2e/di.mjs launch lmstudio
node scripts/e2e/di.mjs attach "<path/to/doc.pdf>"
node scripts/e2e/di.mjs send "According to this document, <question whose answer you know>?"
node scripts/e2e/di.mjs wait-idle 300
node scripts/e2e/di.mjs log "VECTOR DB RESULTS COUNT" 5
node scripts/e2e/di.mjs log "[Routing]" 5
```
PASS when `[Routing] … hasDocuments=true`, the results count is above 0 (or the log shows `[RAG] CONTEXT ENVELOPE READY`), and the answer contains the correct fact. FAIL if the answer is invented, comes from web search, or says it can only see the filename.

### 4. PDF export (run right after check 1, 2 or 3 so there is a chat)
```
node scripts/e2e/di.mjs stub-save-dialog /tmp/di-e2e/export.pdf
node scripts/e2e/di.mjs click "Download chat as PDF"
```
Then poll for up to 60 s until `/tmp/di-e2e/export.pdf` exists and has stopped growing (`ls -l` twice, 3 s apart). Inspect it with `pdftotext /tmp/di-e2e/export.pdf - | head -50` if that is installed; otherwise Read the PDF. PASS when the file contains the whole conversation, both the user message and the full answer, not just the first screen. FAIL if there is no file or the content is truncated.

### 5. New chat and first message
```
node scripts/e2e/di.mjs launch lmstudio
node scripts/e2e/di.mjs send "Say hello in five words."
node scripts/e2e/di.mjs wait-idle 120
node scripts/e2e/di.mjs eval "document.querySelector('[data-testid=sidebar-panel]')?.innerText.slice(0, 400)"
```
Then start a second chat: `click "New"` (the sidebar's "+ New" button; if the match is ambiguous, use the listed labels), `send "Second chat, say hi."`, `wait-idle 120`. PASS when both chats appear as separate entries in the sidebar, both answers rendered, and `alerts` is empty.

### 6. Settings → reload a model on LM Studio
```
node scripts/e2e/di.mjs launch lmstudio
node scripts/e2e/di.mjs click "Settings"
node scripts/e2e/di.mjs screenshot /tmp/di-e2e/6-settings.png
```
Read the screenshot. On the Model tab, change the context length to a different preset and click the reload/apply button; `click` with a guess lists the real labels. Then:
```
node scripts/e2e/di.mjs log "[Settings]" 20
```
PASS when the log shows `Running: lms unload --all`, `Running: lms load …--context-length <new value>` and `✅ Reload complete`, and after you close settings `send "Reply OK."` + `wait-idle` gets an answer. FAIL on `reload error`, `Failed to unload` or a stuck "reloading" state. This really reloads the model in LM Studio, which is expected.

### 7. First-launch flow
```
node scripts/e2e/di.mjs launch --fresh
node scripts/e2e/di.mjs click "OpenRouter"
node scripts/e2e/di.mjs type "input[placeholder='sk-or-…']" --env OPENROUTER_API_KEY
node scripts/e2e/di.mjs click "Save & Connect"
node scripts/e2e/di.mjs wait-idle 20
node scripts/e2e/di.mjs state
```
PASS when `dialogs` no longer shows "Welcome to Desktop Intelligence" and `send "Reply OK."` + `wait-idle 120` gets an answer. If `OPENROUTER_API_KEY` is empty, do the same with "LM Studio" instead: pick the model in the modal, then Save & Connect.

### 8. Packaged [DEV] build
Build it (this takes several minutes):
```
export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v anaconda | paste -sd: -)"
npm run package:dev
ls -d dist/mac-arm64/*.app
```
Then repeat check 1 against it with `launch lmstudio --packaged "<that .app path>"`. PASS when the window opens and the tool-call check passes. If `launch` times out, check `log "" 60` for a native-module or ERR_REQUIRE_ESM crash and report it. If `stub-save-dialog`/`main-eval` fail here, the packaged app has the Node inspector fused off: note it, but don't count it as a failure.

## Report

Finish with one table, then the details for anything not PASS:

| # | Check | Provider | Result | Evidence |
|---|---|---|---|---|
| 1 | Tool call | lmstudio | PASS / FAIL / SKIPPED / BLOCKED | screenshot path, key log line |

For each FAIL or BLOCKED, give the exact command, its output, the `state` JSON, and the relevant `log` lines. Say what you saw, not what you think caused it.
