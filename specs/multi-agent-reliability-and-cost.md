# Multi-agent reliability and cost (Spec A)

**Status:** Draft for approval. Run before `multi-agent-assess-loop-and-ui.md` (Spec B), so that Spec B's gains are measured against this spec's baseline.
**Read first:** `CLAUDE.md` and `progress.md`. Follow the conventions in `multi-agent-ui-improvements.md` (progress.md row per phase, version bump per phase, commit without push).
**Evidence for this spec:** one observed run (Istanbul → Cappadocia → İzmir, 8 agents, 7 min, 0.63 USD, 5 workers + merge step + synthesizer). Every number below comes from that run's logs unless marked *estimate*.

## 0. Why

| Finding | Measured |
|---|---|
| Claims gate rejects correct work | All 5 workers failed attempt 0 with 24 bad claims. 12 were `...`-stitched quotes whose fragments are each verbatim; 4 had the wrong `callId` with the quote present verbatim in exactly one other result; 1 had both; 2 had an ellipsis plus a fragment missing; 5 were true mismatches. *(Corrected in Phase 1: the first draft said 5 wrong-callId claims, which summed to 25.)* |
| Retries are expensive | 8 retries, 0.11 USD (18% of spend). Agent 1.1's whole retry (53 s, 0.02 USD) was formatting only. Agent 1.2's key claim carried the wrong callId on all 3 attempts and made 1.2 the straggler (finished 268 s; the other four by ~185 s). |
| Judge dominates cost | 6 Gemini calls = 0.33 USD vs 40 worker calls = 0.29 USD. Judge input is full tool results (108–343 KB, 30–128k tokens per call; corrected in Phase 1 from "64–129k") although every quote was already verified mechanically. About 92% of judge output tokens are reasoning, for a small JSON verdict. |
| Redundant merge stage | Step 2.1 "merge" + its judge: 99 s, 0.06 USD, then the synthesizer rewrote it again (0.009 USD, 60 s). |
| Context re-sent | Worker prompts total 1.77M tokens for ~250k unique search text (about 7×). Agent 1.2's prompt grew 1.5k → 132k over 7 rounds. |
| Cache invisible | `call_record` has no `cached_tokens`. Agent 1.2's calls 126 and 127 are both ~150k tokens but cost 0.030 and 0.008 USD, consistent with a cache miss and hit, unconfirmed. |
| Tool results are bloated | `braveWorkerTools.call` → `augmentAndFormatResults` fetches page text for the top 5 URLs; median result 12.8 KB, mostly nav boilerplate and fare grids. |
| Approvals are unobserved | Most of 89 searches were auto-allowed via session trust; the log does not record approval mode or separate wait time from tool time. One wait (45.7 s on 2.1's first call; the first draft said 1.2's) sat on the critical path. pause→resume also includes tool execution (median 1.8 s). |
| Planner over-slices | Four agents researched baggage because steps were sliced by leg and by topic. The planner marked 1.5 independent though "if leg 2 exceeds 5 h" depends on 1.2. |

**Targets (estimate, to be confirmed by the Phase 0 baseline):** cost 0.63 → about 0.28 USD; wall time 7 → about 4 min; attempt-0 claims pass rate from 0/5 agents to at least 4/5; zero retries caused purely by formatting.

## 1. Goals and non-goals

Goals: G1 eval baseline; G2 cite-by-snippet-ID; G3 judge on excerpts; G4 remove the merge step; G5 patch-only repairs and model escalation; G6 evidence stubs and `read_evidence`; G7 tool-result trimming; G8 OpenRouter parameters and cache logging; G9 approval and claim observability; G10 planner slicing.

Non-goals: arbitrary-URL fetch tool (separate spec); the assess loop, coverage ledger, UI surfaces, checkpointer (Spec B); changing the claims verification semantics for verified quotes (`normalise_quote` stays formatting-only).

## 2. Phases

Each phase ships independently, with its own progress.md row, version bump and commit. Order matters: Phase 0 first.

