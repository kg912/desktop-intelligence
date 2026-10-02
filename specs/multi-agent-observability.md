# Multi-agent observability: end-to-end call logs

Status: draft for `/goal`. Scope: Desktop Intelligence multi-agent runs (OpenRouter, Python sidecar on localhost:7823).

## 0. Why this exists

A multi-agent run is one planner call, N worker calls (parallel, with tool rounds), one reflection call per worker attempt, retries, and one synthesis call. Today you can see the run in the UI, but you cannot answer, after the fact:

- Which model was called at each step, and was it the model in settings or a fallback?
- What exact messages, system prompt and parameters were sent?
- What did the model return, raw, before any parsing, stripping or truncation?
- What did each tool receive and return, in full?
- Where did the time and the money go, per call?

This spec adds a per-run, per-call log that answers those, inside the existing observability section.

## 1. Current state (audit baseline, to be verified, not assumed)

What exists, from reading the code:

- `ObservabilityService.emitMultiAgentEvent(chatId, event)` appends one JSON line per UI `AgentEvent` to a single global file, `observability-logs/multi-agent-events.jsonl`. Wired from `src/main/index.ts` through the coordinator's `observe` dependency (`MultiAgentRunCoordinator.ts`, near the `this.deps.observe(run.chatId, event)` call).
- It returns early unless `isEnabled()` is true. The setting is `observabilityEnabled`, default **false**. If the toggle is off, nothing is written. This alone may explain "no entry for the last run". Phase 0 must confirm it.
- The Debug panel shows `listMultiAgentEvents()` sliced to 25 one-line rows. Multi-agent runs do not appear in the per-session log list that single chats use (no `startSession` / `endSession`, no meta file, no markdown).
- The sidecar writes almost nothing of its own (a few `[plan]` lines to stderr).

What it does not record, because it only sees UI events:

- messages and system prompts per model call, request parameters (temperature, max_tokens, reasoning, tools)
- raw model output, `finish_reason`, usage, cost, OpenRouter generation id
- per-call latency (start, first token, end)
- planner raw output, parse retries, chain correction exchange
- reflection prompt and raw verdict
- the synthesis prompt (all agent outputs combined)
- full tool arguments and results (UI shows previews only)

Items I did not verify and Phase 0 must settle: whether token events are coalesced before logging; what `agentEventStepType` maps each event to; whether ordering in `listMultiAgentEvents` (`slice(-limit).reverse()`) is correct for the Debug panel; whether the log covers every event type the UI receives.

## 2. Principles

1. Record what was actually sent and received, at the point where it is sent and received. Only the sidecar sees real payloads, so capture there.
2. Never reconstruct. A log line is written from the object passed to the HTTP client, not rebuilt afterwards.
3. Off by default, behind the existing `observabilityEnabled` toggle. Prompts and outputs contain private chat and tool content.
4. Never log credentials: the OpenRouter key, Brave key, `Authorization` headers, MCP env values.
5. Truncation is explicit. If anything is cut, the record says so with original length.
6. A logger failure must never fail or slow a run.

## 3. Capture design

### 3.1 Sidecar call recorder

Add a `CallRecorder` in `resources/python/multi_agent_sidecar.py` used by `ask()` and `_stream_openrouter`. One record per model call, written when the call ends (success, error or cancel):

```
{
  "schema": 1,
  "runId", "chatId", "seq",            // seq is a per-run monotonic counter
  "role": "planner|worker|reflection|synthesis",
  "agentId": "1.2" | null,
  "attempt": 1,
  "toolRound": 0,                       // worker tool loop index
  "model": "<requested>",
  "modelServed": "<from response, if provided>",
  "request": { "messages": [...], "params": {temperature, max_tokens, reasoning, tools, tool_choice, ...} },
  "response": {
    "content": "<raw, concatenated stream>",
    "reasoning": "<raw reasoning stream>",
    "toolCalls": [{ "id", "name", "arguments": "<raw string>" }],
    "finishReason": "stop|length|tool_calls|error|cancelled"
  },
  "usage": { "promptTokens", "completionTokens", "reasoningTokens", "costUsd", "generationId" },
  "timing": { "startedAt", "firstTokenAt", "endedAt", "ms" },
  "error": { "kind", "message", "httpStatus" } | null,
  "truncated": { "field": "response.content", "originalChars": 0 } | null
}
```

