# Exa search integration (either/or with Brave)

Status: Phase 1 implemented (Phase 0 results in `specs/research/exa-verification.md`). Mockups: `specs/designs/exa-search-mockups.html` (copy it there; every screen referenced below is a tab in that file).

Read `CLAUDE.md` and `progress.md` before starting. Read `ChatService.ts`, `handlers.ts`, `WorkerBuiltinTools.ts`, `BraveSearchService.ts`, `SettingsStore.ts`, `MCPSettingsPanel.tsx` and `ToolCallNotification.tsx` in full before changing anything. Do not put personal machine paths, usernames or API keys in code, tests, docs or screenshots (the repo is public).

## 1. Goal

Add Exa as a second web search provider. The user picks exactly one provider (Brave or Exa) in Settings > Web Search. Exa exposes four search depths. The chat accordion shows which provider and depth ran. A user-initiated "Deep research" action backed by the Exa Agent API is Phase 2.

Not in scope: running both providers at once, merging results, an Exa MCP server, Exa Websets, Exa Answer.

## 2. Decisions

### 2.1 Full page fetch: not needed for Exa

Brave returns one or two sentence snippets, which is why `augmentAndFormatResults` fetches pages locally. Exa returns page content in the same `/search` response via `contents` (highlights or text), included in the base price for up to 10 results. So for Exa:

