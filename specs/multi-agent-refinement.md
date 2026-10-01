# Multi-agent refinement: parallelism, trace fidelity, sidebar dock, settings

Status: ready for `/goal`. Written 2026-10-01 against `main` at `19faaec`.
Target designs: `designs/` (open `designs/index.html` at 1440px wide). Where this spec and the designs disagree on layout, the designs win. Where they disagree on behaviour, this spec wins.

Read `CLAUDE.md` and `progress.md` first. Standing rules for every phase:

- Append rows to `progress.md`; never edit existing rows.
- Bump the version in `package.json` once, in the final phase.
- Commit per phase. Do not push.
- Tests are additive. Do not weaken or delete an existing assertion to make a change pass; if one is now wrong, change it in the same commit and say why in the message.
- Do not touch `ChatService.ts`. Multi-agent runs through `multi_agent_sidecar.py` and `MultiAgentRunCoordinator.ts`; the single-chat invariants do not apply.
- Design language: `#0a0a0a` surfaces, `rgba(229,57,53,x)` accents, `0.5px rgba(255,255,255,0.05)` hairlines, Inter and JetBrains Mono, red left bar on the active item. No white surfaces anywhere in the app.

---

## What is actually wrong (diagnosis from the code)

Read these before changing anything. Each item has a phase that fixes it.

1. **Workers run one after another because the plan says so.**
   `workers_node` (`resources/python/multi_agent_sidecar.py:537`) already runs a phase's steps with `asyncio.gather`. But `PLANNER_SYSTEM` (line 357) lets the planner choose any `phase` number, and for the itinerary task it put each step in its own phase (the run panel shows "PHASE 1 · SINGLE" through "PHASE 4 · SINGLE"). Phases are also the only dependency model, so a step cannot say what it needs. Secondary suspect: `ask()` (line 298) reserves a worst-case cost before every request and waits on `budget_changed` when the remaining allowance is small; with a pricey model and a tight cap this serialises parallel agents too. Also `loop.run_in_executor(None, work)` uses the default thread pool, whose size is not under our control.
2. **Reasoning and tool activity never leave the sidecar.**
   `_stream_openrouter` (line 221) reads only `delta.content`. It never sends a `reasoning` parameter and never reads `delta.reasoning` or `delta.reasoning_details`. Tool calls are executed in `run_worker` (line 453) but no event is emitted for them. The `AgentEvent` union in `src/shared/types.ts:666` has no reasoning or tool events. So the UI can only show output tokens, which matches the screenshots.
3. **The reflection gate is real, but weak and quiet.**
   It is a model call (line ~500), not a placeholder. Problems: it sees only the final output, not the tool evidence behind it; its prompt is one sentence, so everything scores 5/5; an unparsable reply silently scores 3 ("scored neutral") and can pass; the UI shows the reflection text but not which model judged or what it judged against.
4. **Model config probably is used, but nothing proves it and one fallback is silent.**
   `DEFAULT_MULTI_AGENT_CONFIG.models.worker` is `''` (`src/shared/types.ts:536`), and the Worker dropdown shows "Use active OpenRouter model". So four workers on `deepseek/deepseek-v4.1-flash` is the designed result of that blank, while Orchestrator, Reflection and Synthesizer default to Llama and Qwen. The real problems: the UI never says which model each role will use or did use, and `resolveModel` in `MultiAgentRunCoordinator.ts:122` silently swaps any model missing from the catalogue for the active model. Verify with a test, not by assumption.
5. **Layout.** The run renders as a separate plan pane (`MultiAgentPlanPane`, mounted in `Layout.tsx:518`) plus a full-page execution area (`MultiAgentExecutionArea`), with `planCollapsed` / `sidebarMode` mutual-exclusion state in `Layout.tsx:155-165`. The multi-agent rail button is commented out in `Sidebar.tsx:~721`.
6. **White inputs.** `MultiAgentSettingsPanel.tsx` uses `bg-surface-elevated`, `border-surface-border`, `text-content-primary`. The white-on-white result means at least one of these tokens is missing from `tailwind.config.js`, or native `<select>` and `<input>` fall back to browser defaults. Find out which; fix at the token or primitive level, not per input.