### Phase 0: Eval baseline (G1)
Extends `multi-agent-evals-and-memory.md` Phases 0–1 only as far as needed; the rest of that spec (Phases 2–6) is re-scoped in §6.
- Add `summariseRun(run)` in `MultiAgentRunLogger.ts` (or extend the existing `summarise`) returning: total cost; cost by role (planner/worker/judge/synthesizer); per-agent attempts; claims by status and by failure class (see Phase 1); promptTokens total vs unique-tool-text tokens (amplification); cachedTokens; wall time; critical-path agent; approval wait total.
- Commit the observed run as a fixture under `resources/python/tests/fixtures/runs/istanbul-3leg/` (trimmed jsonl; tool results kept, secrets stripped).
- `scripts/run-baseline.ts` prints the summary as a table and writes `baseline.json`. Later phases assert against it.
- **Acceptance:** `npm run baseline -- fixtures/istanbul-3leg` outputs the numbers in §0 within 1%. Vitest covers `summariseRun` on the fixture.

### Phase 1: Claims gate stops rejecting correct work (G2 interim)
In `multi_agent_sidecar.py` (`verify_claim` L1080, `claim_problems` L1099):
1. **Ellipsis fragments.** Split `quote` on `...` / `…`; every non-empty fragment must appear in order in the cited result (a leading or trailing ellipsis makes no fragment; no cap on the number of fragments). New status `verified_fragments`. The 12–400 length limit applies to the sum of the normalised fragments, not to each one. *(Decided at the Phase 0 checkpoint: a per-fragment ≥ 12 rule would reject 3 of the 12 stitched quotes, e.g. "… 3h 45m".)*
2. **Silent callId re-point.** If the quote (or all fragments) is not in the cited result but appears verbatim in exactly one other result of the same agent's evidence store, mark `verified_repointed` and rewrite `callId`. If it appears in more than one, keep `quote_found_elsewhere` and include the candidate callIds in the repair prompt (do not guess).
3. **Failure classes in events.** Add `failureClass` to each claim status payload: `ellipsis_fragment_missing | wrong_call | mismatch | too_short | too_long | call_failed`. Surface in `reflection_*` events and `claimStatuses`.
- **Acceptance:** replaying the fixture's 24 failing claims through the new verifier yields: 12 `verified_fragments`, 4 `verified_repointed`, 1 both (`verified_fragments_repointed`), and the remaining 7 fail with a correct class (2 `ellipsis_fragment_missing`, 5 `mismatch`). *(Corrected from 5 / 6.)* Add `test_claims_fragments.py` and `test_claims_repoint.py`. Existing `test_claims.py` still passes.

### Phase 2: Cite-by-snippet-ID (G2 final)
Interim fixes in Phase 1 stay as a fallback for models that ignore IDs.
- At tool-result ingestion (where results are injected as `[callId: …]\n{content}`), split Brave results into snippets and label each `[S<call>.<n>]`, e.g. `[S3.2]`. Persist `snippetId → text` in `Run.evidence[agentId][callId]`.
- `CLAIMS_CONTRACT`: claims become `{id, claim, snippets:["S3.2"], unverified?:true, source?:"1.1"}`. The system fills `quote` from the snippet text (trimmed to ≤ 400 chars around the best-matching sentence, chosen deterministically: the sentence with the highest token overlap with `claim`).
- A snippet ID that does not exist → `snippet_not_found` (repair turn). Claims with no snippets and no `unverified`/`source` → `no_citation`.
- Workers' output tokens drop (no retyped quotes). Keep accepting the old `callId`+`quote` form behind `config.claimFormat = "snippet" | "legacy"` (default `snippet`) to ease rollback.
- *Decisions (Phase 2):* one snippet per Brave result block, any other tool result is one snippet; the `[callId: …]` header stays above the labelled snippets so the Phase 1 fallback still works; a snippet claim's status is `verified` once its ids resolve (support is the judge's question); `no_citation` is a claim status with its own failure class `no_citation`; `snippet_not_found` has class `wrong_call`. `worker_harness.py` is the matplotlib worker, so these tests use the fake OpenRouter of `test_reflection_evidence.py`.
- **Acceptance:** fake harness (`worker_harness.py`) tests: valid IDs verify with zero formatting failures; bad ID triggers a repair turn naming the ID; legacy format still verifies. On a re-run of the Istanbul prompt on the real stack, attempt-0 pass rate ≥ 4/5 agents (recorded manually in progress.md; not a CI gate).

