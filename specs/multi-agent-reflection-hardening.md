# Multi-agent reflection hardening: evidence, claims, repair retries, graceful failure

Status: ready for `/goal`. Written 2026-10-08 against `main` at `4db1006` (3.1.0).
Trigger: run `69750960-0491-4a65-8035-48b94958e54c` (the 6-criteria stock screen). Agent 1.1 did real work in three attempts, the reflection gate scored it 2, 1 and 2 out of 5, `reflection retry limit exceeded` raised `task_failed`, and agents 2.1–2.4, 3.1 and synthesis never ran.

Read `CLAUDE.md` and `progress.md` first. Standing rules for every phase:

- Append rows to `progress.md`; never edit existing rows.
- Bump the version in `package.json` once, in the final phase.
- Commit per phase. Do not push.
- Tests are additive. Do not weaken or delete an existing assertion to make a change pass; if one is now wrong, change it in the same commit and say why in the message.
- Do not touch `ChatService.ts`. Multi-agent runs through `multi_agent_sidecar.py` and `MultiAgentRunCoordinator.ts`.
- Spend stays inside the per-run budget cap (spec §06). Every new model call reserves against it like the existing ones.
- Design language for any UI: `#0a0a0a` surfaces, `rgba(229,57,53,x)` accents, `0.5px rgba(255,255,255,0.05)` hairlines, Inter and JetBrains Mono. No white surfaces.

---

## What went wrong (diagnosis, verified in the log and the code)

Each item names the phase that fixes it.

1. **The judge saw about 1% of the evidence.** `run_worker` builds the judge's evidence with `preview(content, 600)` (`multi_agent_sidecar.py:1067`). In the failing attempt the judge's "Tool calls the agent made" section was 24 KB against about 2 MB of real tool results. Figures it flagged as invented (ALAB $374.55, SEZL $112.61, and others) are in the raw results (calls 156 and 158) but not in its 600-character snippets. The rubric tells it to flag claims with no evidence, so it flagged correct claims. *Phase 2.*
2. **Retries restart from nothing.** Each attempt rebuilds `messages` from the system prompt, the task and one paragraph of feedback (`:965–:1103`). The worker's searches, tool results and previous answer are discarded, so each retry repeats the whole research (29 worker calls, about 380 s). *Phase 4.*
3. **No claim-to-evidence link.** The worker writes prose; the judge has to guess which tool result backs which sentence. *Phase 3.*
4. **Exhausted retries destroy the run.** `raise AgentFailed("reflection retry limit exceeded …")` (`:1105`) fails step 1.1, which cascades to every dependent. A usable shortlist from the last attempt was thrown away. *Phase 5.*
5. **Tools that can never work are advertised.** `MultiAgentRunCoordinator.ts:196` sends `[...builtin.getToolSchemas(), ...mcp.getToolSchemas()]`. `getToolSchemas()` (`McpServerManager.ts:274`) filters only on running state and disabled tools. The call guard (`:372`) rejects any stdio server with no `sandboxProfile` or with `bypassSandbox: true`. So bypassed servers (`filesystem_HW2_CSE6242`, `memory`) were offered and then denied, 3–5 times per attempt, each denial a paid model round trip, and every request carried their schemas. *Phase 1.*
6. **The rubric punishes honesty and ignores context.** "Claims are backed by tool evidence or explicitly marked as unverified" is fine, but nothing tells the worker that an unverifiable criterion (here the 2-quarter 13F trend) is reported as unverified rather than as pass or fail, and nothing tells the judge how the evidence is presented (excerpts or full). *Phase 6.*
7. **The screening step is too big for one agent.** "Peak parallel: 1". One worker screened 12 names against 6 criteria through web snippets. *Phase 6 (planner guidance); a structured data tool is a follow-up, see Out of scope.*

---

## Fix list (checklist: every discussed fix, one line each)

