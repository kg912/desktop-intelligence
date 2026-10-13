# Multi-Agent Orchestration — How It Works, End to End

**Project:** Desktop Intelligence
**Status:** Phase 1 (Foundation) in progress. Event contract, SQLite migration, IPC surface, and
OpenRouter-gated mode button merged (prompts 1–4); the real sidecar process and the multi-agent
panel UI are still pending.
The full design lives in `specs/MULTI_AGENT_SPEC.html`; this file is the standing, human-readable
companion that tracks **what we're building, why, and what is actually implemented**.
**Purpose of this file:** Kill comprehension debt. Anyone — including future-you — should be
able to read this and understand the whole feature without reverse-engineering the code or
re-reading the spec. Updated at the end of every build phase. Same discipline as
`features/RAG-Implementation-v2.0.md`.

**As of:** `3.0.0-beta-33` — Phase 1 prompt 4 merged: OpenRouter-gated Multi-Agent mode button in InputBar.

---

## 0. The one-paragraph version

Single-model mode runs one inference call, one context window, tool calls in sequence. That
ceilings out on big, multi-step work — a large codebase fills the window before it's all read,
and a model can't adversarially review its own output. Multi-agent mode adds a second process: a
**Python sidecar** that runs a small network of specialist agents in parallel via **LangGraph**,
with a reflection gate between steps and a synthesis pass at the end. The Electron app stays in
charge of everything it already owns — MCP tools, permissions (HITL), the database, the UI. The
sidecar only *reasons and orchestrates*; whenever an agent wants to touch a tool, it pauses and
asks Electron to run it. Backend is **OpenRouter only**, because it's the one provider that lets
a single session route different models to different agent roles. The whole thing is gated behind
a Multi-Agent button that only appears when OpenRouter is the active backend.

---

## 1. Why a sidecar, and why LangGraph

Two honest questions worth answering up front, because both have a real "we could have not done
this" alternative.

**Why a separate Python process and not just TypeScript?** The orchestration topology itself
(orchestrate → fan out → reflect → synthesize) is simple enough that we *could* hand-roll it. The
thing that justifies LangGraph — and therefore Python — is **durable pause/resume**. LangGraph's
`interrupt()` checkpoints the entire run to disk and surfaces a value to the caller; the run
literally cannot advance until you send `Command(resume=...)`. That is exactly the primitive we
need for HITL and for retry loops, and rebuilding it correctly in TypeScript is weeks of work we'd
get subtly wrong.

**Why this matters specifically for us — the current HITL bug.** Our existing single-model HITL
is *not actually blocking*: the approval gate is an in-memory promise, and if you wait long
enough the agent loop moves on on its own, effectively assuming rejection. That's the bug we keep
hitting. With LangGraph the pause is a checkpoint, not a timer — there is no running loop to
"move on," because execution is frozen to disk until an explicit resume arrives. The durable
pause is the headline reason this feature exists in the shape it does.

**What single-model genuinely can't do (the demo target):** "Clone this repo, run the tests,
find the three highest-risk areas, write a prioritized remediation plan." Claude.ai/ChatGPT/Gemini
can't — not for capability reasons but architectural ones (no local FS, no parallel fresh
windows). We can.

---

## 2. Bird's-eye architecture

```
   Electron Main Process (Node/TS)                  Python Sidecar (localhost:7823)
   ─────────────────────────────────                ──────────────────────────────────
   InputBar (multi-agent toggle)                     FastAPI
   MultiAgentPanel (plan pane + lanes)                 POST   /run            task+config → runId
   IPC handlers                                        GET    /run/{id}/stream  SSE: AgentEvent[]
     multi-agent:start ───────────────────────────►   POST   /run/{id}/resume  HITL / tool result
     multi-agent:resume  ◄── tool result / approval    DELETE /run/{id}         abort
     multi-agent:abort                                 GET    /health
     multi-agent:event-stream  ◄── SSE                       │
                                                             ▼
   McpServerManager  ◄───── "run this tool" ───────   LangGraph
     (UNCHANGED — runs the tool,                         orchestrator node  (1×)
      applies existing permission                        worker agents      (N×, asyncio.gather)
      system, returns result) ────────────────────►        each = own graph + own thread_id
                                                         reflection node    (per worker, retry edge)
   SQLite (better-sqlite3)                              synthesis node      (1×)
     chats.{mode, agent_graph,                                │
      execution_trace, run_status}                            ▼
   ObservabilityService (trace append)                  OpenRouter API (1 key, many models)
```