- Do not call `augmentAndFormatResults` or `fetchPageText`. No local fetch, no domain skip list, no 5 s fetch budget.
- Request `contents.highlights: true` by default. Offer `contents.text.maxCharacters` (default 3000, matching Brave's current slice) as a user setting.
- Exa has indexed content for domains the Brave skip list gives up on, so the skip list does not apply.
- If a gap appears later (a specific URL the model wants read), add a separate `web_fetch` tool backed by Exa `POST /contents` ($1 per 1,000 pages). Out of scope here.
- `lite` is cache-only: with `text` or `highlights` requested, results with no cached copy are left out. That is acceptable for Fast; use Balanced or deeper for freshness-critical queries.

Brave behaviour stays exactly as it is today.

### 2.2 Modes (verified against Exa docs on 2026-11-06)

Exa's current `type` values are `lite`, `auto` (default), `deep-lite`, `deep`. `fast`, `instant` and `deep-reasoning` still work but are documented as legacy. There is no `deep-research` search type. Exa's long-running research product is the separate Agent API (section 6).

| DI label | `type` | Latency | Price per 1k requests | Notes |
|---|---|---|---|---|
| Fast | `lite` | ~450 ms | $4 | Cache only. Rejects `outputSchema`, `systemPrompt`, `stream`, `additionalQueries`, `contents.summary`, `contents.maxAgeHours`, `contents.livecrawl*` with `400 INVALID_REQUEST_BODY` |
| Balanced (default) | `auto` | ~1 s | $7 | Supports freshness and synthesis |
| Deep-lite | `deep-lite` | ~3-4 s | $12 | Query expansion and synthesis |
| Deep | `deep` | 4-15 s | $12 | Iterative search, evidence checking |

Results above 10 cost $1 per 1,000 results. DI caps `numResults` at 10, so this never applies. Use `lite` instead of legacy `instant`/`fast`.

### 2.3 Deep modes and synthesis

For `deep-lite` and `deep`, send `outputSchema: { type: "text", description: "Concise evidence brief: key facts, figures and dates" }`. Return the brief to the model in the tool result, labelled `Exa synthesis (verify against sources)`, followed by the numbered sources. Phase 0 found that the `[n]` markers in `output.content` index `output.grounding[0].citations`, not `results`, and `deep` cites more pages than it returns; so the brief is followed by its own `Brief sources: [n] title url` list before the numbered results. For `lite` and `auto`, send no `outputSchema`. Do not use object schemas (10 property and 2 level limits, and DI does not need them).

Deep modes cap effective search rounds at 2 regardless of `maxSearchLoops`, because each round can take up to 15 s.

### 2.4 Deep research (Exa Agent): worth building, Phase 2, user-initiated only

Worth building because it gives DI a cloud research handoff that works with any DI backend, and the report returns citations the active model can reuse in follow-ups. Constraints:

- Never exposed to the model as an auto-callable tool. A small local model could spend up to the default $5 (`auto`) or $20 (`ultra`) cap on its own. Only a user action starts a run, behind a confirmation card showing effort and cost.
- Runs are async (minutes), billed per run, so the run ID is persisted on the chat and the run survives app restarts.
- Agent limits: 5 QPS and 50 active runs per team; starting a run counts as two requests.

Details in section 6. Ship Phase 1 first.

## 3. Phase 0: verify before coding

Per the repo's test-before-implement rule, run these with a real key (use an environment variable, never commit the key) and record results in `specs/research/exa-verification.md`:

1. `POST https://api.exa.ai/search` with `type` = `lite`, `auto`, `deep-lite`, `deep`, each with `contents.highlights: true`. Record response shape, `searchTime`, `costDollars`.
2. Same with `contents.text.maxCharacters: 3000`.
3. `lite` with `outputSchema` and with `contents.maxAgeHours: 24`; confirm the 400 body and `tag`.
4. `deep` with `outputSchema: {type:"text"}`; confirm `output.content` and `output.grounding` shapes.
5. Response `notices` and `warnings` arrays: capture a real example if one can be triggered.
6. Error bodies for a bad key (401 expected) and exhausted credits (402 documented as Payment Required); confirm the JSON error fields for the error mapper. Observed: `{ requestId, error, tag }`; bad key is `401 INVALID_API_KEY`; a missing key is `402 X402_PAYMENT_REQUIRED` (exhausted credits could not be triggered). `resolvedSearchType` came back empty for every type, so DI records the type it sent.
7. Auth header: `x-api-key` and `Authorization: Bearer` both documented; use `x-api-key`.
8. Phase 2 only: Agent run create, poll, SSE stream, and whether a cancel endpoint exists (not confirmed in the docs read so far).

Where a fact above is not verified by these calls, prefer the observed behaviour and update this spec.

## 4. Settings and types

Add to `AppSettings` (`SettingsStore.ts`) and shared types; keep existing Brave fields untouched so old settings files keep working:

```
webSearchProvider?: 'brave' | 'exa'      // default 'brave'
exaApiKey?: string
exaSearchType?: 'lite' | 'auto' | 'deep-lite' | 'deep'   // default 'auto'
exaContentMode?: 'highlights' | 'text'   // default 'highlights'
exaMaxCharacters?: number                // default 3000, range 1000-10000, text mode only
exaNumResults?: number                   // default 5, range 3-10
exaFreshness?: 'default' | '24h' | 'always'  // default 'default'; ignored for lite
```

Existing `braveSearchEnabled` remains the master enable flag (its meaning becomes "web search enabled"; do not rename, to avoid a migration). Add helper `isWebSearchReady()`: enabled and the selected provider has a non-empty key. `braveWorkerTools.getToolSchemas()` and the single-chat path both go through it.

IPC: extend `mcpGetSettings` / `mcpSaveSettings` payloads with the new fields. Validate and clamp on save in the main process (type must be one of the four values, numbers clamped to range).

## 5. Provider layer

New `src/main/services/search/` with:

- `SearchProvider.ts`: `search(query, opts: { objective?, signal }) => Promise<NormalizedSearch>` where `NormalizedSearch = { provider, mode?, results: { title, url, body, publishedDate? }[], synthesis?: { text, grounding? }, notices?, costDollars?, searchTimeMs }`.
- `BraveProvider.ts`: wraps the existing `braveSearch` and `augmentAndFormatResults` unchanged in behaviour.
- `ExaProvider.ts`: raw `fetch` to `https://api.exa.ai/search` (no new dependency). Uses `AbortController` with per-mode timeouts: lite 5 s, auto 10 s, deep-lite 12 s, deep 30 s. Also aborts when the user stops generation.
- `buildExaRequest(settings, query, objective)`: a pure function, the single place that knows which parameters each type allows (table in 2.2). It must never emit a parameter `lite` rejects.
- `formatForModel(normalized)`: numbered results in the same `[n] title\nurl\nbody` shape the model sees today, preceded by the synthesis block for deep modes and followed by any `notices` text. Strip EOS tokens (`EOS_TOKENS_RE`) from every body, and keep the existing `handlers.ts` sanitising of tool message content. Apply the provider-specific truncation limits already in `ChatService` (Ollama 12K, NVIDIA/OpenRouter 50K, LM Studio none).
- Error mapper: non-2xx responses become `Exa API error <status>: <message>`; 401 and 402 get actionable text (check key; add credits). `warnings` are logged, `notices` go to the model.

Tool wiring (find every reference first; `brave_web_search` is hardcoded in several places):

- Model-facing tool name becomes `web_search` for both providers. Keep `brave_web_search` accepted everywhere as a legacy alias: `validToolNames`, `resolveIsWebSearch` in `ToolCallNotification.tsx` (old persisted blocks carry `toolName: "brave_web_search"`), observability events, and the worker tool `builtin__brave_web_search` (check whether the Python sidecar routes on that exact name; if so add `builtin__web_search` there and keep the old one).
- `validToolNames` must stay in sync with the surviving tools. `tool_choice` must stay unset when the tool list is empty.
- Tool args: `query` (required) and `objective` (optional string, one short sentence, Exa only). The extra field adds tokens, so keep its description under 20 words and omit it from lite-mode (MTPLX) tool schemas.
- Tool start/done/error stream events (`CHAT_STREAM_TOOL_START/DONE/ERROR`) gain optional `provider`, `mode`, `searchTimeMs`, `costDollars`, `synthesis`. Persisted `MessageBlock`s gain the same optional fields; blocks without them render exactly as today.
- `braveWorkerTools` is generalised to `webSearchWorkerTools` using `isWebSearchReady()` and the selected provider.
- Max search rounds: effective rounds = `min(maxSearchLoops, 2)` when the Exa type is `deep` or `deep-lite`.

## 6. UI

Follow the design language in the mockups (they reuse the existing tokens: `#0a0a0a`, red accent, hairline borders, Inter and JetBrains Mono, 13px mono chrome).

Settings > Web Search (`MCPSettingsPanel.tsx`, mockup tab 1):

- Provider segmented control (Brave | Exa) inside the existing card. Only the selected provider's pane shows.
- Exa pane: API key (password field with Show), search depth radio cards, content mode (Highlights | Full text with max characters slider), results per search, page freshness select (disabled for Fast), request preview (read-only JSON generated by `buildExaRequest`), cost line.
- Shared: max search rounds (with the deep-mode warning), prior search results in context.
- Same dirty-state and Save behaviour as today. No separate "fetch pages" control for Exa.

Chat accordion (`ToolCallNotification.tsx`, mockup tab 2):

- Header: `Searched the web  via  [dot Exa · auto]  >  5 results`. Chip dot colour distinguishes provider; Fast shows `fast`. Legacy blocks show the Brave chip.
- Body: existing query line and result rows, plus for deep modes a synthesis block labelled `EXA SYNTHESIS · VERIFY AGAINST SOURCES`, plus a footer `exa · type auto · 1.3 s · $0.007 · highlights`.
- "Sent to model" disclosure (collapsed): the exact text the model received for this search, for both providers.
- Searching state: existing shimmer `Working` plus provider chip and an elapsed timer.
- Error state: existing red `Search failed` plus chip and the mapped message.

## 6a. Multi-agent mode

Phase 1 (search provider):

- Workers get web search as a native function-calling tool (`builtin__brave_web_search`), run in Electron after the multi-agent permission layers. Generalise `braveWorkerTools` to `webSearchWorkerTools`: offered when `isWebSearchReady()`, executed through the selected provider.
- Before changing it, read the Python sidecar for any hardcoded `builtin__brave_web_search` routing, and for the page-text trimming that always keeps the first body line (the `keepSnippet` contract). Exa has no separate snippet; its body is the highlights, so confirm the trimming still behaves, add `builtin__web_search` with the old name kept as an alias, and add a test.
- Workers never use the deep types. Effective type for workers is `lite` or `auto` (the lower of the selected type and `auto`). Several parallel workers times several rounds each would multiply latency and cost, and deep search is limited to 5 QPS. A "Multi-agent search depth" setting can come later.
- Add a small in-flight limit (for example 4 concurrent Exa requests) in `ExaProvider`, plus one retry with jitter on 429, because workers run in parallel against a 10 QPS base limit.
- Pass `costDollars` through the tool result event so run logs can total search spend per run (check the observability and cost specs for the right event field).

Phase 2 (deep research):

- The "Deep research" control is hidden in Multi-agent mode, and the Exa Agent is not offered to workers. Multi-agent mode already plans and researches through its own workers.
- Possible later: an Exa Agent step in the plan that the user approves in the plan editor, with its cost shown there. Out of scope for this spec.

## 7. Phase 2: Exa Agent deep research (mockup tab 3)

- Settings: toggle (default off), default effort, per-run budget cap. Confirmation is always required (not configurable).
- Entry point: a "Deep research" control in the input bar, same pattern as `MultiAgentModeButton`.
- Confirmation card: effort choice (`low` $0.025, `medium` $0.10, `high` $0.50 flat; `auto` and `ultra` metered), budget cap for metered efforts via `budget.maxCostDollars`, plain statement that the query is sent to Exa's cloud agent.
- Run lifecycle: `POST /agent/runs`, persist the run ID on the chat row (new nullable SQLite column via the existing migration pattern), stream or poll to completion, replay stored events after a restart. Statuses: queued, running, completed, failed, cancelled. Show an indeterminate bar, elapsed time, live source count and an event log; do not show a fake percentage.
- Completion: render `output.text` with `output.grounding` citations, and cost from `costDollars`. The report is a chat block and stays in context, so follow-up questions use the active model on any backend. A "Rewrite with my model" action asks the active model to restate or tailor the report to the original question.
- Failure: show `error.code` and `error.message`.
- Cancel: implement only if Phase 0 confirms an endpoint; otherwise stop polling and mark the run abandoned locally, and say so in the UI.
- Limits to handle: 429 with `CONCURRENCY_LIMIT_REACHED`, 402 when credits run out.

## 8. Rate limits and credits (docs, 2026-11-06)

- Free tier: $10 in credits at signup, reset to $10 on the first of each calendar month (no rollover, first team only), plus a one-time $10 onboarding bonus that does not expire. No card needed.
- Limits: 10 QPS on `/search`; 5 QPS on deep search types; 5 QPS and 50 active runs on `/agent/runs`; `/contents` 100 QPS. Free and pay-as-you-go share the base limits.
- Out of credits or a key over its budget returns `402`.
- DI should treat 429 as retry-once-after-short-delay, then surface the error. A single-user desktop app is unlikely to approach 10 QPS.

## 8a. Observability: see everything the agents see

Requirement: for every web search, the logs show the question asked, the exact request sent to the provider, the raw response, the exact text the model received, plus cost and timing. Everything follows the existing `observabilityEnabled` toggle (off by default, nothing captured when off). Record from the objects actually sent and received; never reconstruct afterwards.

What already exists: single chats log `tool_call` args and `tool_result` text in the session log; multi-agent runs log tool executions as `kind: "tool"` records with full args and result (`specs/multi-agent-observability.md`). What is missing: the provider request, the raw provider response, per-call timing and cost, and any cap or retry that changed the call.

1. **What the model saw (keep exact).** The captured result must be the final string handed to the model: after Exa formatting, EOS stripping and provider truncation (Ollama 12K and so on). If truncation applied, record `truncated: { originalChars }` explicitly. Verify the capture point in `ChatService` and in the worker tool path.
2. **What the provider returned (new `search_call` record, both providers).**

```
{ schema: 1, provider, requestedType, effectiveType,
  caps: [{ kind: 'worker_depth_cap' | 'deep_round_cap', from, to }],
  request: { url, method, body },            // key header recorded as [redacted]
  status, rawResponse,                        // full JSON as received: results with full highlights/text,
                                              // output, notices, warnings, requestId, resolvedSearchType,
                                              // costDollars, searchTime
  formatted: { chars },                       // size of the string given to the model
  timing: { startedAt, endedAt, ms },
  retries: [{ status, waitMs }], error }
```

   For Brave the same record also lists, per result, the page-fetch outcome (fetched chars, skipped by the domain list, or failed), which is not visible today.
3. **Where it goes.**
   - Single chat: new `ObsEventType` `search_call` and a trace entry pushed in order just before the matching tool result. Rendered in the session log and in `session.md` (raw JSON inside `<details>`).
   - Multi-agent: Electron runs the search, so pass context (`runId`, `agentId`, `toolRound`, tool call id) into `webSearchWorkerTools.call` (check how the coordinator calls it today) and append the record to that agent's JSONL through `MultiAgentRunLogger`, rendered under the matching tool round in `agent-<id>.md`. `run.md` shows search calls in the timeline, adds search spend by provider and type to the totals (from `costDollars`), and lists anomalies: `search_depth_capped`, `search_retry_429`, `search_empty`, `search_notices`, `search_error`. Same all-or-nothing-per-run rule as the rest of that spec.
   - Phase 2 Exa Agent: `observability-logs/exa-agent/<runId>/` with `request.json` (query, effort, budget, system prompt), `events.jsonl` (every stream event verbatim, including source events), `run.json` (final run object: output, grounding, usage, `costDollars`) and `report.md`.
4. **Secrets.** Add `exaApiKey` and the `EXA_API_KEY` environment variable to the secrets list in the `ObservabilityService` constructor (it currently lists the OpenRouter, Brave, NVIDIA and Ollama keys and the Brave env var). Add a test that greps the whole log tree for the test key. Also, `SettingsStore.writeSettings` currently prints the full settings object, API keys included, to the console on every save; redact key fields there as part of this change.
5. **Size.** Raw responses can be large (deep search with full text across 10 results). Single-chat logs keep the existing no-truncation rule; multi-agent logs keep the per-field 2 MB cap with the existing `capped` marker.
6. **What cannot be seen.** The docs do not say deep or deep-lite return Exa's internal query planning. Phase 0 saves a full raw response per type and notes any extra fields; if there are none, the log shows what Exa returns (results, brief, grounding) and `docs/observability.md` says so.
7. **In the chat.** The search accordion gets a collapsed "Sent to model" disclosure showing exactly the string the model received. That string is already in the stream event, so this works without logging (mockup tab 2).

## 9. Tests (additive only; do not change logic or source files inside test-only prompts)

Assert exact values and cover branches:

- `buildExaRequest` for each type: exact JSON body, including that `lite` never contains `outputSchema`, `systemPrompt`, `maxAgeHours` or `summary`; deep types contain the text `outputSchema`; freshness maps to `maxAgeHours` 24 and 0; text mode sets `maxCharacters`; `numResults` clamped to 3-10.
- Response normalisation from recorded Phase 0 fixtures (scrub keys and request IDs): results, `output.content`, `notices`, `costDollars`.
- Error mapper: 401, 402, 429, 400 `INVALID_REQUEST_BODY`, network error, timeout, user abort.
- EOS tokens in highlights are stripped; provider-specific truncation limits apply.
- Settings: defaults, clamping, old settings file without new fields still loads, `isWebSearchReady()` for each provider and key combination.
- Tool wiring: `web_search` and legacy `brave_web_search` both pass `validToolNames`; zero-tool case leaves `tool_choice` unset; deep types cap rounds at 2.
- UI (hitl style): provider switch shows the right pane; Fast disables freshness; request preview matches `buildExaRequest`; accordion renders the provider chip, and a persisted block without `provider` renders as before; deep block shows the synthesis label.
- Worker tools: schema offered only when `isWebSearchReady()`; routes to the selected provider.
- Observability: with the toggle on, a single-chat search writes a `search_call` entry whose request body equals what the fake server received and whose raw response equals what it returned; the logged tool result equals the string passed to the model (including a truncated case with `originalChars`); a multi-agent worker search lands in that agent's JSONL under the right tool round; depth caps and 429 retries appear as anomalies; with the toggle off nothing is written; no log file contains the test key.

## 10. Delivery

Append rows to `progress.md` (append only), bump `package.json` version, commit without pushing. One `/goal` implements Phase 1 end to end; Phase 2 is a separate spec once Phase 1 is verified.

## 11. Risks

- `brave_web_search` is referenced in ChatService, tests, observability and possibly the sidecar. The alias strategy in section 5 avoids breaking persisted chats; verify by loading a chat saved before the change.
- Exa parameter rules may change; `buildExaRequest` plus the recorded fixtures make drift visible.
- Deep modes add seconds per round, which interacts with `forceFinalAnswer` and abort handling; test a cancelled deep search mid-flight.
- Workshop or promotional credits: the billing docs do not describe their expiry or restrictions. Check the dashboard before relying on them.
