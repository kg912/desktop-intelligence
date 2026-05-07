# PERF_AGENT.md — Renderer Performance Optimisation
## Claude Code Sub-Agent Spec · Desktop Intelligence v2.3.0-alpha-18

> **READ CLAUDE.md AND PROGRESS.md BEFORE STARTING.**
> Do not touch `src/main`, `src/preload`, `src/shared`, or test files.
> All changes are renderer-only. No logic changes — pure performance.
> At the end, bump `package.json` and append a `progress.md` row.

---

## Background: Why the app freezes on M1 Pro

Static analysis of the renderer found 5 concrete performance issues.
They are ordered by impact — fix them in this order.

---

## Fix 1 (Critical) — Remove no-op `motion.div` from MessageBubble

**File:** `src/renderer/src/components/chat/MessageBubble.tsx`

**Problem:**
```tsx
const bubbleVariants = {
  initial: { opacity: 1, y: 0, scale: 1 },   // ← CSS default
  animate: { opacity: 1, y: 0, scale: 1 }    // ← identical to initial
}
export const MessageBubble = memo(function MessageBubble({ message }) {
  ...
  return (
    <motion.div variants={bubbleVariants} initial="initial" animate="animate">
```
These variants are **identical and match CSS defaults** — they animate nothing.
But `motion.div` still mounts a MotionContext provider, registers with Framer
Motion's global animation loop, and runs animation reconciliation for every
single message in the list. With 50+ messages loaded, this is 50+ live Framer
Motion contexts all running simultaneously. This is the primary cause of slow
scrolling even when the app is completely idle.

**Fix:**
1. Delete `bubbleVariants` entirely.
2. Replace `<motion.div variants={bubbleVariants} initial="initial" animate="animate">` with a plain `<div>`.
3. Remove the `motion` import if it is no longer used anywhere in this file after the change (check — `motion.span` is used in the thinking-dots animation inside `AssistantBubble`, so `motion` import stays).
4. The `AnimatePresence` import in this file is not used directly — verify and remove if unused.

**Expected result:** MessageBubble renders as a plain div. Zero Framer Motion overhead per message. Scrolling through a long chat should feel instant.

---

## Fix 2 (Critical) — Decouple ChatArea from per-token streaming re-renders

**Files:** 
- `src/renderer/src/components/layout/ChatArea.tsx`
- `src/renderer/src/components/layout/Layout.tsx`

**Problem:**
In `Layout.tsx`, `useChat()` reads `allMessages.value`, which is a computed
signal that recomputes every rAF frame during streaming (because `streamingMessage`
signal changes every rAF via `scheduleStateFlush`). This causes:
1. `Layout` re-renders at up to 60Hz during streaming.
2. `Layout` passes a new `messages` array to `ChatArea` each render.
3. `ChatArea` re-maps ALL messages and runs `React.memo()` equality checks on every `MessageBubble`.
4. With 50 messages at 60fps → 3,000 memo checks/second during streaming.

**Fix:**

In `ChatArea.tsx`:
- Add `useSignals()` at the top (already imported from `@preact/signals-react/runtime`).
- Import `completedMessages` and `streamingMessage` signals directly from `../../../signals/chatSignals`.
- Change the component signature: **remove the `messages: Message[]` prop entirely**.
  Instead, compute locally:
  ```tsx
  // Inside ChatArea component body, after useSignals():
  const completedMsgs = completedMessages.value
  const streamingMsg  = streamingMessage.value
  const messages      = streamingMsg
    ? [...completedMsgs, streamingMsg]
    : completedMsgs
  const hasMessages = messages.length > 0
  ```
- Keep `activeChatId` and `onSuggest` props unchanged.
- Update the `ChatAreaProps` interface: remove `messages` field.
- Export `ChatAreaHandle` and everything else unchanged.

In `Layout.tsx`:
- Remove `messages` from the `<ChatArea ... />` JSX props.
- `useChat()` is still called (for `isStreaming`, `sendMessage`, `abort`, etc.) — keep it.
- `messages` const from `useChat()` is no longer passed to ChatArea — but it
  is still used in `handleSend` (for `prevHistory` snapshot). Keep the return
  value; just stop passing it to ChatArea.

**Why this works:** `completedMessages` only changes when a new message is
finalized (e.g. stream ends, user sends). `streamingMessage` changes every rAF,
but now only `ChatArea` (and its single streaming child) re-renders — not Layout
and not any of the completed MessageBubbles.

**Important:** ChatArea already calls `useSignals()` at the top. The `allMessages`
computed and the `completedMessages`/`streamingMessage` split is already built
in `chatSignals.ts`. This fix just moves the read to the right place.

---

## Fix 3 (High) — Remove AnimatePresence from message list in ChatArea

**File:** `src/renderer/src/components/layout/ChatArea.tsx`

**Problem:**
```tsx
<AnimatePresence initial={false}>
  {messages.map((msg) => (
    <MessageBubble key={msg.id} message={msg} />
  ))}
</AnimatePresence>
```
`AnimatePresence` maintains a `PresenceContext` for every child and traverses
all children on every parent render. No `MessageBubble` defines an `exit`
variant, so this provides zero visual benefit.

**Fix:**
Remove the inner `<AnimatePresence initial={false}>` wrapper from around the
`messages.map(...)` call. The outer `AnimatePresence mode="wait"` (for the
empty-state ↔ messages panel transition) stays — that one is doing real work.

