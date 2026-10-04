# Multi-agent observability: reading a run

Every multi-agent run can leave a complete, local record of what was sent to each
model, what came back, what each tool received and returned, and where the time
and money went. This page covers the layout and how to read it. The design is in
`specs/multi-agent-observability.md`. The audit of the old logger is in
`docs/observability-audit.md`.

## Turning it on

Go to Settings → Debug → **Observability**. It is off by default because prompts
and outputs contain private chat and tool content.

- Whether a run is recorded is decided when it starts. If observability was off
  when a run began, nothing about it is captured, and the Debug panel lists it as
  **not recorded**. Turning the toggle on partway through a run does not start
  recording it.
- A run that started with it off shows **Logging off** in the agent dock header,
  with a **Log the next run** button that turns it on (the current run stays
  unrecorded).
- A run with no entry at all in the Debug panel never got a run id: it was
  refused before it started (backend, API key, model not in the catalogue,
  sidecar unavailable), or its chat was deleted. **Not recorded** also covers runs
  from before per-run logs existed and runs removed by retention, not only runs
  started with the toggle off.
- The Debug panel's run list refreshes when a run starts or ends.
- When it is off, the sidecar is told `observe: false` and copies nothing. No
  files are written.

## Where the files are

```
<userData>/observability-logs/multi-agent/<chatId>/<runId>/
  run.md            start here: index, config, plan, timeline, totals, anomalies
  run.meta.json     machine-readable index and summary (status, totals, anomalies)
  events.jsonl      the UI events for this run (token events coalesced)
  planner.jsonl     planner calls, one JSON record per call
  agent-<id>.jsonl  every call for one agent: all attempts, tool rounds, tool executions, reflections
  synthesis.jsonl   the synthesis call
  planner.md  agent-<id>.md  synthesis.md   the same records rendered for reading
```

Directory names are ids only, never chat titles. In the app, the Debug panel's
row actions open `run.md`, reveal the folder, copy the run id, or delete the run.

## How a run is captured

1. The Python sidecar makes every model call. When observability is on, the
   request is decoded from the exact bytes sent to OpenRouter, never rebuilt
   afterwards. The response is captured raw as it streams, before end-of-sequence
   tokens are stripped or tool-call markup is parsed. The `Authorization` header
   is recorded only as `[redacted]`.
2. Each finished call (success, error or cancel) becomes one record. It goes to
   Electron as an `obs_record` frame on the run's existing event stream. These
   frames never reach the renderer.
3. `MultiAgentRunLogger` (in `src/main/services/MultiAgentRunLogger.ts`) appends
   each record to the right `.jsonl` file as it arrives. Credentials are removed
   from every line before it is written: the OpenRouter, Brave, NVIDIA and Ollama
   keys, and every MCP server env value and HTTP header.
4. When the run ends, `run.meta.json` gets its final status, and the markdown is
   rendered from the `.jsonl` files on disk.

If the app quits or crashes mid-run, the `.jsonl` files stay valid and
`run.meta.json` keeps `status: "incomplete"`. Opening `run.md` from the Debug
panel renders whatever was captured.

## Reading run.md

- **Header and Trigger**: chat, run id, start and end, status, and the user's
  message that started the run.
- **Config**: the model for each role and where it came from (`saved`, `default`
  or `active`), plus the budget, thresholds, retries, reasoning effort, approval
  settings and the tools offered.
- **Plan**: the steps and their `dependsOn`, as a table and a Mermaid diagram.
- **Timeline**: one row per call (model or tool) with its start offset, duration,
  role, agent, attempt, model, tokens, cost and finish reason, and a link to the
  exact section in the agent file. Rows that overlap ran in parallel. *Peak
  concurrency* is computed from the recorded timestamps.
- **Agents**: attempts, reflection scores (✓ passed, ✗ failed), outcome, tools used
  and cost per agent, followed by the reviewer's issues.
- **Totals**: tokens and cost by role and by model, summed from the call records,
  then compared with the totals the run itself reported. The section ends with
  either *Reconciled* or a **Mismatch** warning.