Tool executions are separate records of `kind: "tool"` with `agentId`, `toolRound`, `name`, `args` (full), `result` (full or capped with marker), `ms`, `approved`/`denied`, `error`. Reflection and planner retries are separate records; nothing is overwritten.

### 3.2 Transport

The sidecar emits records to Electron over the existing SSE channel as a new event class `obs_record`, which the coordinator routes to the observability writer and never to the renderer or the `AgentEvent` union. If the toggle is off, Electron sends `observe: false` in the run start request and the sidecar skips recording entirely (no memory held, no payload copied).

### 3.3 Electron writer

New `MultiAgentRunLogger` inside `ObservabilityService`. It owns the directory layout in section 4, writes each record as it arrives (append-only JSONL), and renders the markdown files when a run ends. If the app crashes mid-run, JSONL is still valid and `run.meta.json` shows `status: "incomplete"`.

## 4. File layout

One directory per run:

```
observability-logs/multi-agent/<chatId>/<runId>/
  run.md                      index and flow (read this first)
  run.meta.json               machine-readable version of the index
  planner.md / planner.jsonl
  agent-1.1.md / agent-1.1.jsonl      one pair per agent, all attempts and tool rounds inside
  agent-1.2.md / agent-1.2.jsonl
  synthesis.md / synthesis.jsonl
  events.jsonl                the UI AgentEvents for this run (replaces the global file for new runs)
```

`run.md` contains, in order:

1. Header: chat title, run id, started/ended, status, trigger user message.
2. Config snapshot: the real `run_config`: model per role, source of each (`saved`, `follows active`, `fallback`), budget, thresholds, tool permissions.
3. Plan: phases and `dependsOn` as a table, plus a Mermaid flow diagram.
4. Timeline: one row per call with start offset, duration, model, role, agent, attempt, tokens, cost, finish reason, and a link to the exact section in the agent file. Overlapping rows show parallelism; peak concurrency is computed from these timestamps, not from the UI.
5. Per-agent summary: attempts, reflection scores and issues, `failureKind`, tools used.
6. Totals: cost and tokens by role and by model; reconciled against the sum of call records (a mismatch is printed as a warning).
7. Anomalies: finish reason `length`, fallback model used, repetition guard fired, retries, errors, denied tools.

Each `agent-*.md` has one section per attempt: the messages sent (system prompt, task, upstream context handed in), request params, reasoning, raw output, each tool round with args and result, then the reflection call for that attempt: its prompt, raw verdict, parsed score and issues. `synthesis.md` shows the full synthesis prompt, including every agent output as received, the raw final answer, and finish reason. Long fields in markdown are collapsed in `<details>`; the JSONL always holds the full text.

Retention: keep the latest 50 run directories (setting), delete oldest first, never while a run is active. Per-field cap 2 MB with the truncation marker. Directory names use ids only, never chat titles.

## 5. UI (Settings → Debug)

- New section "Multi-agent runs" above the old event list: one row per run (time, chat title, status, models by role, cost, duration, anomaly count). Dark language: `#0a0a0a` surfaces, 0.5px hairlines, JetBrains Mono for ids and models, no white controls.
- Row actions: Open `run.md`, Reveal folder, Copy run id, Delete.
- Detail view: the flow (plan graph, timeline bars) with each call linking to its file. Read-only.
- The old 25-row list becomes "Raw UI events" for the selected run, with paging, correct newest-first ordering.
- If observability is off, the section says so in plain words and offers the toggle. A run that started while off is shown as "not recorded", never silently absent.
- Ship a mockup in `/designs/04-observability.html` first, then build.

## 6. Phases

Standing rules: do not edit `ChatService.ts`; commit per phase without pushing; `progress.md` append-only; tests additive; bump version once at the end; no numbers hand-written into docs (generate from data); docs employer-neutral.

**Phase 0: Audit the existing logger.** Write tests and a short `docs/observability-audit.md` that confirm or refute each claim: gating by `observabilityEnabled`; what is written when off and on; whether every `AgentEvent` type reaches the file; token event coalescing; `stepType` mapping; ordering and the 25-row slice; that a run with the toggle on produces a file entry. Fix defects found. Acceptance: each claim has a passing test that would fail if the claim were false.

**Phase 1: Call recorder in the sidecar.** Implement `CallRecorder`, wrap planner, worker (including tool rounds), reflection and synthesis calls, plus tool records. Redact headers. Acceptance: with a fake OpenRouter server (reuse the one in `MultiAgentSidecar.integration.test.ts`), the recorded `request.messages` and `params` byte-equal what the fake server received, and `response.content` equals what it streamed.