Key property: **the sidecar never executes a tool itself.** Tools live in Electron, with all the
permission machinery already built. The sidecar reasons; Electron acts.

---

## 3. The two channels (and why SSE isn't enough)

- **Down (sidecar → Electron):** Server-Sent Events on `/run/{id}/stream`. This is the
  `AgentEvent` firehose — plans, tokens, completions, reflections, pauses. One-way.
- **Up (Electron → sidecar):** plain `POST /run/{id}/resume`. SSE can't carry this because it's
  one-directional. Every time the sidecar pauses (for a tool result or a HITL decision), Electron
  POSTs the answer back and the LangGraph run resumes from its checkpoint.

This asymmetry is deliberate and is the whole reason the design is clean: see §4.

---

## 4. The unifying idea: a tool call *is* an interrupt

The single most important architectural decision. Because the sidecar can't run MCP tools, an
agent that wants a tool has to stop and wait for Electron regardless. So we model **every** tool
call as a LangGraph `interrupt()`:

```
agent wants tool
      │
      ▼
  interrupt()  ──emit AgentEvent──►  Electron McpServerManager
  (run frozen to disk)                  │
                                        ├─ permission needed? → show HITL popup, wait for user
                                        │                       (durable — no auto-reject)
                                        └─ run tool, get result
                                        │
  resume(result) ◄── POST /resume ──────┘
      │
      ▼
  agent continues (node re-executes from its start — see gotcha)
```

This collapses two things into one mechanism:
- A **plain tool call** = interrupt that Electron resolves immediately by running the tool.
- A **HITL approval** = the same interrupt, except Electron asks the user first.

We reuse the entire existing permission stack untouched. The sidecar has zero MCP knowledge.

> **Gotcha to respect in node code:** on resume, LangGraph re-executes the node *from its start*.
> Any side effect placed *before* the `interrupt()` call runs twice. Tool side effects must come
> *after* the interrupt resolves. (Source: LangGraph `interrupt()` semantics.)

---

## 5. Where parallelism lives (and why not in one graph)

Requirement D4: one agent paused for HITL must **not** freeze a parallel independent agent. A
naive LangGraph fan-out won't give us that — an `interrupt()` halts the whole graph invocation,
not one branch. So:

- Each **worker agent is its own LangGraph invocation** with its own `thread_id` (its own
  checkpoint). It can pause and resume independently of its siblings.
- The fan-out / fan-in is orchestrated with **`asyncio.gather`** at the FastAPI layer, not inside
  a single graph.
- **Synthesis** is a final single step that consumes all collected worker outputs.

Net: asyncio for concurrency + independence, LangGraph per-agent for the loop + interrupt + retry.

**Parallel vs. sequential is expressed as `phase: number` on each `AgentStep`** — steps sharing a
phase run in parallel; phases run in order. Simple, matches the plan-pane mockup, and avoids a
dependency graph for v1. (Can move to explicit `dependsOn` edges later if a task ever needs
partial overlap across phases.)

---

## 6. The event contract (`AgentEvent`)

Defined in `shared/types.ts` first, because the sidecar, the IPC layer, and the UI all build
against it independently. Every event carries a base envelope so the trace can be ordered and
replayed:

```
AgentEventBase { runId: string; seq: number; ts: number }   // seq = monotonic per run
```

