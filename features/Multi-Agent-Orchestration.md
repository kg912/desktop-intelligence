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
| `orchestrator_plan` | `steps: AgentStep[]` |
| `agent_start` | `agentId, role, model` |
| `agent_token` | `agentId, token` |
| `agent_complete` | `agentId, output, tokenCount, costUsd` |
| `reflection_start` | `agentId` |
| `reflection_result` | `agentId, score (1–5), passed, reason` |
| `retry` | `agentId, attempt, reason` |
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
| `maxRetriesPerAgent` | 2 | retries before `task_failed` for that agent |
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
reflection max retries ──► task_failed for that agent only                            run continues
HITL pause times out   ──► auto-deny that tool, fail that agent, others continue      run continues
budget cap hit         ──► no new agents; partial synthesis; "budget cap" badge       run completes
abort                  ──► DELETE /run/{id}; clean kill; no orphaned process          app fine
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