Before:
```tsx
<div className="space-y-6">
  <AnimatePresence initial={false}>
    {messages.map((msg) => (
      <MessageBubble key={msg.id} message={msg} />
    ))}
  </AnimatePresence>
</div>
```

After:
```tsx
<div className="space-y-6">
  {messages.map((msg) => (
    <MessageBubble key={msg.id} message={msg} />
  ))}
</div>
```

---

## Fix 4 (Medium) — Replace Framer Motion delete button in Sidebar with CSS transition

**File:** `src/renderer/src/components/layout/Sidebar.tsx`

**Problem:**
`ChatItem` renders `AnimatePresence + motion.button` for the hover-reveal delete
button. When the user scrolls the sidebar, `onMouseEnter`/`onMouseLeave` fires
rapidly → React state updates → Framer Motion enter/exit animations per item.

**Fix — three steps in `ChatItem`:**

1. Remove `const [hovered, setHovered] = useState(false)` — delete it entirely.
2. Remove `onMouseEnter={() => setHovered(true)}` and `onMouseLeave={() => setHovered(false)}` from the container `<div>`.
3. Replace the `AnimatePresence + motion.button` block with a plain button using CSS opacity:

**Old:**
```tsx
<AnimatePresence>
  {hovered && (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.1 }}
      onClick={handleDelete}
      className="absolute right-2 top-1/2 -translate-y-1/2
                 p-1 rounded-md
                 text-content-muted hover:text-red-400
                 hover:bg-red-950/30
                 transition-colors duration-100"
      title="Delete chat"
    >
      <Trash2 className="w-3.5 h-3.5" />
    </motion.button>
  )}
</AnimatePresence>
```

**New:**
```tsx
<button
  onClick={handleDelete}
  className="absolute right-2 top-1/2 -translate-y-1/2
             p-1 rounded-md
             opacity-0 group-hover:opacity-100
             text-content-muted hover:text-red-400
             hover:bg-red-950/30
             transition-all duration-100"
  title="Delete chat"
>
  <Trash2 className="w-3.5 h-3.5" />
</button>
```

Note: the container `<div>` already has `className="group ..."` — verify
it has the `group` class. If not, add it. The `group-hover:opacity-100`
class makes the button appear on container hover purely via CSS.

Also: remove `AnimatePresence` import from Sidebar.tsx if it is no longer
used after this change (check — it is also used in the collapsed toggle
button below). If the collapsed toggle `AnimatePresence` is the only remaining
use, keep the import.

---

## Fix 5 (Medium) — Replace Framer Motion sidebar width animation with CSS transition

**File:** `src/renderer/src/components/layout/Sidebar.tsx`

**Problem:**
```tsx
<motion.aside
  initial={false}
  animate={{ width: collapsed ? 0 : sidebarWidth }}
  transition={{ type: 'spring', damping: 28, stiffness: 260 }}
  ...
>
```
Spring physics animate the sidebar width via JS every frame → layout reflow every frame during animation. Width changes are not GPU-composited, making this inherently expensive.

**Fix:**
Replace `motion.aside` with a plain `<aside>` using CSS transition.

```tsx
<aside
  className="relative flex-shrink-0 h-full overflow-hidden"
  style={{
    backgroundColor: '#141414',
    width: collapsed ? 0 : sidebarWidth,
    transition: 'width 220ms cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  }}
>
```

- Remove the `initial={false}` and `animate`/`transition` props.
- The `sidebarWidth = 260` local const stays.
- The `motion` import: check if `motion` is still used elsewhere in Sidebar.tsx
  after this change (the collapsed toggle `motion.button` in `AnimatePresence`
  still uses it). Keep the import if so.

---

## Validation steps after all fixes

After implementing all 5 fixes, do the following to confirm no regressions:

1. `npm run typecheck` — must pass with zero errors.
2. `npm run lint` — must pass (remove unused imports flagged by lint).
3. Launch the app: `/Applications/"[DEV] Desktop Intelligence.app"/Contents/MacOS/"[DEV] Desktop Intelligence"`
4. Manually test:
   - Scroll through a long chat — should be smooth, no jank.
   - Hover over sidebar items while scrolling — no jitter.
   - Toggle sidebar open/close — smooth CSS slide.
   - Send a message and watch streaming — completed messages should not re-render.
   - Open Settings and switch tabs — should be instant.
5. Open Electron DevTools (View > Toggle Developer Tools or Cmd+Option+I).
   Performance tab → Record → scroll rapidly through a long chat → Stop.
   Verify the flame chart shows no Framer Motion animation work during idle scroll.

---

## Cleanup

- Remove any unused imports introduced by the changes above (`motion`, `AnimatePresence`, `useState` in ChatItem).
- Do NOT remove `motion` from `MessageBubble.tsx` — it is still used for the thinking-dot `motion.span` elements.
- Do NOT remove `AnimatePresence` from `ChatArea.tsx` — the outer mode="wait" wrapper is still needed.

---

## Progress entry (append to progress.md when done)

Format:
```
| {next_row} | {YYYY-MM-DD} | src/renderer/src/components/chat/MessageBubble.tsx, src/renderer/src/components/layout/ChatArea.tsx, src/renderer/src/components/layout/Layout.tsx, src/renderer/src/components/layout/Sidebar.tsx | Renderer perf: remove no-op motion.div from MessageBubble; decouple ChatArea from per-token re-renders via direct signal read; remove AnimatePresence from message list; replace Framer Motion hover+width animations in Sidebar with CSS transitions | ✅ Done |
```

Bump `package.json` version: `2.3.0-alpha-19`