| `type` | payload (+ base) |
|---|---|
| `plan_started` | `maxAgents` — planning began (UI Goal 5) |
| `plan_stage_changed` | `stage ('reading' \| 'splitting' \| 'assigning' \| 'wiring'), attempt` |
| `plan_subtask_added` | `attempt, index, step {id, label, role, dependsOn}` — a complete subtask parsed out of the planner's streaming JSON; draft only |
| `plan_reasoning` | `token` — orchestrator reasoning when the model streams it (not requested) |
| `orchestrator_plan` | `steps: AgentStep[]` (+ `fallback?, fallbackReason?` — the fallback plan is never silent) |
| `agent_start` | `agentId, role, model` |
| `agent_token` | `agentId, token` |
| `agent_complete` | `agentId, output, tokenCount, costUsd` |
| `reflection_start` | `agentId` |
| `reflection_result` | `agentId, score (1–5), passed, reason` (+ `claimsChecked, claimsFailed, claimStatuses, evidenceMode, judgeInputChars`) |
| `retry` | `agentId, attempt, reason` |
| `agent_degraded` | `agentId, attempt, score, issues, claimStatuses, reason?, unreviewed?` — retries ran out, best attempt passed on |
| `plan_step_removed` | `stepId, label, reason` — the planner's final merge step (label merges/combines/consolidates/synthesizes, every other step among its ancestors) was dropped before approval; the synthesizer merges and applies the task's exclusions (spec A Phase 4) |
| `context_compacted` | `agentId, attempt, stubbed, tokensFreed` — oldest tool results stubbed so the next request fits |
| `hitl_pause` | `agentId, role, toolName, serverName, args` |
| `hitl_resume` | `agentId, approved` |
| `synthesis_start` | — |
| `synthesis_token` | `token` |
| `task_complete` | `finalOutput, totalCostUsd, totalTokens` |
| `task_failed` | `reason, partialOutputs?` |

`sandbox_*` events are **Phase 2** (Docker) and deliberately excluded from the MVP contract.

Incoming SSE payloads are untrusted JSON from a separate process → validated by
`parseAgentEvent` / `isAgentEvent` in `src/shared/agentEvents.ts` before use.
Hand-written, no new dependency. Guards base fields (`runId: string`, `seq: number`,
`ts: number`) **and** variant-specific field types; rejects unknown `type` values.

The `seq` field is what makes the **"click the plan badge to replay the last run"** feature
possible — without a monotonic sequence you can't reconstruct ordering from the persisted trace.

---

## 7. Agent roles

| Role | Runs | Default model | Job |
|---|---|---|---|
| Orchestrator | once | `meta-llama/llama-3.3-70b` | task → `AgentStep[]`, emit `orchestrator_plan`, enforce agent cap. Needs good structured JSON. |
| Worker | 1–N parallel | user-configured | do the subtasks; own window, own role prompt, can call MCP tools. Most expensive — drives cost. |
| Reflection | after each worker | `meta-llama/llama-3.3-70b` | score 1–5 + pass/fail + reason. Cheap. |
| Synthesizer | once | user-configured (large ctx) | combine all outputs → final answer with provenance tags. |

Model selection is **not** a curated shortlist — fetch `/api/v1/models` at runtime, filter by
tool-call support + context length + price, expose four "slots" (orchestrator / worker /
reflection / synthesizer). All workers in a run share one worker model.

---

### 7a. The reflection gate (specs/multi-agent-reflection-hardening.md)

**Tools offered.** Workers see only tools they can call: built-ins plus MCP servers that are HTTP or
stdio with a reviewed, non-bypassed sandbox profile. One predicate (`multiAgentExclusionReason`)
drives both the schema list and the call guard. Excluded running servers are named in the start
result, in `run_config.excludedServers` and as one row each on the pre-flight screen.

