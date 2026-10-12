# Multi-agent UI improvements

**Status: APPROVED (designs and fixes greenlit 2026-10-12). Run one `/goal` per sub-task, in order.**

## Design references (in the repo)

The approved designs live in `specs/designs/`. Read `specs/designs/README.md` first. For each goal, open the matching PNG with the image-capable Read tool before writing code, and open the matching file in `specs/designs/source/` for exact colors, sizes, spacing and copy. Treat the PNGs as the visual target and this spec as the behaviour contract. Where they disagree on behaviour, this spec wins; where they disagree on look, the design wins. All data in the designs (agent names, counts, model names, costs) is sample data. The `.dc.html` sources use `{{hole}}`, `<sc-for>` and `<sc-if>` template tags: read them as markup, do not run them.

| Goal | Image | Source |
|---|---|---|
| 1 | `specs/designs/01-floating-pill.png` | `specs/designs/source/01-floating-pill.dc.html` |
| 2 | `specs/designs/02-overlay-clamp.png` | `specs/designs/source/02-overlay-clamp.dc.html` |
| 3 | `specs/designs/03-approval-queue.png` | `specs/designs/source/03-approval-queue.dc.html` |
| 4 | `specs/designs/04-agent-focus.png` | `specs/designs/source/04-agent-focus.dc.html` |
| 5 | `specs/designs/05-planning-state.png` | `specs/designs/source/05-planning-state.dc.html` |
| 6 | `specs/designs/06-graph-view.png` | `specs/designs/source/06-graph-view.dc.html` |

Online copy of the same boards (may not be reachable from Claude Code): https://claude.ai/artifact/G5Jj6Mprgfh3V88WGfb6HL

Read `CLAUDE.md` and `progress.md` before proceeding. Append rows to `progress.md` (never edit existing rows), bump the version in `package.json`, commit without push.

## Ground rules

- A single `/goal` runs this whole spec. Work through Goals 1 to 6 in order without stopping between them. Each is independently shippable: finish it, verify it against its acceptance criteria, add its `progress.md` row, commit (no push), then start the next. Do not ask for confirmation between goals. The overall goal is done only when all six are complete and the final verification pass below is clean. If a goal is blocked, record why in `progress.md`, skip to the next goal that does not depend on it, and return to it at the end.
- Step 0 of every goal: read the actual source files first. This spec deliberately names no file paths it has not verified. Known anchors: `MultiAgentModeButton` in `InputBar.tsx`, the `AgentEvent` discriminated union, the Python sidecar at localhost:7823. Locate the run view, the agent accordion list, the "Viewing agent run" pill, the hover overlay and the plan pane by search before editing.
- Design language (match existing, do not redesign): `#0a0a0a` backgrounds, `rgba(229,57,53,x)` red accents, `0.5px rgba(255,255,255,0.05)` hairlines, Inter plus JetBrains Mono, 13px mono for chrome, red left accent bar for active state. Permission UI keeps the existing yellow (`#e6b422` family).
- No new animation libraries. CSS transitions only (Framer Motion was deliberately removed for M1 performance; no persistent rAF loops, shimmer and flow animations must stop when the run is idle or the tab is hidden).
- Keep existing List view and hover overlay behaviour unchanged except where stated.

## Goal 1: Floating "Viewing agent run" pill (design: `designs/01-floating-pill.png`)

Problem: the pill sits in an opaque full-width band that hides content scrolling beneath it.

Do:
- Remove the band background. Wrapper is `position:absolute`, `pointer-events:none`, above the scroller by z-index. Only the pill has `pointer-events:auto`.
- Pill: translucent red fill (about `rgba(229,57,53,0.10)`), `backdrop-filter: blur(12px) saturate(1.3)`, 0.5px red border, soft shadow, no solid background.
- Content scrolls under it with no reserved space. Add top padding to the scroller only if the first line would otherwise start under the pill at scroll position 0.

Acceptance:
- With the run view scrolled to any position, text is visible (blurred) behind the pill, nothing is clipped by a container.
- Clicking the pill still closes the run view; clicking anywhere else near it passes through to content.
- No layout shift when the pill appears or disappears.

