# Search selector (input bar), merged-block details, multi-agent provider display

Follow-up to `specs/exa-search-integration.md` (Phase 1 shipped). Approved mockups: `specs/designs/search-selector-mockups.html` (open in a browser; 4 tabs). The mockup is the visual source of truth; this file is the behaviour contract.

## 1. Scope

1. **Search selector button** in the input bar: Brave (orange) or Exa (blue), opens a menu, choice saved in settings.
2. **Merged search blocks**: show each Exa search's synthesis and "Sent to model" even when consecutive searches are merged.
3. **Multi-agent mode** shows which provider (and depth) is in use.
4. **Responsive**: the selector follows the input bar's existing container-query rules.

Out of scope: Exa Agent / deep research (Phase 2), new providers, changing what the model receives.

## 2. Search selector button

- Lives in the input bar's helper row, directly after the Multi-Agent button (mockup tab 2). Same markup/classes as the other toggles: `flex items-center gap-1.5 px-2 py-0.5 rounded-md whitespace-nowrap text-[10px] font-medium`, globe icon (lucide `Globe`) + label + small up-chevron.
- Rendered in every chat (not gated on `isOpenRouter`; the Multi-Agent button's own gating is unchanged).
- Colours: Brave `#fb923c`, Exa `#7aa2f7` (text `#8fb0f8`), tinted background ~9% and border ~38% alpha. Missing Exa key: amber. Web search off: grey dashed border.
- Label (wide): `Brave`, `Exa · balanced`, `Exa · fast`, `Exa · deep-lite`, `Exa · deep`, `Exa · key needed`, `Search off`. Use `EXA_MODES[type].label` lower-cased; never abbreviations or letters.
- Icon-only (narrow): reuse the existing `.ib-label` rule inside the existing `@container (max-width: 420px)`. No new breakpoint. The label stays in the DOM as the accessible name; set `title` and `aria-label` to the full text, e.g. `Web search: Exa, Deep`. Hide the chevron in icon-only.

## 3. Menu

Opens upward from the button, `role="menu"`, items `menuitemradio`. Width 300 px, clamped to the input bar (min 8 px inset each side; use `lib/overlayPlacement.ts` if it fits, otherwise a small clamp). Closes on outside mousedown, Esc (focus returns to the button), and after a pick.

Order:
1. Header row: "Web search" / "saved to Settings".
2. **Brave** — a heading that is itself the option (dot, "Brave", subtitle "Snippets · DI fetches top pages", `$5 / 1k`).
3. Divider.
4. **Exa** heading (dot, "Neural search · page text included"; when no Exa key: an amber "Add API key" button) followed by four options: Fast (`lite`), Balanced (`auto`, tagged DEFAULT), Deep-lite, Deep. Each shows latency and price from `EXA_MODES`.
5. Divider, then "Web Search settings ›" which opens Settings > Web Search.

Selected row: faint red tint plus 2 px red left accent bar and a check mark (same language as the rest of the app). Arrow keys move between enabled items; Enter/Space picks.

Behaviour:
- A pick writes `webSearchProvider` and (for Exa) `exaSearchType` through the existing settings IPC, and sets `braveSearchEnabled = true` if it was off. It must update Settings > Web Search live (single source of truth, no second copy of state) and vice versa.
- Exa options are disabled (not hidden) while there is no `exaApiKey`; "Add API key" opens Settings > Web Search. Picking Brave with no Brave key is allowed and follows the existing "key missing" behaviour for that provider.
- Applies to the next request. Never mutates an in-flight run.

## 4. Multi-agent mode

- Single shared setting; no separate multi-agent key. While multi-agent mode is on the menu shows only **Brave** and **Exa · Balanced** as selectable; Fast, Deep-lite and Deep are dimmed with a lock icon and tooltip "Multi-agent runs use Balanced". A note under the list explains it and, if the saved depth is deeper, says it is kept for normal chats.
- The effective depth for workers is `min(selected, Balanced)` as already implemented (Phase 1). The button label in multi-agent mode shows the effective value ("Exa · balanced"), while the saved `exaSearchType` is not overwritten until the user explicitly picks something.
- While a multi-agent run is active the selector is locked (disabled, tooltip "Applies to the next run"), mirroring the Multi-Agent button's `locked` prop.

### Provider visibility in the multi-agent UI (mockup tab 4)

- **Run bar**: a "Web search" group with the provider chip (`Exa · balanced` / `Brave`), search count and, for Exa, summed cost. The chip is a snapshot of what the run used, taken when the run starts.
- **Worker card**: the Tools line becomes `Tools: web_search ● Exa, +N` (provider dot + name, same chip style). Implement in `MultiAgentSidebarView.tsx` (the helper around line 228 builds the text; it needs the provider for `web_search`).
- **Tool call rows**: provider chip next to the tool name; expanded row shows provider, type, time, cost, result count and the existing Sent to model disclosure.
- Data comes from the existing observability `search_call` records and the run snapshot; do not add a second source.

## 5. Merged search blocks

State as of this spec: commit `1d5a910` already makes the merged group show each search's synthesis, footer and Sent to model. Verify against the mockup (tab 1) and only fill gaps:
- One row per search inside the merged block with two collapsed toggles: `Synthesis · N words` (Exa only, blue tint) and `Sent to model · N chars`. Both collapsed by default.
- Group header: `Searched the web via <chip> · N results · M searches · $cost · time`; when the group is collapsed and has Exa briefs, show a `N briefs` badge. An "expand details / collapse details" link when expanded.
- Merge only consecutive blocks with the same provider and the same Exa type. A provider or depth change starts a new block (with a small separator note in the mockup).
- Brave merged blocks keep today's look (no synthesis toggle).

## 6. Tests (add, follow `src/tests/hitl/` and existing Exa tests)

- Selector: renders each state (Brave, each Exa depth, key missing, off); menu order and selection; pick persists via IPC and updates Settings; Exa items disabled without key; multi-agent mode disables the three non-Balanced depths and keeps the saved depth; locked during an active run.
- Responsive: label present wide, `.ib-label` visually hidden under the 420 px container rule, `title`/`aria-label` carry the full text.
- Keyboard: Esc closes and returns focus; arrows skip disabled items.
- Multi-agent: run chip and worker Tools line show the provider; tool-call row shows chip; run snapshot does not change when the setting changes mid-run.
- Merged blocks: merge rule (provider and type), badge, per-search toggles collapsed by default.
- Secrets: nothing logged or serialized with API keys (existing secrets test pattern).

## 7. Constraints

- Repo is public: no personal paths, usernames or keys in code, tests, fixtures, screenshots or docs.
- Respect `engineering-invariants.md` (ChatService/provider rules); this feature must not touch streaming or payload logic.
- Design language: `#0a0a0a`, red accents, 0.5 px hairlines, Inter + JetBrains Mono, no uppercase or robotic fonts.
- Pixel measurements in the mockup are estimates; verify in the running app.