---

## Phase 0. Measure before changing (small)

Goal: every claim in the diagnosis has a failing or passing test that pins it.

1. Sidecar test harness: a fake OpenRouter server (local HTTP, SSE) that can hold a response open for N ms and records request start and end times per model. Extend `MultiAgentSidecar.integration.test.ts` rather than starting a new file if it fits.
2. Test A, parallelism: plan with three steps sharing no dependency, each response held 300 ms. Assert the three request windows overlap (max start < min end). Expect this to pass today when the plan has one phase and fail for a chain; record both.
3. Test B, budget serialisation: same plan, cap just above one worst-case reservation. Record whether requests serialise. If they do, Phase 1 item 5 is required, not optional.
4. Test C, models reach the wire: configure four distinct role models, run a one-step plan, and assert the `model` field of each outgoing request (planner, worker, reflection, synthesis) equals the configured role model. Also assert the coordinator's `start()` result carries the resolved models.
5. Test D, silent fallback: configure a model not in the catalogue and assert the current behaviour (falls back to the active model). Leave it passing for now; Phase 3 flips it.

Done when: tests A–D exist, run in `npm test`, and the commit message states which of A and B failed.

## Phase 1. Real parallelism (sidecar + types)

1. **Dependency graph replaces phases.** Plan steps become `{ id, label, role, dependsOn: string[] }`. Keep `phase` in the type as a derived display field (longest dependency depth + 1) so old persisted traces and `estimateRunCost` keep working. Accept the old `phase`-only shape in `parse_plan` and convert it, so a planner that ignores the new format still works.
2. **Scheduler.** Replace the phase loop in `workers_node` with a ready-queue: start every step whose dependencies have all passed, up to `maxAgents` at once, as `asyncio.Task`s. When a step finishes, start newly ready steps immediately (no waiting for a whole phase). A failed dependency marks dependants `agent_failed` with reason "dependency 1.2 failed" and continues the rest of the run, as the current partial-failure behaviour does. Keep the budget-cap behaviour: no new step starts once `run.budget_reached`.
3. **Planner prompt.** Rewrite `PLANNER_SYSTEM`: split the task into the largest set of steps that can run at the same time; a step may depend on another only if it needs that step's output, and must list it in `dependsOn`; research, comparison and per-region or per-source work is parallel by default; a final assembly step may depend on the others. State the cap. Add a post-parse check: if the plan has two or more steps and every step depends on the previous one (a pure chain), send one correction message asking for either a parallel split or a one-line justification field `chainReason`; accept the second answer either way. Log which happened.
4. **Executor.** Create one `ThreadPoolExecutor(max_workers=maxAgents * 2 + 4)` per run (workers, reflection, and synthesis can overlap) and pass it to `run_in_executor`. Shut it down when the run ends or aborts.
5. **Budget reservation.** If Phase 0 test B showed serialisation: reserve against the model's real `max_tokens` clamp (already computed in `plan_request`), not the context window, and when the allowance is short, shrink `max_tokens` before waiting. Never wait while other requests hold less than half of the shortfall. Keep the spec §06 guarantee: no spend past the cap.
6. **Events.** `orchestrator_plan` carries `dependsOn`. No `agent_queued` event: the renderer derives queued from the plan. Add a monotonic `ts` (ms since run start) to every event if it is not already there; the timeline in the design needs it.
7. **Estimate.** `estimateRunCost` in `src/shared/multiAgentModels.ts` iterates phases to grow prior context. Make it use the derived depth, and keep its existing tests green.

Done when: Test A passes for a three-way fan-out with a dependent fourth step; the fourth starts as soon as its last dependency passes, not at a phase boundary; abort cancels all running tasks and the executor shuts down (no orphaned threads or sidecar processes); a pure-chain plan triggers exactly one correction request.

## Phase 2. Trace fidelity: reasoning, tool calls, honest gates

