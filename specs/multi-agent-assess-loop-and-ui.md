# Multi-agent assess loop, coverage ledger and power-user UI (Spec B)

**Status:** Draft for approval. **Run after** `multi-agent-reliability-and-cost.md` (Spec A), so every gain here is measured against Spec A's `baseline.json`.
**Read first:** `CLAUDE.md`, `progress.md`, Spec A, `multi-agent-ui-improvements.md` (design conventions, dock behaviour), `multi-agent-reflection-hardening.md` (claims contract).
**Designs (for approval before handoff):** `designs/11-claims-evidence-drawer.png`, `12-coverage-assess.png`, `13-gantt-segments.png`, `14-preflight-step-controls.png` (HTML in `designs/source/`). All data in them is sample data.
**Out of scope:** an arbitrary-URL fetch tool or timetable-widget access (separate spec). Until it exists the assess loop must report "no tool can close this gap" and spend nothing on those gaps.

## 0. Why

The graph is a pipe: `plan → approve → workers → synthesize` (`build_graph()`, `multi_agent_sidecar.py` L1600). `workers_node` schedules steps in parallel, but nothing asks "is the task actually done?". In the observed run the leg-2 conflict, the exact-date times, and the baggage and taxi-price conflicts all went into the final answer as caveats with no chance to close them. Anthropic's research system has this edge (the lead agent decides whether more research is needed); we keep the static first wave (parallel research is the right default) and add one bounded feedback edge, not a free-roaming supervisor (costlier, harder to evaluate).

Power users also cannot see why a run took 7 minutes, cannot inspect the evidence behind a `[1.2]` chip, and cannot edit the plan or re-run one step.

## 1. Goals
- B1 Acceptance checklist emitted by the planner.
- B2 Coverage ledger computed from claim statuses (no model call).
- B3 `assess` node: `done | follow_up | ask_user`, with hard stop rules.
- B4 Conditional steps (`condition` on a step).
- B5 Shared evidence handoff between agents and waves.
- B6 Durability: SQLite checkpointer and "re-run from step N".
- B7 Replay from logs (judge/synthesizer only) for iteration and evals.
- B8 UI: claims and evidence drawer (design 11); coverage matrix and assess decision (12); Gantt with real segments (13); pre-flight plan editor and step controls (14); notifications on "Needs you"; follow-up research settings (7f).

## 2. Phases

### Phase 1: Checklist and ledger (B1, B2)
- `PLANNER_SYSTEM` (L753): add `checklist: [{id, text, scope?: stepId | "global"}]`. Each requirement is atomic and checkable ("baggage allowance, leg 2"), max 25. Also each step lists `covers: [checklistId]`.
- `Run.ledger: dict[checklistId → {status, claimIds[]}]`. Status per requirement, computed deterministically after each worker passes the gate:
  - `verified`: ≥ 1 verified claim and no conflict;
  - `unverified`: only `unverified_declared` claims;
  - `conflicted`: two verified claims from different agents that disagree (see below);
  - `missing`: covered by a step that finished with no claim for it; `pending`: step not finished.