| # | Fix | Phase |
|---|-----|-------|
| F1 | Pin every claim above with a failing or passing test, including a replay of the real failure | 0 |
| F2 | Offer workers only tools they can actually call (sandbox filter at the schema, one shared predicate for schema and guard) | 1 |
| F3 | Tell the user which servers were excluded and why (pre-flight) | 1 |
| F4 | Keep every tool result in full in a per-agent evidence store, separate from the message history | 2 |
| F5 | Judge sees all tool results when they fit a token budget; otherwise per-claim excerpts, and is told which | 2 |
| F6 | Log judge input size and evidence mode in the trace | 2, 7 |
| F7 | Workers emit claims as `{id, claim, callId, quote}` or `{id, claim, unverified: true}` | 3 |
| F8 | Deterministic quote check against the stored result before any judge call | 3 |
| F9 | Judge verifies "does this quote support this claim", not "does evidence exist somewhere" | 3, 6 |
| F10 | Retries continue the same conversation: history, results and last answer kept; the verdict is appended as a new turn | 4 |
| F11 | Workers keep the model's full context window; history is compacted only when the next request would not otherwise fit, instead of failing the agent. No new caps on repair turns | 4 |
| F12 | When retries run out, keep the best attempt, mark it degraded, and pass it downstream with its open issues; only an empty or unusable result fails the step | 5 |
| F13 | Downstream agents and synthesis see the caveats and per-claim status | 5 |
| F14 | Rubric and worker prompt: unverifiable means "unverified", never pass or fail; judge told how evidence is shown | 6 |
| F15 | Planner guidance: split wide screening or research steps into parallel sub-steps with a merge step | 6 |
| F16 | New events and trace fields, UI state for "accepted with caveats", docs, version bump | 7 |

---

## Phase 0. Pin the failure (small)

1. Python test `test_reflection_evidence.py`: run a one-step plan against a fake OpenRouter (see `worker_harness.py`). The fake tool returns a 20,000-character result with the string `NEEDLE-4711` at character 15,000; the worker's answer quotes it. Assert today that the judge's request body does **not** contain `NEEDLE-4711` (this pins diagnosis 1; it flips in Phase 2).
2. Python test: three judge verdicts of score 2 with `maxRetriesPerAgent = 2`; assert the current outcome is `agent_failed` with "reflection retry limit exceeded" (pins diagnosis 4; flips in Phase 5).
3. Python test: record the `messages` sent on attempt 0 and attempt 1; assert attempt 1 contains none of attempt 0's tool results (pins diagnosis 2; flips in Phase 4).
4. TS tests in `McpServerManager.test.ts` and `MultiAgentRunCoordinator.test.ts`: a running stdio server with `bypassSandbox: true` and one with no profile each appear in `getToolSchemas()` today, and `callToolForMultiAgent` rejects them (pins diagnosis 5; flips in Phase 1).

Done when: the four tests exist, pass against current behaviour, and each carries a comment `// flips in Phase N`.

## Phase 1. Offer only callable tools

1. In `McpServerManager.ts` add one exported predicate, `isMultiAgentCallable(config)`: true for HTTP configs; for stdio configs true only when `sandboxProfile` exists and `bypassSandbox` is not true. Return a reason string when false (`'sandbox bypassed'` or `'sandbox profile not reviewed'`) via a companion `multiAgentExclusionReason(config)`.
2. The guard in `callToolForMultiAgent` (`:372`) uses the same predicate. The schema list and the guard can no longer drift apart; add a unit test that iterates every config combination and asserts schema-offered implies guard-allowed.
3. Add `getToolSchemasForMultiAgent()` (same as `getToolSchemas()` plus the predicate) and `getMultiAgentExclusions(): { server: string; reason: string }[]` (only servers that are running and have at least one active tool; a server with 0 active tools is not "excluded", it is simply off).
4. `MultiAgentRunCoordinator.ts:196` uses `getToolSchemasForMultiAgent()`. Built-in worker tools are unaffected.
5. `start()` returns `excludedServers` alongside the existing fields. The pre-flight approval screen shows one hairline row per excluded server: `filesystem_HW2_CSE6242 · excluded: sandbox bypassed`. No toast, no modal. If the list is empty, show nothing.
6. The worker's `tools_line` already lists exactly the offered tools; keep it. If the offered list is empty, keep the existing "You have no tools" line.