New events (add to the `AgentEvent` union in `src/shared/types.ts`, the sidecar, `MultiAgentRunCoordinator`, `multiAgentRunState.ts`, preload typings, and `api.mock.ts`):

| Event | Payload |
|---|---|
| `agent_reasoning` | `{ agentId, attempt, token }` streamed, coalesced like `agent_token` |
| `tool_start` | `{ agentId, attempt, callId, tool, server, argsPreview }` |
| `tool_done` | `{ agentId, attempt, callId, ok, durationMs, resultPreview, resultChars }` |
| `reflection_result` (extend) | add `model`, `attempt`, `rubric: string[]` |

Every agent event also carries `attempt` (0-based) so a retry's trace is separate from the first attempt's.

1. **Request reasoning.** In `_stream_openrouter`, send `"reasoning": {"effort": "medium"}` unless the model's catalogue entry says it does not support reasoning (add `supportsReasoning` to `OpenRouterModelInfo` from the catalogue's `supported_parameters`). Add a per-run `reasoningEffort` in `MultiAgentConfig` (`off | low | medium | high`, default `medium`), shown as a segmented control in settings.
2. **Read reasoning.** From each streamed delta read `delta.reasoning` and `delta.reasoning_details[].text`; forward as `agent_reasoning`. Keep it out of `output` and out of what is passed to reflection and synthesis. Preserve `reasoning_details` on the assistant message sent back with tool results, as OpenRouter requires for tool-using reasoning models.
3. **Tool events.** In `run_worker`, emit `tool_start` before `wait_for_approval` resolves into execution and `tool_done` after the result. Previews are capped at 400 characters for args and 1,200 for results; full results stay in the sidecar message history only. Denied and rejected calls emit `tool_done` with `ok: false` and the reason.
4. **Persist and replay.** `executionTrace` already stores ordered events; confirm 5,000+ events do not break persistence (reasoning is chatty). Coalesce consecutive `agent_reasoning` and `agent_token` events of the same agent and attempt into one stored event per 250 ms window. `multiAgentRunState.ts` reduces them into per-agent `timeline: Array<Reasoning | Tool | Output | Gate>` in arrival order; keep it a pure function with exact-value tests.
5. **Reflection gate honesty.**
   - Give the reviewer the subtask, the overall task, the list of tool calls made (names and result previews), and the output. Rubric: answers the subtask; claims backed by tool evidence or marked as unverified; no invented bookings, prices or timetables; consistent with earlier agents' outputs for dependent steps. Return `{ score, reason, issues: string[] }`.
   - An unparsable reply is not a pass. Retry the reflection call once; if it fails again emit `reflection_result` with `passed: false` and reason "gate unavailable", and count it as a failed attempt.
   - Show the gate in the card with the model name, score, reason and, on failure, the issues.
   - Add a deterministic precheck before the model call: empty output, output under 40 characters, or an output that is only a refusal/disclaimer fails without spending tokens.
6. **Tests.** Fake OpenRouter streams that include `reasoning` and `reasoning_details` deltas and tool calls; assert the event order `agent_start, agent_reasoning*, tool_start, tool_done, agent_token*, agent_complete, reflection_start, reflection_result`. Assert reasoning text never appears in the synthesis prompt.

Done when: a run against the fake server shows reasoning, two tool calls and an answer for one agent in order; a failed gate retries with its issues injected; "gate unavailable" cannot pass.

## Phase 3. Config truthfulness

1. **Snapshot.** Emit one `run_config` event right after `orchestrator_plan` with the resolved model per role, whether each came from `saved`, `default` or `active` (fallback), plus `maxAgents`, budget cap, threshold, retries, and `reasoningEffort`. Store it with the trace so a finished run shows what it actually used.
2. **No silent fallback.** In `resolveModel`, a configured model missing from the catalogue now fails the start with a clear message naming the role and model, unless the catalogue itself could not be fetched (then use the configured id as-is and say so in `run_config`). A blank worker model still follows the active model and is labelled "follows active model".
3. **Settings summary.** Add the "Models the next run will use" block from `designs/03-settings.html` above the form: four rows, model id, source chip (`saved`, `follows active model`, `not in catalogue · using active model` becomes `not in catalogue · run will not start`). It updates live as dropdowns change, before saving, with a quiet "unsaved changes" marker on the save bar.
4. **Run header.** The agent view header (Phase 4) lists orchestrator, reflection and synthesizer models as small chips under the run title, next to each agent's own model.
5. **Tests.** Test C and D from Phase 0 now assert the new behaviour; add a renderer test for the summary block with each source state.