## Goal 2: Hover overlay never clips (design: `designs/02-overlay-clamp.png`)

Problem: the flow overlay on the header pill has a fixed width and runs off the right edge.

Do:
- Position the overlay with viewport collision handling: anchor to the pill, shift left by the overflow amount, keep a 12px gutter on both sides, flip to right-aligned when the pill is in the right half.
- `max-width: calc(100vw - 24px)`. The graph SVG uses a `viewBox` with `width:100%` so the whole graph (including Final synthesis) always fits.
- Overlay rows (model lines, stats) may wrap or condense at narrow widths; "Open run view" stays visible.
- Re-measure on window resize and when the run view panel is resized.

Acceptance:
- At window widths from 900px to 2560px and at any pill position, the overlay is fully inside the viewport.
- Hover behaviour (open on hover, close on leave with the existing delay) is unchanged.

## Goal 3: Collapsed rows with sequential permission slide-outs (design: `designs/03-approval-queue.png`)

Problem: without bypass permissions, up to 8 accordions auto-open at once to ask for permission, and the user scrolls frantically while agents stream long output.

Do:
- Agent rows no longer auto-expand for permissions or while streaming. Default state is a single-line collapsed row: status dot, id, title, role · model · tokens, tool-call count, state chip, full-screen button.
- Per-agent permission queue. When an agent requests a tool call, it is enqueued. Only the head of each agent's queue is shown, as the existing yellow permission popup sliding out beneath that agent's row (height transition). Show a `+N queued` chip when more are waiting.
- When the head is resolved, the next slides out in sequence.
- Strip actions: Allow (once), Trust agent (stop asking for this tool for this agent), Deny. Existing trust semantics are reused, not changed.
- Approval inbox bar at the top of the list: total waiting calls and agent count, a `Review next` button that scrolls to and focuses the next waiting strip, a bulk `Trust <tool> for all` action, and keyboard hints (J/K move, Y allow, N deny, only active when the list has focus).
- A row with a pending approval gets the yellow border and chip. Blocked agents (waiting on dependencies) render dimmed with `waits on ...`.
- Rows keep a fixed height while streaming. Output never expands a row.

Acceptance:
- Starting an 8-agent run with permissions required leaves all rows collapsed; no row changes height except the slide-out strip.
- With 4 agents requesting at once, exactly one strip per agent is visible, and resolving it reveals the next after the transition.
- The Abort button, cost and token counters, and Gantt strip in the left column are unchanged.
- Bypass-permissions runs show no strips and no inbox bar.

## Goal 4: Agent focus view (design: `designs/04-agent-focus.png`)

