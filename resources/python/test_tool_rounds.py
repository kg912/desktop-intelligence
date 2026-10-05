"""maxToolRounds: a finite limit forces a tools-off wrap-up round with the TOOL_BUDGET_USED message;
unlimited never does; tool-call-shaped or empty output is no answer and is re-asked once."""
import asyncio

import multi_agent_sidecar as s

TOOLS = [{"name": "fs__read_file", "description": "", "parameters": {"type": "object"}}]
ANSWER = "Findings: the notes say the meeting moved to Thursday at 10."
CALL = {"tool_calls": [{"id": "c", "function": {"name": "fs__read_file", "arguments": "{}"}}], "content": ""}


def make_run(max_tool_rounds):
    config = s.Config(maxAgents=1, budgetCapUsd=1, models={"worker": "m/w"}, reflectionPassThreshold=1,
                      maxRetriesPerAgent=0, hitlTimeoutMs=60_000, maxToolRounds=max_tool_rounds)
    run = s.Run(run_id="r", request=s.RunRequest(runId="r", chatId="c", task="t", config=config, tools=TOOLS, openRouterApiKey="k", currentDateTime="Current date and time: x."))

    async def approve(*_a, **_k):
        return True, "notes"

    run.wait_for_approval = approve
    return run


def worker(run, replies):
    """Run one worker; `replies(call_index, tools)` scripts the model. Returns (output or exception, calls)."""
    calls = []

    async def ask(_run, _model, messages, *, tools=None, **_k):
        calls.append({"messages": [dict(m) for m in messages], "tools": tools})
        return replies(len(calls) - 1, tools), 1, 0.0

    async def reflect(*_a):
        return 5, True, "ok", [], "judge"

    s.ask, s.reflect = ask, reflect
    try:
        result = asyncio.run(s.run_worker(run, {"id": "1.1", "role": "R", "model": "m/w", "label": "x"}, {}))
    except s.AgentFailed as exc:
        result = exc
    return result, calls


def complete(run):
    return next(e for e in run.events if e["type"] == "agent_complete")


if __name__ == "__main__":
    assert s.Config(maxAgents=1, budgetCapUsd=0, models={}, reflectionPassThreshold=1, maxRetriesPerAgent=0, hitlTimeoutMs=1000).maxToolRounds == 12
    for shaped in ['{"name": "fs__read_file", "arguments": {"path": "/a"}}', "<tool_call>{}</tool_call>", "  ",
                   '```json\n{"name": "x", "arguments": {}}\n```', "[TOOL_CALLS] [{}]", "<function=search>{}</function>"]:
        assert s.is_no_answer(shaped), shaped
    assert not s.is_no_answer(ANSWER) and not s.is_no_answer('The API returns {"name": "x"} for each row.')

    # Finite: always calls tools → the 3rd call is forced (no tools) and ends with the wrap-up message.
    run = make_run(3)
    out, calls = worker(run, lambda i, tools: CALL if tools else {"content": ANSWER})
    assert out == ANSWER and len(calls) == 3, (out, len(calls))
    assert [c["tools"] is None for c in calls] == [False, False, True]
    assert calls[2]["messages"][-1] == {"role": "user", "content": s.TOOL_BUDGET_USED}
    assert not any(m["content"] == s.TOOL_BUDGET_USED for c in calls[:2] for m in c["messages"])
    assert complete(run).get("stoppedAtToolLimit") is True

    # Finite, answered before the limit: not flagged.
    run = make_run(3)
    out, _ = worker(run, lambda i, tools: CALL if i == 0 else {"content": ANSWER})
    assert out == ANSWER and "stoppedAtToolLimit" not in complete(run)

    # Unlimited: 30 tool rounds, every call offered tools, the wrap-up never sent.
    run = make_run(None)
    out, calls = worker(run, lambda i, tools: CALL if i < 30 else {"content": ANSWER})
    assert out == ANSWER and len(calls) == 31 and all(c["tools"] for c in calls)
    assert not any(m["content"] in (s.TOOL_BUDGET_USED, s.NO_ANSWER_NUDGE) for c in calls for m in c["messages"])
    assert "stoppedAtToolLimit" not in complete(run)

    # Forced round answers with tool-call text → re-asked once with the nudge, then answers.
    run = make_run(1)
    out, calls = worker(run, lambda i, tools: {"content": '{"name": "fs__read_file", "arguments": {}}'} if i == 0 else {"content": ANSWER})
    assert out == ANSWER and len(calls) == 2 and calls[1]["tools"] is None
    assert calls[1]["messages"][-1]["content"] == s.NO_ANSWER_NUDGE
    assert complete(run).get("stoppedAtToolLimit") is True

    # Empty twice → no answer, the agent fails (one re-ask only).
    run = make_run(2)
    out, calls = worker(run, lambda i, tools: CALL if i == 0 else {"content": ""})
    assert isinstance(out, s.AgentFailed) and len(calls) == 3, (out, len(calls))
    print("ok")
