# Multi-agent UI rectification

**Status:** Draft for approval. Follows `multi-agent-assess-loop-and-ui.md` (Spec B, shipped 3.2.63). Fixes UI problems found by using Spec B's surfaces on a real run.
**Read first:** `CLAUDE.md`, `progress.md`, `multi-agent-ui-improvements.md` (design language, overlay and dock rules), and Spec B sections 7a to 7d.
**Rules:** no new keyword or regex heuristics; verify visually in a browser or the app at the widths listed in R2; every fix gets a test that would have caught it.

## 0. What was found

| # | Problem | Where (code) | Root cause |
|---|---|---|---|
| R1 | The Gantt hover popup stays open until you click Close, and it offers "Open call record", which throws you into a verbose log. | `components/chat/GanttView.tsx` L44 (`onMouseEnter` sets `picked`, nothing clears it), L106-117 (popover with buttons) | Hover opens it, nothing closes it. The call-record button was my spec's idea (design 13) and is not wanted. |
| R2 | The new Gantt tab makes the top bar overflow: the tab group collides with the system-prompt and download buttons. | `components/layout/TopBar.tsx` L318-350 (`ma-topbar-cq`, left cluster with mode pill + 3-tab toggle, `top-bar-actions` on the right) | The left cluster is wider than before and cannot shrink; the right cluster is `flex-none`; nothing yields at narrow widths. |
| R3 | "Lock output" appears on a finished run, nobody knows what it means, and it fails with `Sidecar lock failed (404)`. | `components/chat/StepControls.tsx` L69-73, `MultiAgentRunCoordinator.lockStep` (calls the sidecar first), sidecar `lock_step` (404 when the run is neither live nor in saved state) | The feature only matters for re-runs and follow-up waves, which a finished run does not have. The UI never explained it, and the error is the raw IPC string. |
| R4 | "View claims" opens the drawer behind the agent modal, and it is blank ("No claims", filter chips shown with `all 0`) on a new run whose answer cites 1.3. | `components/chat/ClaimsDrawer.tsx` L106 (`z-50`) vs `AgentFocusView.tsx` L127 (`z-[70]`); `lib/claimsView.ts` `acceptedClaims` needs `gate.claims` from a `reflection_result` event | z-order bug. Blank: the drawer only reads claims from the passing attempt's `reflection_result`; any path that finishes an agent without that event (for example the budget-reached early return in `run_worker`, which skips `reflection_result`) leaves it empty. The real cause for the run in the screenshot must be confirmed from its saved trace. |
| R5 | The miniature chart in the List view looks bad (segments drawn on top of the green status bar). | `MultiAgentSidebarView.tsx` `ConcurrencyTimeline` L272-316, added in Spec B 7c (commit e1c714c) | The segment overlay was added to a chart that was designed as a simple status bar. |
| R6 | Step action errors show as raw IPC text ("Error invoking remote method 'multi-agent:lock-step': Error: ..."). | `StepControls.tsx` `run(...)` error display | No message mapping. |

## 1. Goals

### R1. Gantt popup is hover-only and informational
- The popup shows while the pointer is over a segment, and disappears when the pointer leaves (no click needed). It also shows on keyboard focus of a segment and hides on blur or Escape.
- It is a tooltip: `pointer-events: none`, positioned next to the hovered segment (above it, flipped below if it would clip, clamped inside the Gantt container), not at a fixed corner.
- Remove the "Open call record" and "Close" buttons and the `obsOpenMultiAgentRunFile` call from `GanttView`. Content stays: lane, segment kind, duration, approval mode, tool vs wait time, on-critical-path.
- Clicking a segment does nothing.
- **Acceptance (Vitest):** `mouseenter` on a segment shows the tooltip; `mouseleave` removes it; focus/blur does the same; no button exists inside `gantt-popover`; moving directly from one segment to another shows only the second. Visual check: the tooltip never overlaps the segment it describes and never clips at the right or bottom edge.

### R2. Top bar never overlaps
Design rule: the right cluster (`top-bar-actions`: system prompt, download, etc.) is never overlapped, moved or clipped. The left cluster gives way, in this order, as the bar narrows:
1. Full: mode pill with label, text tabs `List | Graph | Gantt`.
2. The mode pill label ("Multi-agent") hides and only the status dot and icon remain.
3. The view tabs become icon-only (list, graph, gantt icons) with accessible names and tooltips.
4. If it still does not fit, the left cluster scrolls or clips with `min-w-0 overflow-hidden`; it never grows over the right cluster.
Use the existing container-query setup (`ma-topbar-cq`) rather than viewport media queries. The sidebar-collapsed padding (`pl-[80px]`, traffic-light room) is part of the budget.
- **Acceptance:** a Vitest layout test cannot measure real widths, so the agent must render the top bar in a browser (headless Chrome over CDP; Playwright is not a project dependency) at container widths 1100, 900, 760 and 640 px, in both sidebar-collapsed and expanded states, and check that no element in the left cluster's bounding box intersects the right cluster's. Save the 8 screenshots under `specs/designs/rectification/` and reference them in progress.md. Add a unit-level test of the breakpoint classes (each step hides or shows the right elements).

