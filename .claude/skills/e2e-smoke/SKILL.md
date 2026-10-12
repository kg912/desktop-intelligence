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
- Launch with plain `node scripts/e2e/di.mjs launch` (no provider). It runs what `npm run dev` runs, on the user's own profile, so it uses whatever provider, model and API keys the user already configured. Never ask the user for keys. The test chats land in the user's real chat history; that is expected.
- **Stop at the first failure.** If any command errors, `launch` fails, or a check is FAIL or BLOCKED, run `node scripts/e2e/di.mjs stop` right away, skip every remaining check, and report what you have.
- Never print, echo or `cat` `.env.e2e.local` or the app's `app-settings.json`; they hold API keys.
- Run one check at a time. Each check starts with `launch`, which replaces any running instance, and ends when you have the evidence.
- Every check needs evidence: a screenshot path and/or the exact log or state lines. Look at each screenshot with the Read tool before you call a check PASS.
- One exception to stopping: when `click` misses, it lists the visible candidates. Retry once with a corrected label before you call it BLOCKED.
- If `launch` says `npm run dev` is already running, stop and tell the user to quit it. Don't kill it yourself.
- When you finish, or if you stop early, run `node scripts/e2e/di.mjs stop`.

## Setup (once)

1. After the first `launch`, note the provider and model. Checks run on that provider only. Print only these two fields, never the whole settings file:
   ```
   node scripts/e2e/di.mjs main-eval "(({backendProvider, modelId}) => ({backendProvider, modelId}))(JSON.parse(require('fs').readFileSync(require('electron').app.getPath('userData') + '/app-settings.json', 'utf8')))"
   ```
2. Checks marked *LM Studio only* need `backendProvider` to be LM Studio and LM Studio running (`curl -s -m 3 http://localhost:1234/v1/models`). Otherwise mark them SKIPPED. A skip is not a failure.
3. `launch` rebuilds native modules for Electron itself (about 20 s). After the run, `npm test` rebuilds them for Node again, which is expected.

## Driver reference

| Command | What it does |
|---|---|
| `launch` | The user's own profile and settings, same as `npm run dev`. **Use this.** |
| `launch <lmstudio\|openrouter\|ollama\|mtplx\|nvidia>` | Only if the user asks and `.env.e2e.local` exists: fresh throwaway profile seeded with that provider's keys and model, starts `electron-vite dev`, waits for the window, prints `state` |
| `launch --fresh` | Empty throwaway profile: the app opens on the first-launch modal |
| `launch --packaged "<path>.app"` | Same, using a packaged app instead of dev (its own profile) |
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

### 1. Tool call on the configured provider
```
node scripts/e2e/di.mjs launch
node scripts/e2e/di.mjs send "Use the get_ticker_price tool to get the current price of AAPL, then tell me the price in one sentence."
node scripts/e2e/di.mjs wait-idle 240
node scripts/e2e/di.mjs screenshot /tmp/di-e2e/1-tool.png
node scripts/e2e/di.mjs log "ticker" 10
```
PASS when `alerts` is empty, `chatTail` has an answer with a dollar price for AAPL, and the screenshot shows the tool pill/notification above the answer. FAIL on an error banner, an empty answer, a raw tool-call JSON/XML blob in the answer, or `wait-idle` timing out.

### 2. Stop mid-stream
```
node scripts/e2e/di.mjs launch
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
node scripts/e2e/di.mjs launch
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
node scripts/e2e/di.mjs launch
node scripts/e2e/di.mjs send "Say hello in five words."
node scripts/e2e/di.mjs wait-idle 120
node scripts/e2e/di.mjs eval "document.querySelector('[data-testid=sidebar-panel]')?.innerText.slice(0, 400)"
```
Then start a second chat: `click "New"` (the sidebar's "+ New" button; if the match is ambiguous, use the listed labels), `send "Second chat, say hi."`, `wait-idle 120`. PASS when both chats appear as separate entries in the sidebar, both answers rendered, and `alerts` is empty.

### 6. Settings → reload a model (LM Studio only)
```
node scripts/e2e/di.mjs launch
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
PASS when `dialogs` no longer shows "Welcome to Desktop Intelligence" and `send "Reply OK."` + `wait-idle 120` gets an answer. This check uses a throwaway profile, so it needs a key from `.env.e2e.local`. If that file is missing, use "LM Studio" in the modal instead (pick the model, then Save & Connect) when LM Studio is running; otherwise mark it SKIPPED.

### 8. Packaged [DEV] build
Build it (this takes several minutes):
```
export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v anaconda | paste -sd: -)"
npm run package:dev
ls -d dist/mac-arm64/*.app
```
Then repeat check 1 against it with `launch --packaged "<that .app path>"`. It uses the [DEV] app's own profile, which may have a different provider configured. PASS when the window opens and the tool-call check passes. If `launch` times out, check `log "" 60` for a native-module or ERR_REQUIRE_ESM crash and report it. If `stub-save-dialog`/`main-eval` fail here, the packaged app has the Node inspector fused off: note it, but don't count it as a failure.

## Report

Finish with one table, then the details for anything not PASS:

| # | Check | Provider | Result | Evidence |
|---|---|---|---|---|
| 1 | Tool call | openrouter | PASS / FAIL / SKIPPED / BLOCKED / NOT RUN | screenshot path, key log line |

Checks after the first failure are NOT RUN.

For each FAIL or BLOCKED, give the exact command, its output, the `state` JSON, and the relevant `log` lines. Say what you saw, not what you think caused it.