Do:
- The full-screen button on a row (and clicking the row title) opens a translucent focus layer over the run page: `rgba(12,12,12,0.80)` with backdrop blur, 28px/24px inset, 18px radius. The underlying list stays visible but dimmed and blurred. `Esc` closes. `J`/`K` (or the header arrows) move to the previous/next agent without closing.
- Header: id and title, role, model, phase, state chip, tokens, cost, tool-call count, elapsed.
- Main column tabs: Live output (default), Reasoning, Tool calls, Brief and inputs, Raw. Live output shows the brief, tool-call cards (tool, args summary, allowed/trusted/denied, result summary) and the streaming draft with a caret.
- The agent's pending permission is pinned at the bottom of the main column using the same yellow card, showing code for sandbox calls, with `n of m in this agent's queue`.
- Right rail: tool timeline, place in the graph (upstream and downstream ids and what is blocked on this agent), reflection result (criteria score out of 5, failed citations) once it exists, sources with verification status, token budget meter.
- Resolving a permission here and in the list must stay in sync (single source of truth in the run store).

Acceptance:
- Opening and closing the focus view does not interrupt or restart the agent.
- Streaming output in the focus view stays smooth with auto-scroll that pauses when the user scrolls up.
- Layer is keyboard accessible: focus trap, `aria-modal`, focus returns to the originating row on close.

## Goal 5: Orchestrator planning state (design: `designs/05-planning-state.png`)

Problem: while the orchestrator plans, the middle of the screen is blank with only "Orchestrator is planning...".

Do:
- Left column: replace the single line with a stepper: Reading your request, Splitting into subtasks, Assigning roles and tools, Wiring dependencies. Show elapsed time and live token count.
- Center stage: a graph canvas that fills progressively. Subtasks appear as solid nodes as the plan streams in; pending ones are shimmering dashed ghost nodes; edges are dashed until wired.
- Collapsible "Orchestrator thinking" card showing the streamed reasoning when the model provides it.
- Slow-plan escape hatch after 45s: banner with Keep waiting and Use quick 3-step plan (reuses the existing fallback plan), plus Abort stays available.
- The planning view and the final graph are the same component (see Goal 6) so nodes do not jump on transition.
- Requires streaming partial plan events from the sidecar. Add the event variants to the `AgentEvent` union (for example plan-started, plan-subtask-added, plan-stage-changed) rather than a side channel. Fix or confirm `parse_plan()` does not silently fall back to the hardcoded 3-step plan without telling the user.
- Shimmer and pulse animations run only while planning and only while the window is visible.

Acceptance:
- From send to first plan event, the user always sees the stepper, a timer and the ghost canvas, never an empty pane.
- If the orchestrator fails or times out, the failure and the fallback choice are shown inline.

## Goal 6: Graph view with HITL inbox (design: `designs/06-graph-view.png`)

Do:
- Add a `List | Graph` segmented toggle next to the "Multi-agent" header pill. Choice persists per chat. The hover overlay is kept as is.
- Graph renders in the same space the run view uses, from the plan the orchestrator produced at runtime: orchestrator, phase columns, worker nodes, valuation and synthesis nodes, final synthesis. Column labels come from the plan's phases.
- Node card (fixed 76px height): status dot, id, state, title (2-line clamp), role · tokens or `waits on ...`, yellow count badge when approvals are pending, red outline plus soft ring when selected.
- Edges: solid green for completed handoffs, red animated dashes for active flow, yellow dashed for blocked on approval, grey dashed for idle.
- Canvas: pan, zoom, fit, minimap, legend. Selecting a node updates the inspector; double click opens the focus view from Goal 4.
- Inspector (right, about 380px) with tabs Needs you, Node, Run log. Needs you groups approvals by agent: the focused agent shows the full permission card (tool, code or args, Allow, Trust agent, Deny, next in queue); other agents are one-line rows with Review.
- Bottom stats strip: cost against budget, tokens, elapsed, agents in parallel, approvals waiting, reflection checks done, model assignments.
- Approvals resolved in Graph, List or focus view stay in sync.

Acceptance:
- 8-agent and 20-agent plans both render without overlap; layout is computed from the dependency DAG, not hardcoded.
- Toggling List and Graph mid-run loses no state and does not remount streaming.
- Graph animation cost is bounded: edge flow animates only for edges that are active.

## Verification discipline (every goal)

- Check actual output files after the run before moving to the next goal.
- Add Vitest coverage for pure logic: permission queue ordering (per-agent FIFO), overlay collision placement, DAG layering.
- Verify on the machine the work is done on: no persistent rAF loop when idle (Animations track quiet in a Performance trace, or an equivalent check such as counting requestAnimationFrame callbacks while idle), no re-render regressions in `Layout`. A trace on the M1 Pro is a follow-up for the user, not a completion gate.
- Screenshot each state in the running app and compare it against the matching PNG in `specs/designs/` before marking the goal done; fix visible differences in layout, spacing, color and copy.

## Final verification pass (after Goal 6)

- Run the full Vitest suite and the TypeScript build; both must pass.
- Walk each acceptance list again against the running app and fix any gap.
- Confirm `package.json` is bumped and `progress.md` has one row per goal.

## Out of scope

- Changing which tools need permission or how trust is persisted.
- Changing the sidecar's agent execution, reflection logic or cost accounting beyond the new plan events in Goal 5.
- Redesigning the left run-summary column or the memo output pane.