**Claims contract.** A worker ends its answer with a ` ```claims ` JSON array, and marks each claim
in the prose `[c1]`, `[c2]`…:
`{id, claim, callId, quote}` (quote copied from that tool result, 12–400 chars),
`{id, claim, unverified: true}`, or `{id, claim, source: "1.1"}` (taken from an earlier agent).
Successful tool results reach the worker headed `[callId: …]` so it can cite them. The block is
removed from the answer and never streamed to the card.

**Snippet ids (default, `claimFormat: 'snippet'`; spec A Phase 2).** Each successful result is split
into snippets (one per Brave `[n] title / url / body` block, otherwise the whole result), labelled
`[S<call>.<n>]` in the tool message and kept in the evidence store. The contract asks for
`{id, claim, snippets: ["S3.2"]}` instead of a copied quote; the sidecar fills `callId` and `quote` with
the snippet sentence sharing the most words with the claim (ties: the first; ≤ 400 chars). An unknown id
is `snippet_not_found` (repair turn naming it); a claim citing nothing is `no_citation`. The
`callId` + `quote` form is still accepted in snippet mode (models that ignore ids), and `legacy` mode
keeps the old contract and unlabelled results.

**Gate order** for every answer: (a) deterministic precheck (empty, short, refusal); (b) claims
parse and a **mechanical quote check** against the agent's evidence store — formatting-only
normalisation (entities, tags, curly quotes/dashes, emphasis, thousands separators, whitespace,
case), no fuzzy matching; statuses `verified · unverified_declared · source · quote_not_found ·
call_not_found · call_failed · quote_too_short · quote_too_long`, plus (spec A Phase 1)
`verified_fragments` (a `...`-stitched quote whose pieces appear in order; length limits apply to
their total), `verified_repointed` / `verified_fragments_repointed` (the quote is in exactly one
other result of the agent, so its callId is rewritten) and `quote_found_elsewhere` (in several:
the repair turn lists the candidates, nothing is guessed). Failing claims carry a class in
`claimFailureClasses` (`ellipsis_fragment_missing · wrong_call · mismatch · too_short · too_long ·
call_failed`); (c) the judge. A mechanical
failure skips the judge and goes straight to a repair turn; on the last allowed attempt the judge
still runs (for a score) but the attempt cannot pass.

**Evidence.** Every tool call is kept in full in a per-agent evidence store on the run, apart from
the message history. Since spec A Phase 3 the judge works on `excerpts` by default: an index of calls
plus ±250 chars around each cited quote, overlapping windows of one call merged into a single block
labelled with all its claims, whitespace collapsed. `judgeEvidenceMode: 'full'` (Settings → Reviewer
evidence) gives every result when the estimate fits `judgeEvidenceMaxTokens` (100k, at most half its
context window) and the remaining budget, else excerpts. Its prompt says which; it judges whether each
quote supports its claim and whether the prose makes unmarked assertions, is told not to re-check that
quotes exist, and sees the claim-check history of earlier attempts. Judge calls request
`reasoning.effort: low` and at most 600 output tokens (a truncated, unusable verdict is retried once
with twice that).

**Patch repairs and escalation (spec A Phase 5).** When only some claims fail the mechanical check
(and the answer otherwise parses), the repair turn lists just those claims with their failure class —
for `wrong_call`, the candidate snippet ids that hold the quote — and asks for a ` ```claims_patch `
block `{replace: [entries], drop: [ids]}`. The sidecar merges it into the previous claims and keeps
the report as written; a dropped claim stays, marked unverified. A full answer instead of a patch is
accepted as a full answer. From the second repair on (attempt ≥ 2) a worker runs on
`models.escalation` when one is set (Settings → Multi-Agent → Escalation; the coordinator checks it
against the catalogue and prices it); that `retry` event carries `escalated: true` and the model.

**Evidence stubs (spec A Phase 6).** Before each worker request, every tool result older than the
most recent round (the tool messages after the last assistant turn that called tools) is replaced by a
stub: `[callId: …] tool args: N snippets S3.1–S3.5, 12.8 KB — titles: …; use read_evidence("S3.1") or
grep_evidence…]`. Workers that have tools also get `read_evidence {ref, start?, length?}` (a snippet or a
call's result, default 6,000 chars, at most 20,000) and `grep_evidence {pattern, callId?}` (matching
lines with their snippet ids, at most 40), answered by the sidecar from the evidence store — no approval,
no Electron round trip, not new evidence (cite the snippet ids they show). Stubbed snippets stay citable;
`compact_to_fit` only acts when the history still does not fit.