### Phase 3: Judge on excerpts, cheaper (G3)
`reflect` (L1166), `excerpt` (L1103), `EXCERPT_RADIUS_CHARS`:
- Default `judgeEvidenceMode` to `excerpts` regardless of size; `full` only when the user sets it. Keep ±800 chars per cited snippet (now the snippet plus neighbours). *(Changed in Phase 3 to ±250, see the decision below.)*
- Judge `reasoning.effort` defaults to `low`; add a `max_tokens` cap (e.g. 600) since output is a JSON verdict.
- Judge prompt additions: it receives the claim, the quote, the excerpt, and the failure-class history of the attempt; it must not re-verify quote existence.
- *Decision (Phase 3):* ±800 chars cannot meet the 80% target on the fixture (72% in characters, recorded `judgeInputChars` vs the new input; the non-excerpt part — prose, claims table, earlier outputs, task, index — is already 13% of the old input). The radius is ±250 with whitespace collapsed and overlapping windows of one call merged (80.5%). Input is measured in characters on both sides because the recorded inputs run ~2.8 chars per real token, so a chars/4 estimate would flatter the result. "Still flagged" cannot be replayed without a model: the test asserts both catches' claim, quote and supporting text reach the excerpts-mode judge.
- **Acceptance:** replaying the fixture's judge calls: input tokens fall by ≥ 80%; the two real catches from the run (1.5 c7, 1.2 c2) are still flagged (`test_reflection_evidence.py` extended with these as fixtures). Judge cost share of run ≤ 25% in the baseline summary.

### Phase 4: Remove the merge step (G4)
- `PLANNER_SYSTEM` (L753): forbid a final "merge/combine/summarise" step; the synthesizer owns merging. Add a `plan_node` post-check that drops a step whose title matches `merge|combine|consolidate|synthes` and that depends on all others, logging `plan_step_removed`.
- If the removed step was the only holder of a unique search task, the planner must have expressed it as a normal research step (add to the prompt with an example).
- *Decisions (Phase 4):* "depends on all others" is transitive (every other step is an ancestor), so the stock-screen plan's 3.1 "…synthesize final recommendations" (fed by 2.1–2.4, which all depend on 1.1) is dropped too; the label test uses stems (`merg|combin|consolidat|synthes`) so "combining" and "merged" match; a one-step plan is never emptied. The synthesis system prompt now says merging, conflict resolution and the task's exclusions are its job. The reflection-hardening rule "add one merge step" for split screening is replaced.
- **Acceptance:** `test_plan_no_merge.py`: fixture plan with a merge step is repaired; a plan whose last step does new research is kept. Baseline shows no 2.1-style stage.