- **Anomalies**: anything worth a second look, each linked to its call:

| Kind | Meaning |
|---|---|
| `length` | The call stopped at its token limit; the bound says whether the budget or the context window was the limit |
| `repetition` | The repetition guard stopped a looping stream |
| `served_model_differs` | OpenRouter served a different model than the one requested (a dated variant of the same id does not count) |
| `fallback_plan` | The planner never returned a usable plan, so the built-in fallback plan ran |
| `retry` | An agent was retried, the planner was re-asked, the reviewer was re-asked after an unusable verdict, or a worker was re-asked after a reply with no answer (empty or only tool-call text) |
| `error` / `cancelled` | A call failed (with its HTTP status) or was cancelled mid-call |
| `tool_denied` / `tool_rejected` | A tool call was denied (by the user, a policy or a timeout) or rejected (unregistered tool, bad arguments) |
| `capped` | A field was longer than `RECORD_FIELD_CAP_CHARS` and was cut in the log |
| `tool_limit` | A worker's answer came from the forced wrap-up round (tools off) after its `maxToolRounds` were used: "stopped at tool limit" |
| `reconciliation` | The call records and the run's own totals disagree |

## Reading an agent file

`agent-<id>.md` has one section per attempt:

- **Work**: each model call in tool-round order. For each call: the model
  requested and the model served, finish reason, tokens, cost, timing and
  OpenRouter generation id; every message sent (system prompt, task, upstream
  context, earlier tool results); the request parameters; raw reasoning; raw
  output; and any tool calls requested. Each tool execution follows the call
  that requested it, with the raw arguments and the result exactly as it was sent
  back to the model.
- **Reflection**: the reviewer call (its prompt and raw verdict), then the parsed
  score, pass or fail, reason and issues.

Long fields are folded in `<details>`. The `.jsonl` file always holds the full
text.

`synthesis.md` shows the full synthesis prompt, including every agent output as
the synthesizer received it, the raw final answer and the finish reason.
`planner.md` shows each planner call, including re-asks after an invalid or
fully sequential plan.

## Record format

Each line of a `.jsonl` file is one record. Model calls have `kind: "model"`:
`schema`, `runId`, `chatId`, `seq` (per run, in completion order), `role`
(`planner` | `worker` | `reflection` | `synthesis`), `agentId`, `attempt`
(0-based, like the UI events), `toolRound`, `retry` (reflection, planner and worker no-answer
re-asks), `model`, `modelServed`, `request` (`messages`, `params`, `headers`),
`response` (`content`, `reasoning`, `toolCalls`, `finishReason`, `looped`,
`truncated`), `usage` (`promptTokens`, `completionTokens`, `reasoningTokens`,
`costUsd`, `generationId`), `timing` (`startedAt`, `firstTokenAt`, `endedAt`,
`ms`), `error`, and `capped`.

Tool executions have `kind: "tool"` with `callId`, `name`, `args` (the raw
string), `result`, `approved`, `denied`, `error` and `timing`.

`response.truncated` means the same as `truncated` on the UI's `agent_complete`
and `task_complete` events: which limit ended a `length` finish. Fields cut in
the log are listed separately in `capped`, with their path and original length.

## Retention and size

The newest `multiAgentRunLogsKept` runs are kept (default `DEFAULT_KEEP_RUNS`).
Older ones are deleted oldest first, and never while they are running. The size
shown in the Debug panel includes the nested run directories.

## Checking logs

```
npx tsx scripts/check-run-logs.ts "<userData>/observability-logs/multi-agent" [secret ...]
```

This runs `verifyRunDir` on every finished run. It checks that every timeline call
has a record with a non-empty request and response, that every link points to an
existing file and anchor, that totals reconcile, and that none of the given
secrets appears anywhere. The exit code is non-zero if any problem is found.

## Older logs

Runs from before per-run logs were added were written to the single file
`observability-logs/multi-agent-events.jsonl`. New runs no longer write to it,
but it is left in place.