### R3. Remove Lock from the UI
Decision (from the user): "what even is this lock button" means it goes.
- Remove every lock affordance: the "Lock output" / "Unlock output" button and the "Locked" note in `StepControls`, any lock icon in `PlanEditor`, and lock mentions in copy.
- Keep the backend (`step_locked` events, `/lock` route, `locked` in saved state, `lockStep` IPC) so old traces still load; mark them "unused by UI" in a code comment. Old runs that contain `step_locked` events must still render without error.
- "Re-run on..." stays only if it works on a finished run: the agent must test re-run on a finished run from a saved trace. If it is unavailable (for example, "Only the latest run of a chat can be resumed or re-run", or no saved state), disable the button with a one-line reason shown inline ("Re-run is only available for the latest run of this chat"), never a raw error.
- **Acceptance:** no element with text "Lock" in `StepControls` or `PlanEditor`; a trace containing `step_locked` loads; re-run on an ineligible step shows the plain-language reason; no 404 can be triggered from the UI.

### R4. Claims drawer: layering and content
1. **Layering.** Define overlay layers in one place (`components/chat/zLayers.ts`: dock, agent focus modal, claims drawer, approval slide-outs, popovers) and use it everywhere these are rendered. The drawer is above the agent focus modal. Opening it from the modal does not close the modal. Escape closes the topmost layer only (the drawer first, then the modal). Clicking the drawer's backdrop area, if any, closes the drawer only.
2. **Blank claims.** Find the root cause from the run in the screenshot (latest run, step 1.3 "Leg 3 schedule and connection researcher", deepseek-v4.1-flash, 15 tool calls, score 5/5): read its saved trace (the app database, `multi_agent_runs`, or the run's jsonl log) and replay it through `applyAgentEvent` and `acceptedClaims`. Fix at the source, with a regression test built from that trace:
   - every path that ends an agent with an answer must emit its claims, including the budget-reached early return in `run_worker`, the resumed or re-run path, and the degraded path;
   - `acceptedClaims` falls back to the `agent_complete` event's claims (or the last attempt's) when no gate carries them.
   If the cause turns out to be different from these, say what it was in progress.md.
3. **Honest empty state.** When an agent truly has no claims, the drawer says why in one line ("This step ended without a claims check (budget reached)" or "This step produced no claims"), and the filter chips are hidden. Never a blank panel with `all 0`.
- **Acceptance:** Vitest with the real trace fixture: 1.3's drawer lists its claims with statuses; a unit test for each emitting path (pytest with the fake harness); layer-order test asserting `claimsDrawer > agentFocus` from `zLayers.ts` and an Escape-order test; the empty states render the right sentence.

### R5. List view's mini chart returns to the simple version
- Restore the pre-7c `ConcurrencyTimeline`: one status bar per agent, coloured by status (green done, amber caveats or running, red failed, queued grey), `ma-lane-bar` with `data-s`, no segment overlay, no `buildSegments` call. Take the pre-7c code from `e1c714c^` (`MultiAgentSidebarView.tsx` L262-300) and keep the caption ("Peak: N agents in parallel").
- The segmented view lives only in the Gantt tab. The compact `GanttStrip` in the Graph dock's Run log is left as it is unless it shows the same overlaid-bar look; if it does, show only the segments (no underlying status bar), and say so in progress.md.
- **Acceptance:** `MultiAgentUI.test.tsx` expectations for `concurrency-timeline` pass with no segment elements inside it; the Gantt tab still shows segments.

### R6. Human-readable errors from step actions
- Add one function (`describeActionError`) that strips Electron's "Error invoking remote method '...': Error:" wrapper and maps known failures to plain sentences: no saved run state, run not latest, run already in progress, no OpenRouter key, sidecar unavailable. Unknown errors show the stripped message.
- Use it for re-run, steer, assess actions (Run follow-up, Finish now) and anywhere else `StepControls` or `CoveragePanel` call IPC.
- **Acceptance:** unit tests on `describeActionError` for each mapped case and one unknown case; no rendered error contains "Error invoking remote method".

## 2. Out of scope
New designs; the Spec C work on conflict detection and other heuristics; changing assess or ledger logic; removing the lock from the sidecar or database.

## 3. Verification checklist (agent reports each in progress.md)
1. Popup: hover on and off in a browser, including moving across adjacent segments.
2. Top bar screenshots at the 8 width and state combinations, with no overlap.
3. A finished run's step panel: no Lock, working or clearly disabled Re-run, no raw error.
4. View claims from the agent modal: drawer on top, Escape order right, claims populated for 1.3 from its real trace.
5. List view mini chart matches the pre-7c look.
6. `npm test`, `pytest resources/python` and the typecheck are green. The renderer typecheck gap noted in the Spec B close-out is not part of this spec, but any error in a file this spec edits must be fixed.

## 4. `/goal` prompt
See the goal text in the conversation; it is copied here for the repo:

> Implement `specs/multi-agent-ui-rectification.md` (R1 to R6) without stopping for confirmation. Read CLAUDE.md, progress.md and the spec first. Per goal: failing test first, implement, run `npm test`, `pytest resources/python` and the typecheck, add a progress.md row, bump the version, commit without pushing. Do not ask questions; where the spec and the code disagree, choose the option closest to the spec's intent, record "Decision: ..." in progress.md and the commit message, and fix the spec text. Stop only for a destructive action, missing access to the saved run needed for R4, or a gate failing after 3 honest attempts. No keyword or regex heuristics. Verify R1 to R5 visually in a browser at the widths in R2 and attach the screenshots. Finish with one summary: what changed, decisions taken, anything unverified.