Done when: changing the Orchestrator dropdown and starting a run puts that model on the planner request (Test C), and an unknown model is reported, not swapped.

## Phase 4. Sidebar dock (the main UI change)

Follow `designs/01-dock-live.html` and `designs/02-states.html`. The principle: the multi-agent view is the sidebar, widened. No separate pane, no full-page execution area.

1. **Rail button.** Un-comment and rebuild the multi-agent rail button in `Sidebar.tsx` below Favourites (icon: three-node network, already imported as `Network`). Visible when the OpenRouter backend is active and the active chat has a multi-agent run or one is starting. States per `02-states.html`: red glow plus count badge while agents run; amber glow plus badge when any agent awaits approval; quiet green when the last run finished; plain when open. Glow animation respects `prefers-reduced-motion`.
2. **One sidebar panel, two widths.** Extend `sidebarMode` from `'chat' | 'starred' | null` to include `'agents'`. The existing animated panel (`PANEL_WIDTH = 264`, 220 ms width transition) takes a width per mode: 264 for chat and starred, 760 for agents. The inner container stays fixed-width per mode so content does not reflow mid-animation. Content for `'agents'` replaces the chat list inside the same panel.
3. **Delete the old pieces.** Remove `MultiAgentExecutionArea` and the "Agents running" page, remove the separate `MultiAgentPlanPane` mounting from `Layout.tsx`, and remove `planCollapsed`, `togglePlan`, and the mutual-exclusion code in `Layout.tsx:155-165`. Move what is worth keeping into a new `MultiAgentSidebarView` hosted by the sidebar:
   - Left column (248 px): run title, Abort, cost and tokens against the cap, the **concurrency timeline** (one row per agent, bars from `ts`, a "now" line, dashed bars for queued, the caption "N agents running in parallel"), the step list with status dots, dependency hint for waiting steps ("Waits for 1.1, 1.2"), and orchestrator and reflection model chips in the footer.
   - Right column: one accordion card per agent. Header: status dot, id and label, role and model, tokens, cost, elapsed, state tag. Body: the timeline from Phase 2 in arrival order, with Reasoning (dim italic, clamped to three lines, click to expand, "Reasoning · 14s"), Tool call rows (`name`, args preview, result count or chars, duration, expandable), Answer (streamed, markdown), and the reflection gate. Approval requests render inline as an amber block with Approve, Deny, and Trust this agent. The running agent is expanded; passed agents collapse to their header; clicking a step in the left column opens and scrolls to its card (reuse `onSelectAgent` / `focusAgentId`).
   - Pre-flight approval (plan preview, cost range, Approve and Cancel) renders in the same view before any agent starts, replacing the card column.
4. **Main chat stays a chat.** While a run is live, the main area shows the user message, a compact "Viewing agent run · close" pill if the dock is open, and a Final synthesis block that says "Starts when every agent has passed its gate. Currently N of M passed." then streams the synthesis. No agent cards in the main area.
5. **Keep "View agent run".** For a chat with a saved run, the pill opens the dock on that chat's persisted trace in read-only mode (no Abort, no approvals). Remove "Back to chat"; closing the dock is clicking the chat or favourites rail icon, the pill, or pressing Esc.
6. **Auto behaviour.** Sending a multi-agent task opens the dock. When a run finishes the dock stays open until the user closes it. Switching chats while the dock is open loads that chat's run if it has one, otherwise shows the empty state "No agent run in this chat yet" with a line telling the user to turn on Multi-Agent in the input bar.
7. **Streaming lock.** The existing overlay that blocks sidebar clicks during a single-chat stream must not block the dock during a multi-agent run (the user needs Abort and Approve).
8. **Performance.** Per the open M1 Pro issue, do not add `motion.*` or JS-driven animation to the dock. Use CSS transitions only. Agent token and reasoning updates are batched to one render per animation frame. Cards that are collapsed do not render their timelines.
9. **Tests.** Update `MultiAgentUI.test.tsx`, `MultiAgentModeButton.test.tsx` and `useMultiAgentRun.test.tsx` for the new structure; add tests for the rail button states, panel width per mode, accordion open/close, step click focusing a card, read-only mode hiding Abort and approvals, and Esc closing.