### Phase 5: Patch-only repairs and model escalation (G5)
`repair_turn` (L1252) and `run_worker`:
- When only some claims failed, the repair prompt lists just those claims with their failure class and (for `wrong_call`) the candidate snippet IDs, and asks for a `claims_patch` JSON block: `{replace: [{id, …}], drop: [id]}`. The sidecar merges the patch into the previous report; the report text is not rewritten.
- If the second repair fails, retry once on `config.models.escalation` (new optional field, default: the worker model; UI can set a stronger one). Emit `retry` event with `escalated: true`.
- `onRetryExhausted` semantics unchanged (`degrade` default).
- *Decisions (Phase 5):* patch mode applies only to a mechanical claims-check rejection with no parse errors where some (not all) claims failed; judge rejections and all-failed answers keep the full repair turn. A dropped claim becomes `unverified` (its [cN] marker stays in the untouched prose). Escalation applies from attempt 2 on (the acceptance's "switches model on attempt 2"); with the default (no escalation model) nothing changes. "Token cost of a repair turn" is measured on output tokens: both kinds of repair send the same history, so input is identical. Tests are in `test_repair_patch.py` (pytest) rather than the script-style `test_repair_retries.py`.
- **Acceptance:** `test_repair_retries.py` extended: patch merge keeps passing claims unchanged; escalation switches model on attempt 2; token cost of a repair turn < 25% of a full rewrite on the fixture.

### Phase 6: Evidence stubs and `read_evidence` (G6, RLM-style)
Motivated by `RLM.pdf` (prompt-as-environment beats lossy compaction) applied to `compact_to_fit` (L1260).
- Add worker-internal tools `read_evidence(snippetId | callId, range?)` and `grep_evidence(pattern, callId?)`, served by the sidecar from `Run.evidence` (no Electron round trip, no approval).
- After a tool result is consumed (one round later), replace its body in the message history by a stub: `[S3.*] 5 snippets, 12.8 KB — titles: …; use read_evidence`. Keep the last round's results in full.
- `compact_to_fit` becomes the last resort, not the default.
- *Decisions (Phase 6):* "consumed" is structural — every tool result before the most recent round (the tool messages after the last assistant turn that called tools) — so the live loop and the fixture replay share `stub_consumed()`. Evidence-tool outputs are not stored as evidence (they copy it); long ones are stubbed too once consumed. The replay rebuilds each recorded worker request as a prefix of its agent's final history; it cannot simulate the re-reads a real model would add, so the live ratio is unverified.
- **Acceptance:** fixture replay: total worker prompt tokens ≤ 3× unique tool text (from ~7×); claims verify identically (the evidence store is unchanged). Guard: a worker that never calls `read_evidence` must still be able to cite the current round's snippets.
- Risk: more round trips on cheap tool calls; mitigate with `maxToolRounds` unchanged and the stub listing enough to avoid re-reads. RLM reports high cost variance; track p90 cost in the baseline, not only the mean.

### Phase 7: Trim tool results at ingestion (G7)
`BraveSearchService.augmentAndFormatResults`:
- Strip boilerplate from fetched page text: nav/footer blocks, repeated link lists, cookie banners (heuristic: drop lines shorter than 25 chars that repeat across pages, collapse whitespace), and cap each page to 2,500 chars centred on the best query-term density window; always keep the snippet.
- Keep `[i] title\nurl\nbody` format; add snippet IDs (Phase 2).
- *Decisions (Phase 7):* trimming is applied to the worker's VIEW in the sidecar at ingestion, not inside `augmentAndFormatResults`: trimming the text itself made 76 of 303 verified fixture claims stop verifying (timetable rows look like "repeated short lines"), while trimming only the view keeps the full result in the evidence store for quotes, the judge and `read_evidence`. The repeated-short-line rule is dropped (it removed quoted data and did not move the median). The page cap is 850 chars, not 2,500: five pages × 2,500 cannot meet a 5 KB median (2,500 gives ~10.9 KB). Electron's worker path now keeps Brave's snippet as the first body line, which the view always keeps. Consequence to watch live: 143 of 303 verified fixture quotes are inside the trimmed view; the others need `read_evidence`.
- **Acceptance:** median result size on the fixture ≤ 5 KB; every claim in the fixture that verified before still verifies (golden test).

### Phase 8: OpenRouter parameters and cache logging (G8)
`_stream_openrouter` payload (L429–443), `call_record`:
- Log `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `cache_discount` into `call_record` and the run summary. Backfill from the generation endpoint using `generationId` when the streaming usage block lacks them.
- `session_id = f"{runId}:{agentId}"` on every worker/judge call (sticky routing; expires after 10 min idle).
- `provider: { require_parameters: true, data_collection: "deny" }` for all roles; `sort: "price"` for the judge only. Per-role override in config. Treat `models` fallback as out of scope until its docs are checked.
- Explicit `cache_control` for Anthropic and Qwen/Gemini where the model family needs it; automatic-cache families (OpenAI, DeepSeek, Z.AI, Moonshot, Gemini 2.5+) need no change. Keep this behind a small `cachePolicy(model)` function.
- Per-role `max_tokens`: planner 4k, worker 8k, judge 600, synthesizer 12k (config-overridable). Today the planner sends ~1.05M and workers ~665k.
- Per-role `reasoning.effort`: planner medium, worker low, judge low, synthesizer medium.
- **Acceptance:** `test_openrouter_payload.py` asserts payload fields per role; `call_record` contains cache fields in a mocked response; baseline summary shows cached tokens and the cache hit rate per agent. Verify `data_collection: "deny"` does not break the default model before shipping; fall back to a Settings toggle if it reduces provider availability.

### Phase 9: Approval and claim observability (G9)
- On `hitl_pause`/`hitl_resume` record `approvalMode: "trusted" | "asked" | "auto"` and split `waitMs` from `toolMs`. Persist in `call_record`/trace.
- `MultiAgentRunLogger.findAnomalies`: flag a pause longer than 20 s on the critical path.
- No change to the approval UX. "Trust tool for all" already exists.
- **Acceptance:** Vitest for the coordinator: a trusted call logs `trusted` and ~0 wait; an asked call logs the user wait separately from tool execution.

### Phase 10: Planner slicing (G10)
`PLANNER_SYSTEM`: slice research on one axis (by entity *or* by topic, never both); mark a step `dependsOn` another when its premise is a conditional on that step's answer; planner output may carry `condition` text (Spec B makes it executable; here it only sets `dependsOn`).
- **Acceptance:** `test_plan_slicing.py` on the fixture prompt: no two steps share a topic across entities; the "if leg 2 exceeds 5 h" step depends on the leg-2 step.

## 3. Data and event changes (summary)
- `AgentEvent`: add claim failure classes as `claimFailureClasses: {claimId: class}` on `reflection_result` and `agent_degraded` (a parallel map, so `claimStatuses` stays `Record<string, string>` for existing readers); `retry.escalated`; `plan_step_removed`; `tool_done.approvalMode`, `waitMs`, `toolMs`; usage fields `cachedTokens`, `cacheWriteTokens`, `cacheDiscountUsd`. Update `src/shared/types.ts`, `multiAgentRunState.ts` (`ReflectionView.claimStatuses`), and the run.md/jsonl writer.
- `MultiAgentConfig`: `claimFormat`, `judgeEvidenceMode`, `models.escalation`, `providerPrefs`, `maxTokensByRole`, `reasoningByRole`. Settings panel exposes the first three; the rest are config-file only.

## 4. Testing and verification
- Python: pytest for Phases 1–6, 8, 10; use `worker_harness.py`. Vitest for Phases 0, 9 and renderer view-model changes.
- Fixture replay test: the 24-claim set (Phase 1) and the judge-call set (Phase 3) are checked in as data, so regressions fail CI without any network.
- After Phases 2, 3, 4 and 6 are in, one live re-run of the Istanbul prompt; compare against `baseline.json` and paste the table in progress.md.

## 5. Risks
- Snippet-ID citation depends on models following the new contract; the legacy path and Phase 1 fixes stay as fallback.
- Excerpt judging loses cross-document context. Mitigation: the claims gate already checks the quote; the judge only checks quote-vs-claim support (the run's two real catches were of that type).
- Evidence stubs can cause re-searching if the stub is too thin; measure unique queries per agent.
- `require_parameters: true` can narrow provider choice and raise latency or price; measure.

## 6. What happens to `multi-agent-evals-and-memory.md`
Still useful, partly overtaken. Phase 0–1 (run summaries, fixtures) are done here as Phase 0. Re-scope the rest: keep the golden-run/regression idea (this spec's fixture replay is its first instance); move "replay a run with a changed prompt" to Spec B; defer memory phases until a measured need exists (no data in the observed run shows a need for cross-run memory).

## 7. `/goal` prompt skeleton
> Implement `specs/multi-agent-reliability-and-cost.md` phases 0–10 in order. For each phase: read CLAUDE.md and progress.md, write the tests first, implement, run `npm test` and `pytest resources/python`, add a progress.md row, bump the version, commit without push. Stop after Phase 0 and report the baseline numbers before continuing. Do not change `normalise_quote` semantics. Do not add a fetch tool.
