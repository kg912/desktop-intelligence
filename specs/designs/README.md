# Design references: multi-agent UI improvements

PNG renders (2x) of the approved boards, plus the HTML/CSS source of each in `source/`.
Use the PNGs for layout and look; use `source/` for exact colors, sizes, spacing and copy.
The `.dc.html` files use `{{holes}}`, `<sc-for>` and `<sc-if>` template tags from the design tool.
Read them as markup plus a `renderVals()` data stub, do not try to run them.
All data shown (agent states, counts, model names) is sample data.
Fonts: Inter and JetBrains Mono. The PNGs were rendered with a fallback monospace.

| File | Spec goal |
|---|---|
| 01-floating-pill.png | Goal 1: floating "Viewing agent run" pill |
| 02-overlay-clamp.png | Goal 2: hover overlay never clips |
| 03-approval-queue.png | Goal 3: collapsed rows, sequential permission slide-outs |
| 04-agent-focus.png | Goal 4: agent focus view |
| 05-planning-state.png | Goal 5: orchestrator planning state |
| 06-graph-view.png | Goal 6: graph view with HITL inbox |