**Search results in the worker's view (spec A Phase 7).** The worker path of Brave search puts
Brave's own snippet as each page's first body line (single chat is unchanged). In the sidecar each
search page keeps its title, url and first body line (≤ 400 chars); the rest is whitespace-collapsed
and cut to 850 chars around the densest run of query terms, ending
`… [N chars trimmed; read_evidence("S3.2") for the rest]`. Only the view is trimmed: the evidence
store keeps the full result, so quote checks, the judge and `read_evidence` see everything.

**OpenRouter parameters and caching (spec A Phase 8).** Every request carries `provider:
{require_parameters: true, data_collection}` (+ `sort: "price"` for the judge, + per-role
`providerPrefs`), its role's `max_tokens` cap (applied inside the budget planner, so it also shrinks the
reservation; a "length" finish caused by it is reported as `max_tokens`) and its role's reasoning effort
(never for a model the catalogue marks as taking none). Worker and judge calls carry
`session_id: "<runId>:<agentId>"`. `cache_policy(model)`: Anthropic, Qwen and Gemini before 2.5 get
`cache_control` breakpoints on the system prompt and the last message (wire copy only); other families
cache automatically. Call records carry `cachedTokens`, `cacheWriteTokens`, `cacheDiscountUsd`; when a
recorded call's stream reports none, the generation endpoint is asked once. `runTotals.cachedTokens` and
the baseline summary (total, per-agent hit rate) show them.

