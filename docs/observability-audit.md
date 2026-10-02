# Observability audit: the old multi-agent logger

Phase 0 of `specs/multi-agent-observability.md`. Each claim below has a test in
`src/main/services/__tests__/ObservabilityAudit.test.ts` that runs the real
`ObservabilityService` against a real temp directory, fed by the real
`MultiAgentRunCoordinator`. Each test fails if its claim is false.

## Claims

| Claim | Verdict | Test |
|---|---|---|
| `observabilityEnabled` is off unless the user turned it on | Confirmed | `observabilityEnabled defaults to false…` |
| With the toggle off, nothing is written (no file, no directory) | Confirmed | `with the toggle off, nothing is written…` |
| With the toggle on, each recorded event is one JSON line in the single global `multi-agent-events.jsonl` | Confirmed | `with the toggle on, each event is one JSON line…` |
| Turning the toggle on takes effect without a restart | Confirmed | `turning the toggle on at runtime…` |
| `stepType` mapping (plan and config → orchestrator; reflection → reflection; synthesis → synthesizer; terminal → run; plan approval pause → orchestrator; everything else, including a worker's tool pause and `retry`, → worker) | Confirmed | `stepType maps every AgentEvent type…` |
| Every `AgentEvent` type the UI receives reaches the file | Confirmed. The sample table is typed `Record<AgentEvent['type'], …>`, so a new event type that is not covered fails typecheck. | `every AgentEvent type the UI receives reaches the file…` |
| Token events are coalesced | Confirmed. The UI gets every token. The file gets one line per agent, attempt and stream within `COALESCE_WINDOW_MS`, holding the joined text. The line keeps the first token's `seq` and `ts`, so seq numbers in the file have gaps. | `token events are coalesced…` |
| Lines land in emit order | **Refuted, fixed.** Each event started its own `mkdir` then `appendFile`. Concurrent appends finish in any order, so a burst of events was written out of order. | `lines land in emit order…` |
| The Debug panel's first rows are the newest events | **Refuted, fixed.** The ordering of `listMultiAgentEvents` (`slice(-limit).reverse()`) is right, but it trusts file order, which was wrong (see above). | `listMultiAgentEvents is newest first…` |
| A run with the toggle on produces file entries for that run, from start to terminal event | **Refuted, fixed.** Every event was written, but out of order (same cause). | `a run with the toggle on produces file entries…` |
| A logger failure never fails a run | **Refuted, fixed.** `observe` was called without a guard. A throw went up through the sidecar manager's SSE handler, ended the event stream and failed the run with "Lost connection to the multi-agent sidecar". | `a logger that throws never fails the run…` |

## Fixes

- `ObservabilityService.emitMultiAgentEvent` queues lines and one drain loop writes them, so only one `appendFile` is in flight at a time. Lines that arrive during a write go out together in the next append. The call is still non-blocking.
- `MultiAgentRunCoordinator.record` wraps `observe` in try/catch and logs a warning.

## Why "no entry for the last run"

There are three possible causes. The tests cover the first two:

1. The toggle was off. That is the default, and nothing is written when it is off.
2. The entries were written but out of order, so the Debug panel's newest rows came from somewhere else in the file.
3. The run was started while the toggle was off and the toggle was turned on partway through. Only the events after that point were written. The old logger can't tell this case apart from a run that was never recorded. Phase 2 marks such runs as "not recorded".

## Gaps noted, not fixed here (the later phases replace this logger)

- There is one file for all runs, it never shrinks, and nothing deletes old lines. The Debug panel reads the whole file on every open.
- `getTotalSizeBytes` only counts one directory level. The per-run tree in Phase 2 is nested deeper, so it needs a recursive count.
- `clearAllSessions` deletes the whole log directory, including the multi-agent and sandbox-violation files.
- Coalesced tokens wait in memory until the next event. If the app crashes, the last few hundred milliseconds of tokens never reach the file.
- The file only sees UI events. It has no prompts, parameters, raw output, usage per call or full tool payloads. Phase 1 adds these.