**Phase 2: Transport and writer.** `obs_record` routing, `MultiAgentRunLogger`, directory layout, markdown rendering, `run.meta.json`, retention, `observe: false` path. Acceptance: a full fake run produces the section 4 tree; killing the process mid-run leaves valid JSONL and `status: "incomplete"`; with the toggle off, no files and no sidecar capture.

**Phase 3: Reconciliation and anomalies.** Totals reconciled with call records; anomaly detection (length finish, fallback, repetition, retries, denials). Acceptance: seeded fault tests (forced `length`, forced fallback, forced retry) each appear in `run.md` anomalies.

**Phase 4: UI.** Mockup, then Debug section as in section 5. Acceptance: screenshots of list, detail and off state; open/reveal/delete work; typecheck and tests green.

**Phase 5: Verification.** The audit repeated end to end: one scripted run, then a checker that opens the files and asserts, for every call listed in the timeline, that a record exists with non-empty request and response, that agent files link to existing anchors, and that costs reconcile. Leaks check: grep the whole log tree for the test API keys; must find none.

**Phase 6: Docs and close-out.** `docs/observability.md` describing the layout and how to read a run; spec addendum; `progress.md` entry; version bump.

## 7. Interaction with the evals and memory spec

`specs/multi-agent-evals-and-memory.md` mines `multi_agent_runs` for traces. Run this spec first: its Phase 0 audit and call records give the miner real prompts and raw outputs, and `run.meta.json` can feed `summariseRun`. Keep one definition of `failureKind` and `truncated`; do not fork them. The opt-in LangSmith hook in that spec must stay opt-in and must not read the log tree unless the user enables it.

## 8. Out of scope

Cloud log shipping, live streaming of raw prompts into the main chat, single-chat observability changes, and any change to what is shown in the sidebar dock.

## 9. Done when

- A run with observability on produces the directory tree, and every model call and tool call in it appears with request, raw response, usage, timing.
- Asking "which model answered the synthesis, with what prompt, and what did it return" is answered by opening `synthesis.md`.
- With observability off, nothing is written or captured, and the UI says so.
- Phase 0 tests exist for every claim the old logger made.
- No credentials in any log file; verified by test.

## 10. Addendum: as implemented

Phases 0 to 6 are done. Where the build departs from the text above, the reason is recorded here. Usage is described in `docs/observability.md`, and the Phase 0 findings are in `docs/observability-audit.md`.

- **"Fallback" (§4 item 7, Phase 3).** The code has no model fallback: refinement Phase 3 made a model missing from the catalogue stop the run. As agreed during implementation, a "fallback" anomaly now means one of two things: (a) OpenRouter served a different model than the one requested (`served_model_differs`; a dated variant of the same id does not count), or (b) the planner never produced a usable plan and the built-in plan ran (`fallback_plan`, from the new optional `orchestrator_plan.fallback`).
- **Model sources (§4 item 2).** `run.md` shows the sources the code actually records: `saved`, `default` and `active`. It does not use the names "follows active" or "fallback".
- **`truncated` vs `capped`.** `truncated` keeps its one existing meaning: the limit (`budget` or `context`) that ended a `length` finish. It appears on `response.truncated` in records and on the UI events. A field cut in the log is listed in a separate `capped` array, with its path and original length, so the two meanings cannot be confused.
- **`attempt` is 0-based**, as it is in the UI events. Planner and reviewer re-asks are separate records, with `attempt` and `retry` respectively.
- **Recording covers a whole run or none of it.** The toggle is read once, when the run starts, and that decision applies to the whole run. A run started while observability was off is listed as "not recorded" (rows come from the run history table).
- **`failureKind`** is not added here. It belongs to `specs/multi-agent-evals-and-memory.md`, and that spec should define it once. Until then, the agent summary shows the human-readable failure reason.
- **`events.jsonl`** holds the events as they are persisted, so token events are coalesced. The old global `multi-agent-events.jsonl` is no longer written for new runs but is left in place.
- **Headers** are recorded with `Authorization` replaced by `[redacted]`. In addition, Electron removes every known credential from every line before writing: provider keys, the Brave key, and MCP env values and headers.
- **Audit defects fixed in Phase 0:** event lines were written out of order (concurrent appends), and a logger exception could fail a run.