Done when: Phase 0 test 4 flips (bypassed and unreviewed servers are absent from the worker tool schemas, the guard still rejects them if somehow called); the exclusions appear in the pre-flight screen and in the trace.

## Phase 2. The judge sees the evidence

1. **Evidence store.** Add `EvidenceStore` on `Run`, keyed by agent id: `callId → { name, args, ok, attempt, result }`, holding the **full** result string (the call recorder already holds it, capped at `RECORD_FIELD_CAP_CHARS`; reuse that cap). It lives in memory for the run and is independent of the message history, so compacting the history (Phase 4) never loses evidence.
2. `run_worker` writes every tool call (including failed and denied ones) to the store. The old `evidence: list[str]` with `preview(content, 600)` is removed.
3. `reflect()` takes the store, not a list of strings. It builds the judge input in one of two modes:
   - **`full`**: every tool call with its complete result, when the estimated total is at most `judgeEvidenceMaxTokens` (new config, default 100,000; clamp to half the judge model's context length).
   - **`excerpts`**: otherwise, a per-claim excerpt (Phase 3: ±800 characters around the quote in the cited result) plus a one-line index of every other call (`callId, tool, args, ok, resultChars`).
4. The judge prompt states the mode in one sentence: either "You are given the complete tool results" or "Tool results are shown as excerpts around each cited quote; a figure that is absent from an excerpt is not evidence that it is absent from the full result; judge claims by their quote". The judge is never left to infer truncation.
5. Reserve the judge call against the budget as usual. If `full` mode would not fit the remaining allowance, fall back to `excerpts` rather than waiting.
6. Record `judgeInputChars`, `judgeEvidenceMode`, and `evidenceChars` (total) in the judge call's record (`call_record` obs) and in the `reflection_result` event.

Done when: Phase 0 test 1 flips (the judge request contains `NEEDLE-4711` in `full` mode; in a forced `excerpts` run it contains the excerpt around the cited quote); the mode and sizes show in the trace.

## Phase 3. Claims with quotes, checked mechanically

1. **Output contract.** The worker's final answer is prose with inline markers `[c1]`, `[c2]`, followed by a fenced block:

   ````
   ```claims
   [
     {"id": "c1", "claim": "ALAB Q2 2026 revenue $392.4M", "callId": "call_01a1...", "quote": "record revenue of $392.4 million"},
     {"id": "c2", "claim": "ALAB 2-quarter 13F trend", "unverified": true}
   ]
   ```
   ````

   Add this contract to the worker system prompt, with one short example. Claims about the agent's own reasoning or about earlier agents' outputs may cite `"source": "1.1"` instead of a `callId`; those are not quote-checked, only listed.
2. **Parsing.** `parse_claims(output)` returns the prose (block removed), the claims, and parse errors. A missing or unparsable block is a mechanical issue, not a crash.
3. **Deterministic verifier** (no model call), per claim with a `callId`:
   - the call exists in this agent's evidence store;
   - the call succeeded (`ok`);
   - the quote, after normalisation, is a substring of the result. Normalisation is formatting only: collapse whitespace, case-fold, map curly quotes and dashes to ASCII, strip markdown emphasis characters and HTML tags, remove thousands separators inside digit runs. No fuzzy or edit-distance matching.
   - the quote is between 12 and 400 characters (too short is not evidence).
   Output per claim: `verified | quote_not_found | call_not_found | call_failed | quote_too_short | unverified_declared`.
4. **Gate order.** After each answer: (a) precheck (existing), (b) claims parse and verifier, (c) judge. If (b) finds failures, skip the judge call and go straight to a repair turn (Phase 4) listing each failing claim id, the reason, and the cited `callId`. This saves a judge call per mechanical failure. The judge runs only on an answer whose claims pass (b), or on the last allowed attempt.
5. **Judge input** (Phase 2 modes) includes the claims table: `id, claim, status, quote, callId`. Its task changes from "is there evidence" to "does each quote actually support its claim, and are there significant assertions in the prose with no marker". Unmarked numeric assertions count as unbacked claims.
6. A claim marked `unverified: true` is never an issue by itself; it is reported downstream as unverified.

Done when: a claim whose quote is not in the cited result is caught with no judge call; reformatting differences (extra spaces, curly quotes, `$392.4 million` vs `$392.4&nbsp;million`) still match; a worker that returns no claims block gets one repair turn and then degrades (Phase 5) rather than crashing.

## Phase 4. Repair retries continue the conversation

1. `messages` is created once per worker, outside the attempt loop. Attempt 0 is the original run. A rejection (mechanical or judge) appends:
   - the worker's answer is already in history as its last assistant turn;
   - a new `user` turn: `Reviewer verdict: score {n}/5 — {reason}\nFix these, keeping everything that was fine:\n- {issue}…\nYou already have your tool results above. Re-check only what is flagged; do not repeat research you have already done. Reply with the full corrected answer and claims block.`
2. The evidence store and the claims list persist across attempts. Repair turns may call tools under the same `maxToolRounds` as the first answer (default 12 today, `null` = unlimited), counted per attempt. This spec adds no new cap on workers: the only things that stop a worker remain the budget cap, the repetition guard and the model's context window. The repair prompt tells the worker not to repeat research it already has; that is guidance, not a limit.
3. **Context guard (only at the limit).** Workers use the model's whole context window; nothing is compacted early. Before each model request, apply the same fit test `plan_request` already uses (`prompt_tokens × 1.25` against `contextLength`). Only if the request would not fit, replace the oldest tool results with a stub (`[call_id name args: result compacted, N chars, first 300 chars: …]`), one at a time, oldest first, stopping as soon as the request fits with the existing safety factor. Today that situation raises `ContextExceeded` and fails the agent; this turns it into a recovery. When `contextLength` is unknown (0) never compact. Evidence for quote checks and the judge comes from the store, so compaction loses nothing there. If the request still does not fit after every tool result is stubbed, raise the existing `ContextExceeded`. Emit one `context_compacted` trace note per event (count of results stubbed, tokens freed).
4. A repetition loop (`looped`) discards the looped partial reply (it is never appended, as today) and adds the existing nudge as a new turn instead of restarting.
5. `maxRetriesPerAgent` is the user's setting (Settings slider, 0–5) and is not changed by this spec: neither the default (2 in `types.ts`) nor the range. It now counts repair turns, which continue the conversation. Add the help text "A retry continues the agent's conversation with the reviewer's feedback; it does not start over." to the slider's `Field` in `MultiAgentSettingsPanel.tsx`.
6. The "attempt" number on events keeps its meaning (0 = first answer, 1 = first repair, and so on), so the UI and trace schema do not change shape.

Done when: Phase 0 test 3 flips (attempt 1's request contains attempt 0's tool results and last answer plus the verdict turn); a repair that only tags claims as unverified makes zero search calls; a history that would overflow the window is compacted just enough and the run continues; a history that fits is never touched.

## Phase 5. Degrade instead of failing the run

1. New config `onRetryExhausted: 'degrade' | 'fail'`, default `'degrade'`. Settings gets one select in the existing multi-agent panel (use the primitives that already exist; no per-input styling).
2. Track every completed attempt as `{attempt, output, claims, score, issues}`. On exhaustion with `'degrade'`, pick the highest score (ties go to the latest attempt) and return it. Emit `agent_degraded { agentId, attempt, score, issues, claimStatuses }` instead of raising.
3. A step still fails (`AgentFailed`) only when there is **no usable output**: empty answer, repetition loop on every attempt, budget cap before any answer, or a failing precheck on every attempt. If the judge was unavailable ("gate unavailable", score 0), the output is accepted as `unreviewed`, not failed.
4. What downstream sees (`prior[k]` in `run_worker` and the synthesis inputs) is the prose plus a short appendix: the claim ids with status (`verified`, `unverified`, `failed-check`) and, for a degraded step, a header line `[1.1 DEGRADED: score 2/5; open issues: …]`. Synthesis is told in its prompt to drop or explicitly caveat `failed-check` claims and to say that a step was degraded.
5. `'fail'` keeps today's behaviour for people who want it.

Done when: Phase 0 test 2 flips (three rejections produce `agent_degraded`, the dependants run, and the final synthesis mentions the caveat); a run whose every attempt is an empty answer still fails the step and cascades as today.

## Phase 6. Prompts and planner

1. **Worker system prompt.** Add: "If a criterion cannot be verified with your tools, report it as *unverified* with the reason. Never report an unverifiable criterion as met or as failed, and do not eliminate an item only because data is missing; flag it instead." Keep the existing never-claim-unexecuted-work line.
2. **Rubric.** Replace `REFLECTION_RUBRIC` item 2 with: "Every factual claim carries a quote from a tool result that supports it, or is explicitly marked unverified; a claim marked unverified is not an issue". Item 4 applies only when the step has dependencies; the judge is told to skip it otherwise. Add the mode sentence from Phase 2. Keep the 1–5 scale and the pass threshold.
3. **Judge discipline.** The judge prompt says: "Do not infer that something was invented from its absence in an excerpt; report only claims whose quote does not support them, assertions with no marker, and rubric failures." This is a prompt change only; it does not replace the mechanical verifier.
4. **Planner (`PLANNER_SYSTEM`).** Add: "If a step must evaluate many candidates against several criteria, split it by sector, theme or criterion group into parallel steps and add one merge step that applies the exclusions and combines the results." Note: the candidate universe is not known before screening, so the split is by sector or theme, not by ticker. Keep the existing pure-chain correction.
5. **Eval.** Add the failing stock-screen task to `specs/multi-agent-evals-and-memory.md`'s eval list (or its harness if one exists): run it against a recorded OpenRouter fixture and assert the run reaches synthesis.

Done when: the full stock-screen prompt, replayed against recorded fixtures, completes with step 1.1 passed or degraded and synthesis produced; the planner test shows a wide screening task producing two or more parallel steps and a merge step.

## Phase 7. Events, trace, UI, docs, version

1. **Events** (add to the `AgentEvent` union in `src/shared/types.ts`, the sidecar, `MultiAgentRunCoordinator`, `multiAgentRunState.ts`, preload typings and `api.mock.ts`): `agent_degraded` (Phase 5); extend `reflection_result` with `claimsChecked`, `claimsFailed`, `evidenceMode`, `judgeInputChars`; extend `start()`'s result with `excludedServers` (Phase 1).
2. **Trace** (observability spec): each call record carries `evidenceMode` and `judgeInputChars`; each agent record carries per-attempt claims with their statuses and the final accepted attempt.
3. **UI**: a degraded step shows an amber `accepted with caveats` badge (reuse the existing paused-amber token) with the issues in the expandable detail; the plan pane marks it with the existing partial state, not the failed one. The reflection row shows `{score}/5 · {evidenceMode} evidence · {claimsFailed} claims failed`. No new panels.
4. Update `features/Multi-Agent-Orchestration.md` and the multi-agent spec's reflection section to describe the claims contract, the judge's evidence modes, repair retries and degraded steps.
5. Bump `package.json` once.

Done when: every new event type has a reducer test; the mock API drives the degraded state in the UI; docs match the code; `npm test` and the sidecar tests pass.

---

## Out of scope (listed so nothing is lost)

- **Structured financial and filings data tool** (SEC EDGAR XBRL, 13F holdings). Criterion 5 of the stock prompt (2-quarter institutional ownership trend) cannot be sourced from web-search snippets. Follow-up spec: add a builtin worker tool next to `get_ticker_price` in `WorkerBuiltinTools.ts`. Until then, the Phase 6 prompt rule makes workers report it as unverified.
- Changing the reflection model or its temperature.
- A user-visible "re-run this step" button for degraded steps.

## Decisions made in this spec (change before `/goal` if you disagree)

1. Judge evidence is `full` up to 100k tokens and `excerpts` beyond that, with the mode stated to the judge. Reason: the real 2 MB result set is about 500k tokens, which would exceed the default $0.50 run cap on its own.
2. The quote check is exact after formatting normalisation; no fuzzy matching.
3. Repair retries keep the full history, and compaction happens only when the next request would not fit the model's context window (workers otherwise use the whole window; no new caps).
4. `onRetryExhausted` defaults to `degrade`.