Done when: screenshots at 1440x900 of the live run, finished run, and chat-list states match the designs in layout and state, and no code path still references `MultiAgentPlanPane` or `MultiAgentExecutionArea`.

## Phase 5. Dark form controls everywhere

1. Find the cause: check `tailwind.config.js` for `surface.elevated`, `surface.border`, `content.primary`; check the global styles for `input`, `select`, `textarea` resets in `globals.css`. Report which was missing in the commit message.
2. Add small shared primitives in `src/renderer/src/components/ui/`: `TextInput`, `NumberInput`, `Select`, `Checkbox`, `RangeSlider`, styled per `designs/base` tokens: field background `#131313`, hairline border, `#ebebeb` text, red focus ring, custom chevron, red-tinted checked checkbox, red slider track. `color-scheme: dark` on the root so native popups render dark.
3. A custom listbox is only needed for the model pickers (long lists with a price column). Build `ModelSelect` as a keyboard-accessible listbox (type to filter, arrow keys, Enter) showing `id`, price per 1M, and context in aligned columns, as in `designs/03-settings.html`. The other selects can stay native with `color-scheme: dark`.
4. Rebuild `MultiAgentSettingsPanel.tsx` on these primitives, with the Phase 3 summary block. Add the reasoning-effort control from Phase 2.
5. Sweep: grep `src/renderer` for `bg-white`, `bg-gray-`, `bg-neutral-`, and for bare `<input` / `<select` / `<textarea` not using the primitives, and fix the other settings panels if they are affected. Add a test that fails if `bg-white` or `text-black` appears in `src/renderer/src` outside an allow-list.
6. Contrast: body text on field backgrounds at least 7:1; placeholder and help text at least 4.5:1 (the current help text in the designs is intentionally quiet; check it and raise it if it fails).

Done when: the Multi-Agent settings page has no white surface, every control is readable, and keyboard-only use of the model pickers works.

## Phase 6. Close out

1. `npm run typecheck` (or the repo's equivalent), `npm test`, and the sidecar tests all green; run coverage and make sure the new files meet the repo's usual bar.
2. One real end-to-end run against OpenRouter using the itinerary prompt from the screenshots, with cheap models. Confirm: at least two agents overlap in the timeline; reasoning and tool calls appear in a card; the gate shows its model; the final synthesis cites agents. Save the screenshots to `designs/shipped/`. If no API key is available in the environment, say so and stop short of this step; do not fake it.
3. Update `specs/MULTI_AGENT_SPEC.html`'s checklist and layout state-machine table (the "plan pane" and mutual-exclusion rows are now wrong) or add a short addendum pointing at this file; do not rewrite the original objectives.
4. Append `progress.md` rows, bump the version in `package.json`, update `CHANGELOG.md`, commit.

---

## Decisions made in this spec (change any of them by editing this file)

- Dependencies are explicit (`dependsOn`), phases are derived. Chosen over "keep phases and just prompt better" because phases cannot express "starts when 1.1 and 1.3 are done, not 1.2".
- Reasoning is requested by default at `medium`. It costs tokens; the setting can turn it off.
- A gate that cannot produce a verdict counts as a failure, not a pass.
- An unknown configured model stops the run instead of silently swapping.
- The dock is 760 px wide at 1440 px windows. Below a 1280 px window the dock overlays the chat instead of pushing it; the timeline column hides first.

## Out of scope

Docker or E2B sandbox changes, background agents, a user-editable graph, per-agent model overrides, and anything in `ChatService.ts`.