**Approval observability (spec A Phase 9).** For every worker tool call Electron reports how it was
approved — `auto` (bypass-all, or neither the run nor the server asks), `trusted` (agent trust or the
chat's session allow-list), `asked` (the permission dialog) — the person's `waitMs` and the tool's own
`toolMs` (total minus the wait). They ride on the `/hitl` reply into `hitl_resume`, `tool_done` and the
tool's call record (`approvalMode`, `timing.waitMs/toolMs`). The run log flags `approval_wait` above
20 s on the critical path; the baseline summary splits wait from tool time and counts calls by mode.
The approval UX is unchanged.

**Planner slicing (spec A Phase 10).** The planner slices research on one axis — by entity (each leg,
city, company) or by topic (baggage, prices, risks), never both — and marks each step's `axis`. A step
that only matters depending on another step's answer lists that step in `dependsOn` and carries
`condition` text; a step id named in `condition` is added to `dependsOn` automatically (Spec B makes
conditions executable). `slicing_problems()` flags mixed axes and a label with an "if / unless / in case"
clause that depends on nothing; the planner gets one correction turn (`SLICING_CORRECTION`), and its next
answer is kept either way.

**Repair retries.** A retry continues the worker's conversation: the rejected answer stays as the
last assistant turn and the verdict (`Reviewer verdict: score n/5 — …`, issues, "do not repeat
research") is a new user turn, so tool results are kept. A repetition loop adds its nudge the same
way. The history is compacted (oldest tool result first, to a stub) only when the next request would
not fit the model's context window; `maxToolRounds` still counts per attempt.

**Degraded steps.** With `onRetryExhausted: 'degrade'` (default), exhausted retries pass on the best
attempt (highest score, ties to the latest) as `agent_degraded`; dependants and the synthesis get
`[1.1 DEGRADED: score 2/5; open issues: …]`, the prose and `Claims (1.1): c1 verified; c2 unverified;
c3 failed-check`, and the synthesis is told to caveat or drop failed-check claims. A judge with no
usable verdict is accepted as `unreviewed`. Only a step with no usable output fails. The UI shows an
amber **accepted with caveats** badge and the issues in the card; each reflection row reads
`{score}/5 · {evidenceMode} evidence · {claimsFailed} claims failed`.

---

## 8. Cost control (three layers)

| Layer | Mechanism | Default |
|---|---|---|
| Hard agent cap | baked into orchestrator prompt **and** enforced sidecar-side — over-cap plan is rejected and re-planned | 4 |
| Per-run budget cap | sidecar tracks cumulative spend from OpenRouter usage fields; on hit: no new agents, running ones finish, synthesis on partial output | $0.50 |
| Pre-flight approval | plan + cost-estimate range shown before any worker fires; user approves first | always |

OpenRouter free tier note (learned from NVIDIA): some models **silently time out** with zero
bytes rather than erroring on overload. Budget/agent caps are the backstop.

---

## 9. Data model (Phase 1 migration)

```
chats  (existing table — add 4 columns)
  + mode             TEXT NOT NULL DEFAULT 'single'   — 'single' | 'multi-agent'
  + run_status       TEXT NOT NULL DEFAULT 'idle'     — 'idle' | 'running' | 'paused_hitl' | 'completed' | 'failed'
  + agent_graph      TEXT                             — JSON AgentStep[] (NULL for single-mode)
  + execution_trace  TEXT                             — JSON ordered AgentEvent[] for replay (NULL until first run)
```

Migration is implemented in `applyMultiAgentMigration(db)` in `DatabaseService.ts` and called from
`getDB()` on every launch. Uses the try/catch `ALTER TABLE … ADD COLUMN` pattern — **no
`PRAGMA user_version` bump** (reserved for destructive migrations). Idempotent: re-runs are safe.
Pre-existing rows backfill `mode = 'single'` and `run_status = 'idle'` from their column defaults.

`execution_trace` + `agent_graph` are what power the per-chat "show last plan" replay view.

---

## 10. Defaults & knobs (`MultiAgentConfig`)

| Knob | Default | Meaning |
|---|---|---|
| `maxAgents` | 4 | hard cap on worker agents per run |
| `budgetCapUsd` | 0.50 | per-run spend ceiling |
| `models.{orchestrator,worker,reflection,synthesizer}` | from settings | one OpenRouter model id per slot |
| `reflectionPassThreshold` | 3 | min reflection score (1–5) to pass without retry |
| `maxRetriesPerAgent` | 2 | repair turns per agent; a retry continues the agent's conversation with the reviewer's feedback |
| `dataCollection` | `allow` | `deny`: OpenRouter `provider.data_collection: "deny"` on every request (Settings toggle; fewer providers) |
| `maxTokensByRole` / `reasoningByRole` / `providerPrefs` | see below | config-file only (spec A Phase 8): per-role max_tokens (planner 4,000, worker 12,000, judge 600, synthesizer 16,000), efforts (planner medium, judge low, synthesizer medium; workers use `reasoningEffort`, default `low`), extra `provider` fields merged per role |
| `judgeEvidenceMode` | `excerpts` | `excerpts`: ±250 chars around each cited quote; `full`: every result when it fits (Settings → Reviewer evidence) |
| `claimFormat` | `snippet` | `snippet`: claims cite snippet ids and the quote is filled in; `legacy`: claims carry callId + quote (Settings → Claim citations) |
| `onRetryExhausted` | `degrade` | `degrade`: pass the best attempt on with its caveats; `fail`: fail that agent (dependants cascade) |
| `hitlTimeoutMs` | 300000 | auto-deny a HITL pause after 5 min, fail that agent, continue others |
| `requirePermissions` | `true` | HITL default for multi-agent runs (defaults to safe/on) |

---

## 11. Failure behaviour (graceful, never a hung app)

The five IPC channels (`multi-agent:start`, `multi-agent:hitl-respond`, `multi-agent:abort`,
`multi-agent:sidecar-status`, `multi-agent:event`) are wired and typed as of Phase 1 prompt 3.
Until the Phase 2 sidecar exists, `sidecar-status` always returns `'stopped'` and `start`
always returns `{ ok: false, reason: 'sidecar_unavailable' }` — the renderer can gate its UI on this.

```
sidecar not running    ──► IPC returns synthetic ready-state; button still renders   app fine
sidecar crashes        ──► health-check loop (10s) restarts it                        app fine
one worker fails       ──► run continues; synthesis uses the others' output           run continues
reflection max retries ──► best attempt passed on, "accepted with caveats"           run continues
                           (onRetryExhausted 'fail': agent_failed for that agent only)
HITL pause times out   ──► auto-deny that tool, fail that agent, others continue      run continues
budget cap hit         ──► no new agents; partial synthesis; "budget cap" badge       run completes
abort                  ──► DELETE /run/{id}; clean kill; no orphaned process          app fine
planner fails / slow   ──► orchestrator error or 4 unusable replies → fallback plan     user decides
                           with fallbackReason shown at plan approval; after 45s the
                           UI offers POST /run/{id}/quick-plan ("Use quick 3-step plan")
app quits mid-run      ──► sidecar terminated cleanly on quit                         no orphans
```

---

## 12. Build status

Phases mirror `specs/MULTI_AGENT_SPEC.html` §11. All four shippable phases are implemented and
verified (progress.md rows 316–322, 325); Phase 5 (Docker) is superseded by the SandboxService proxy.

| Phase | Scope | Status |
|---|---|---|
| 1 | **Foundation** — `AgentEvent` contract + validator, SQLite migration, IPC channels, sidecar lifecycle, OpenRouter-gated mode button. | ✅ |
| 2 | **Basic orchestration** — FastAPI sidecar, LangGraph `plan → approve → workers → synthesize` graph, parallel phases, streamed events, layout state machine, real end-to-end run. | ✅ |
| 3 | **Reflection + HITL** — reflection gates with retry, `agent_failed` for per-agent failure, HITL popup with agent identity, per-agent trust/block within a run, non-blocking parallel pauses, pre-flight approval with cost range, budget cap with in-flight reservations. | ✅ |
| 4 | **Polish + observability** — clickable provenance chips, collapsing agent cards, live counters, `stepType`/`agentId`/run-cost trace fields, settings with filtered catalogue. | ✅ |
| 5 | **Docker sandboxing** — superseded: worker tools run through Electron's McpServerManager → SandboxService (SANDBOX_ARCHITECTURE_SPEC.html §04). | n/a |

**Runtime guarantees** (see `MultiAgentSidecarManager.ts` / `MultiAgentRunCoordinator.ts`):
the sidecar runs inside the srt sandbox (only `openrouter.ai` + loopback bind), authenticates every
request with a per-launch token, streams OpenRouter with usage accounting (`usage.include`), never
starts a paid request that could exceed the cap (worst-case reservations shared by parallel
requests, a synthesis reserve, and a `max_tokens` bound), exits on stdin EOF, and every run ends
with exactly one terminal event — synthesized by Electron if the sidecar or its stream dies.

---

## 13. Decisions taken

| Decision | Resolution |
|---|---|
| Sidecar binary strategy | System Python + a private venv under `userData/sandboxes/multi-agent-sidecar/venv`, installed from the packaged, exact-pinned `requirements-multi-agent.txt` on first use and re-installed when that file's hash changes. PyInstaller remains an option if a Python-less machine must be supported. |
| When to spawn the sidecar | Lazily: when Multi-Agent mode is switched on (warm-up) or on the first run — no idle Python for single-model users. |
| Per-chat custom system prompt | Still deferred; the global prompt is the base for all agents. |
| Port | 7823 by default (Settings → Multi-Agent); a busy port falls back to a free one. |

---

## 14. Out of scope (explicitly deferred)

Non-OpenRouter backends (single-model by nature), agent-to-agent direct messaging (all coordination
via orchestrator), user-editable orchestration graph (Phase 3), cloud sync of traces (never —
local only), background/daemon agents (Phase 3). Docker/E2B code execution is superseded by the
SandboxService proxy; agents act only through MCP tools the user has approved.