- **Claim-to-requirement mapping:** each claim carries optional `req: checklistId` in the claims block (worker is told its `covers`). Unmapped claims count but do not fill requirements.
- **Conflict detection:** two verified claims with the same `req` and different values. Cheap heuristic first (normalised numbers/dates/days differ); if ambiguous, defer to the assess model call. Never assert a conflict from the heuristic alone in the UI; label it "possible conflict" unless the assess model confirmed it.
- Event `ledger_update {ledger}` after each step, and in `RunView`.
- **Acceptance:** `test_ledger.py` with the Istanbul fixture (checklist and claim tags in `tests/fixtures/runs/istanbul-3leg/checklist.json`, because the recorded planner predates the checklist): 12 verified, 3 unverified (exact-date times on all three legs), 3 possible conflicts (leg-2 days, AJet Premium 25 vs 30 kg, and one known heuristic false positive: TK economy vs business cabin), 0 missing. No model call in this phase. Planner without a checklist (older runs) → ledger disabled, the assess node is skipped.
- **Decision (implemented):** design 12's 11 / 4 / 2 / 1 is sample data drawn on the old run with its merge step 2.1 (removed by Spec A Phase 4); the acceptance is the recorded claims' own counts above. The planner replies `{"steps", "checklist"}` (a bare array still parses, without a checklist). `req` may be one id or a list, for a claim that answers several requirements (e.g. one airline's baggage rules on two legs). Conflict heuristic: most subject words shared (3 of 4, units excluded), no different airport codes, and different weekdays, or numbers that are not within 15% of each other with neither claim's numbers contained in the other's.

### Phase 2: Assess node and stop rules (B3)
New node between `workers` and `synthesize`; conditional edge back to `workers` (wave n+1).
- **Input** (small, ≤ 4k tokens): ledger, open requirements with their claim texts, the tool list actually available, remaining budget and waves, previous wave's ledger.
- **Fast path, no model call:** all requirements `verified` → `done`.
- **Otherwise** a cheap model (`models.assess`, default the judge model, low effort, `max_tokens` 800) returns JSON: `{decision: "done"|"follow_up"|"ask_user", steps: [{title, task, covers[], condition?}], unclosable: [{checklistId, reason}], question?}`.
- **Hard stop rules enforced in code, not trusted to the model.** Force `done` when any is true: wave cap reached (`maxWaves`, default 2, so at most 1 follow-up wave); remaining budget < the estimated cost of the proposed steps; the ledger did not improve versus the previous wave (open count not lower); no proposed step maps to an available tool (record the gap in `unclosable`, e.g. "exact-date departure times: no available tool"). `unclosable` items are passed to the synthesizer as mandatory caveats and shown in the UI. `ask_user` pauses via the existing `hitl_pause` mechanism with the question; timeout follows `hitlTimeoutMs` and then proceeds as `done`.
- **Auto-run vs approval:** follow-up steps run automatically if cost ≤ `followUpAutoUsd` (default 0.15) and ≤ remaining budget; otherwise they appear as a pre-flight-style approval (design 12 "Run follow-up / Edit steps / Finish now"). Follow-up steps go through the same plan-validation as the planner.
- **Events:** `assess_start`, `assess_decision {decision, steps, unclosable, costUsd}`, `wave_start {n}`.
- **Decisions (implemented):** the wave cap and the no-progress rule are checked before the assess call, so a run they stop spends nothing on assessing (`maxWaves: 1` never calls it); the budget and tool rules depend on the proposal and are checked after. A follow-up step must name its tools; one naming none or a missing tool is not run, and its requirements become unclosable. The step estimate is the mean worker spend of the finished steps (conditional steps at 50%). `followUpAutoUsd: 0` always asks (auto-run needs a positive threshold). A later wave's verified claims settle a requirement, so a follow-up can resolve a conflict. An `ask_user` answer goes to the synthesizer (no extra wave). Follow-ups depend on the steps whose claims they re-check. Pauses use `hitl_pause` with agentId `assess` (toolName `approve_followup` or `ask_user`). Assess calls are their own role (`assess`) in call records and the baseline summary.
- **Acceptance:** `test_assess.py` with the fake harness: (a) all verified → `done` with no model call; (b) conflict + capable tool → one follow-up wave then `done`; (c) gap with no capable tool → `done` and `unclosable` set, no spend; (d) wave cap and no-progress rule force `done` even if the model says `follow_up`; (e) budget exhausted forces `done`; (f) `ask_user` timeout proceeds. Evaluate on the fixture: the assess decision flags the leg-2 conflict and the exact-date gap.

### Phase 3: Conditional steps (B4)
- Plan schema: `step.condition?: {on: stepId, predicate: string}`. Evaluated when `on` passes the gate, by a single cheap yes/no model call with the dependency's claims (no call if the dependency produced no claims → skip with reason `no_basis`). Result `run` or `skipped {reason}`.
- `workers_node` treats a skipped step as satisfied for dependants. `agent_skipped` event; the UI shows it dimmed with the reason (design 14, step 1.3).
- **Decisions (implemented):** the condition stays Spec A's string (Amendment 3), with the step ids it names as dependencies; the check runs when all of them end, over their verified and declared claims. An answer that is neither yes nor no runs the step (research is not dropped on a guess). The check uses the assess model (role `condition`). The pre-flight counts a conditional step at 50% in both the low and high bound. A skipped step's requirements read `missing`.
- **Acceptance:** `test_conditional_steps.py`: skipped when false, runs when true, downstream steps unblock either way; cost estimate in pre-flight counts a conditional step at 50% and labels it.

### Phase 4: Shared evidence handoff (B5)
Builds on Spec A Phase 6 (`read_evidence`).
- A follow-up or dependent agent gets a read-only view of its dependencies' evidence (`read_evidence(agentId, snippetId)`) and their verified claims as a compact list, not just prose. Evidence store stays per-run; access is by id.
- Cross-agent claims may cite `source: "1.2"` (existing) or `snippets: ["1.2/S3.2"]`.
- **Decisions (implemented):** access is by direct dependency (not transitive); `global` is a plan step field (`"evidence": "global"`). Cross-agent refs are `<agentId>/<snippetId>` (or `<agentId>/<callId>` for legacy claims); the step's evidence view prefixes the dependencies' entries, so the existing verifier, evidence tools and judge excerpts handle them unchanged.
- **Acceptance:** a dependent fake worker cites a dependency snippet and it verifies; an agent cannot read evidence of a step it does not depend on unless flagged `global`.

### Phase 5: Checkpointer and re-run from step (B6)
- Replace the in-memory run state with LangGraph's SQLite checkpointer (`langgraph-checkpoint-sqlite`, matching the pinned LangGraph 0.4.1; verify compatibility first and fall back to a manual state dump if not), stored beside `multi_agent_runs`.
- Persist per-agent messages and evidence (`agent_state` rows keyed by runId, agentId) so a run survives a sidecar restart.
- Resume: on startup, runs marked `running` are offered "Resume / Discard".
- Re-run a step: `POST /runs/{id}/steps/{stepId}/rerun {model?, withDependents}`; marks downstream steps `stale`, not auto re-run. Locked steps (§Phase 7) are never invalidated.
- **Spike and decisions (implemented):** LangGraph 0.4.1 cannot checkpoint `{"run": Run}` (its MemorySaver: "Type is not msgpack serializable: Run"; `langgraph.checkpoint.sqlite` is not installed), so the manual state dump of Amendment 1 is used, on stdlib `sqlite3`. The state file lives in the sidecar's sandboxed workspace (the only place it may write), not in the app database; `multi_agent_runs` gets no `waves` / `checklistJson` columns because both are in the stored trace (`orchestrator_plan.checklist`, `wave_start`). A step that was running when the sidecar died starts over (an approval in flight cannot be replayed), so unfinished steps' messages are not persisted; finished steps never repeat. The API key is never stored: Electron supplies it on resume and re-run. Resume and re-run apply to a chat's latest run only (the trace is saved to that row). A re-run re-synthesizes without an assess wave; dependents not re-run are marked stale and the synthesizer is told.
- **Acceptance:** kill the sidecar mid-run in a pytest, restart, and the run finishes with the finished steps unchanged (no repeated model calls, checked by call count). Re-run of one step leaves other agents' records intact.

### Phase 6: Replay from logs (B7)
- CLI and dev menu: `replay <runId> --stage judge|synthesize [--model m] [--prompt-file f]` loads the stored run (evidence, claims, outputs) and re-runs only that stage; prints cost and a diff of verdicts or the final text against the original.
- Same mechanism feeds Spec A's fixtures into evals.
- **Decisions (implemented):** with the current verifier the Istanbul judge replay matches the recorded claim-status table except one claim, 1.2 c2 (attempt 2), which Spec A Phase 1 re-points (`quote_not_found` → `verified_repointed`); the acceptance pins exactly that one difference. The dev menu is a "Copy replay command" action per run in Settings → Debug → Multi-agent runs (the CLI needs the sidecar venv and `OPENROUTER_API_KEY`; the app does not run it). `--prompt-file` replaces the stage's whole system prompt.
- **Acceptance:** replaying the judge stage of the Istanbul fixture with the same prompt reproduces the claim-status table exactly (no model drift check; claims are deterministic), and costs only the judge calls.

### Phase 7: UI (B8)
Follow the dark language in `designs/` (Inter + JetBrains Mono, panel `#0a0a0a`, 0.5px borders). Reuse `multiAgentRunState.ts` (`AgentView`, `ReflectionView`, `TimelineItem`), `GraphView`, the bottom dock behaviour from Goal 7, `AgentFocusView`. Four surfaces, each independently shippable, in this order:

**7a. Claims and evidence drawer (design 11).**
- Every `[1.2]` / `[1.2 c3]` chip in the final answer and in agent reports is clickable and opens a right-side drawer (width 560, same slide-out behaviour as the approval slide-outs).
- Drawer shows: the claim, status chips (verified / unverified-declared / conflicted / repointed), judge score, attempt number; the source snippet with the quote highlighted (data: `Run.evidence`; need `get_evidence(runId, agentId, callId)` IPC returning the snippet and raw result, lazy loaded); the conflicting claim as a first-class item; list of the agent's claims with filter chips (all / unverified only / conflicts). "Open raw result" shows the full tool result.
- Status-coloured chips in the answer text (green verified, amber unverified, red conflicted). Chips never imply a status the verifier did not compute.
- **Decisions (implemented):** claims ride on `reflection_result` (compact `claim_view`); the evidence endpoint reads the live run or the Phase 5 saved state. An unconfirmed (heuristic) conflict reads "possible conflict" on chips and "possibly contradicted by" in the drawer; design 11's "conflict" is the confirmed case. A failed check or an unknown status is a grey chip. The run's answer message in the chat gets chips only when its text is that run's `finalOutput`. The synthesizer is asked to cite `[1.1 c3]`. Agent chips take design 11's blue info style.
- **Acceptance:** Vitest + React Testing Library: clicking a chip opens the drawer with the right claim; filters work; a quote is highlighted at the right offset (including after `normalise_quote` differences: highlight maps back to the original text range, not the normalised one); a claim whose evidence is unavailable (old run) shows "evidence not stored" without error.

**7b. Coverage matrix and assess decision (design 12).**
- Matrix: requirements (rows) × scope (columns: the planner's `scope` groups, e.g. legs) with cells `✓ / ? / ⚡ / ·` and source agent ids; click a cell opens the drawer filtered to those claims. Header totals as chips.
- Assess card in the run view and the dock: decision, steps, cost and time of the assess call, stop-rule table (checklist, wave cap, budget, progress, tool can close the gap), the `unclosable` notice, and buttons Run follow-up / Edit steps / Finish now. Timeline strip shows `plan → workers → assess → wave 2 → assess → synthesize`.
- When the decision is `ask_user`, it joins the existing "Needs you" inbox.
- **Decisions (implemented):** checklist items get an optional `topic` so the matrix can group "baggage, leg 1/2/3" into one row (design 12); rows are topics, columns the plan's scopes plus "Whole task". A ledger entry's `claimIds` became the claims that decide its status (so a verified cell never lists an agent whose only claim was declared unverified); the Phase 2 projection pin moved from 2,162 to 2,129 assess input tokens, its costs unchanged. Empty cells read "· missing" / "· pending" (design 12's "· not run" is sample data). "Edit steps" edits the proposed steps' titles and tasks or drops some; it cannot add one, so no step skips the tool check. The Graph dock gets an Assess tab; an assess pause joins Needs you. `maxWaves`, `followUpAutoUsd` and `models.assess` are typed, defaulted and sanitised here (the Settings group is 7f).
- **Acceptance:** view-model tests (`ledger_update`, `assess_decision`, `wave_start` fold into `RunView`); snapshot of the matrix for the fixture; buttons dispatch the right IPC (`assess:run-followup`, `assess:finish`).

**7c. Gantt with real segments (design 13).**
- Replace the "Peak: N agents in parallel" bar with a Gantt (a new tab beside List | Graph, and a compact version in the dock Run log). Lanes: plan, approve, each agent, synthesize. Segment kinds: model, tool, approval wait, judge, repair attempt. Data from Spec A Phase 9 (`waitMs`, `toolMs`) and existing per-call timestamps; no new sidecar data other than those.
- Hover/click a segment: popover with duration, approval mode, critical-path flag, "Open call record"; the footer shows critical path, total retry time, approval wait, judge time.
- Critical path computed in the renderer from `dependsOn` and segment times.
- **Decisions (implemented):** checked first that spec A Phase 9's `waitMs` / `toolMs` / `approvalMode` reach `tool_done` (they do, Amendment 4). A run that predates them (the Istanbul fixture) shows each tool call's whole pause as approval wait, and says so; no tool time is invented. "Trust tool for run" is left out of the popover: trust stays in the approval strips, whose UX is unchanged. An "assess" lane appears when the assess node ran. The List view keeps its caption and status bars and draws the segments over them.
- **Acceptance:** unit test of `buildSegments(run)` and `criticalPath(run)` on the fixture (critical path 1.2 → 2.1 → synth for the old run); a run still in progress renders open-ended segments.

**7d. Pre-flight plan editor and step controls (design 14).**
- Extend `Preflight` (`MultiAgentSidebarView.tsx` ~L296): editable step titles and tasks; per-step model and budget; reorder (dependency re-check on drop; reject cycles); add/remove step; conditional marker; running estimate. "Approve and run" sends the edited plan back to `approve_node` (L986), which validates it with the same checks as the planner output.
- During a run: **steer** (message appended as a user turn at the agent's next round; logged as `steer` event); **re-run on…** (Phase 5 endpoint, with cost estimate; "Re-run + dependents" opt-in); **lock output** (the step's claims and evidence are reused by waves and re-runs).
- **Decisions (implemented):** the editor is a mode of the existing pre-flight ("Edit plan"), so the read view and its tests stay; per-step models are the run's own models (priced at start); reorder is checked against dependency order (a breaking move is undone); "over budget" = step budgets or the low estimate above the cap. No "~min" chip: nothing in the app estimates run time. An invalid edited plan fails the run with the reason (the renderer validates first). A per-step budget forces that step's wrap-up round. Steer and lock are events (`steer`, `step_locked`); a finished run's lock is appended to its saved trace. Step controls live in the focus view rail and the dock's Node tab. Found while building this: `npm run typecheck` never checked the renderer (`tsconfig.json` has `files: []` and references without `--build`); every Spec B renderer type error was fixed, and the 52 errors left in `tsconfig.web.json` are in files Spec B did not touch.
- **Acceptance:** Vitest for edit-validation (cycle, missing dependency, over-budget); an edited plan reaches the sidecar and runs; sidecar tests for steer delivery at the next round and for a locked step not being re-run.

**7e. Notifications.** (Implemented. Decisions: "first Needs you item" = the waiting count leaving zero, so one notification per batch; a new assess question always notifies; the renderer decides when and main decides whether (window unfocused); the toggle is `notifyNeedsYou` in the multi-agent settings store.) On the first "Needs you" item or an `assess` `ask_user` while the window is unfocused, fire an Electron `Notification`; click focuses the run. Setting in `MultiAgentSettingsPanel` (default on).

**7f. Follow-up research settings.** New group "Follow-up research" in `MultiAgentSettingsPanel`, beside the notification toggle. Persisted in the same settings store as the other multi-agent options and passed to the sidecar in `MultiAgentConfig` at run start.
- **Auto-run follow-ups up to** (USD, default `0.15`, min 0, step 0.01). Helper text: "After the first round of research, Claude may propose extra steps to close conflicts or gaps. Follow-ups estimated at or below this amount run automatically; anything above asks you first. Set to 0 to always ask." Maps to `followUpAutoUsd`.
- **Max research waves** (stepper 1-3, default `2`). Helper text: "1 = the first round only, no follow-ups. 2 = the first round plus one follow-up round." Maps to `maxWaves`.
- **Assess model** (model picker, default: the reflection/judge model). Helper text: "Decides whether the run is done. Uses a small, cheap call." Maps to `models.assess`.
- A fixed note under the group: "Follow-ups never exceed the run's budget cap, and never run for gaps no available tool can close."
- Values are validated on save (non-negative, capped at the run budget cap) and the pre-flight and assess card show the effective values ("auto-runs under $0.15").
- **Decisions (implemented):** the stepper is −/+ buttons around the value; an invalid amount stays visible with the inline message and the last valid value is what saves; the assess model is optional (empty = the reflection model) and a set one is checked against the catalogue like the escalation model. The sidecar side of `maxWaves` / `followUpAutoUsd` is covered by `test_assess.py` (maxWaves 1 skips follow-ups and the assess call, maxWaves 2 allows exactly one follow-up wave, 0.15 auto-runs a cheap wave, 0 always asks).
- **Acceptance:** Vitest: defaults render as 0.15 / 2 / judge model; changes persist across reload and reach the config sent to the sidecar; `followUpAutoUsd = 0` forces the approval card for every follow-up; `maxWaves = 1` skips the assess follow-up path entirely; invalid input is rejected with an inline message.

## 3. Data and event changes
`AgentEvent` additions: `ledger_update`, `assess_start`, `assess_decision`, `wave_start`, `agent_skipped`, `steer`, `agent_stale`. `MultiAgentConfig`: `maxWaves` (2), `followUpAutoUsd` (0.15), `models.assess`; all three are user-editable in Settings (Phase 7f). Plan schema: `checklist`, `step.covers`, `step.condition`. DB: `agent_state` table; `multi_agent_runs` gains `waves`, `checklistJson`. Update `src/shared/types.ts`, `multiAgentRunState.ts`, `MultiAgentRunLogger` (run.md shows ledger and assess decisions), and the settings panel.

## 4. Verification
Pytest (fake harness) for Phases 1–6 and the sidecar parts of 7d; Vitest for view-models and components. After Phase 2 and Phase 7 run the Istanbul prompt live and compare to Spec A's `baseline.json`: report cost, wall time, open requirements at finish, and number of caveats. Success looks like: conflicts either resolved or explicitly listed with the reason, no spend on gaps no tool can close, total cost within +25% of the Spec A result.

## 5. Risks
- Follow-up waves can raise cost; mitigated by wave cap, budget rule and no-progress rule, all in code.
- Requirement-to-claim mapping quality depends on the planner; unmapped claims degrade gracefully (ledger shows `?`).
- Conflict detection false positives; the UI says "possible conflict" until the assess model confirms.
- Checkpointer compatibility with the pinned LangGraph 0.4.1; spike first, manual state dump as fallback.
- The Gantt depends on Spec A Phase 9 data; do not start 7c before it.

## 6. `/goal` prompt skeleton
> Implement `specs/multi-agent-assess-loop-and-ui.md` after confirming Spec A's phases are complete and `baseline.json` exists. Work phase by phase in order; tests first; progress.md row, version bump and commit without push per phase. The fetch tool is out of scope: gaps no tool can close must be reported, not worked around. Match the PNGs in `specs/designs/11–14` for layout; use their `source/` HTML for exact colours and copy. Stop after Phase 2 and report the live-run comparison before starting the UI phases.

## 7. Amendments after Spec A (checked against the code at 3.2.48)

These override earlier text in this spec where they conflict.
1. **Phase 5 persistence is manual, not a LangGraph checkpointer.** The graph state is `{"run": Run}`, and `Run` holds a ThreadPoolExecutor, asyncio queues, futures and a Condition, none of which a checkpointer can serialise; `langgraph-checkpoint-sqlite` is also not in `requirements-multi-agent.txt`. Persist the serialisable parts (steps, per-agent messages, evidence, outputs, claims, ledger, wave number, spend) to SQLite and rebuild a `Run` on resume. Do not add a new Python dependency for this.
2. **Waves need a re-entrant `workers_node`.** It currently builds `outputs` locally from `state["steps"]`. For wave 2, pass the wave-1 outputs and claims in as seed state, so follow-up steps can depend on wave-1 steps (`prior = {d: outputs[d] ...}`) and the ledger and evidence store carry over. Add the edge `workers → assess → (workers | synthesize)` in `build_graph()` (L2180); wave counts toward `maxWaves`.
3. **Conditions already parse.** Spec A Phase 10 already stores `step.condition` and adds named steps to `dependsOn`. Phase 3 here only adds the evaluation (run / skipped) and the `agent_skipped` event; do not re-implement parsing.
4. **Settings and data from Spec A exist.** `waitMs`, `toolMs` and `approvalMode` are already on tool events (Phase 9), so 7c can start without adding them. The judge now sees excerpts (radius set in Spec A Phase 3, not 800); use the shipped value.
5. **Merge step is gone.** Design 13 shows a `2.1 Merge` lane and design 11 cites `2.1`; both are sample data from the old run. In the built UI, a second-source claim comes from another step or a follow-up wave (3.x). Do not render a merge lane.
6. **Do not assume Spec A's unverified items.** Attempt-0 pass rate (1/5 offline), the judge still catching 1.5 c7 and 1.2 c2 on excerpts, and `read_evidence` call volume are unverified without a live run. The Phase 2 report here must say "fixture replay" for every number it cannot measure live.
7. **Commit the specs and designs first.** `specs/multi-agent-assess-loop-and-ui.md` and `specs/designs/11-14` are untracked, and `specs/designs/README.md` has an uncommitted edit. Make one docs commit for them before Phase 1, and delete the stray `specs/designs/README.rows.txt`.
