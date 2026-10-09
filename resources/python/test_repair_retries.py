"""Reflection hardening Phase 4: a repair continues the worker's conversation; history is compacted
only when the next request would not fit the model's context window."""
import json

import multi_agent_sidecar as s
from test_reflection_evidence import CALL, events, run_one_step

PROSE = "The file reports record revenue for the quarter, per the company filing [c1]."
R1 = "".join(f"first file line {i:04d}\n" for i in range(400))   # 8,400 chars
R2 = "".join(f"second file row {i:04d}\n" for i in range(400))   # 8,400 chars
assert len(R1) == len(R2) == 8_400


def answer(*claims):
    return {"content": PROSE + "\n\n```claims\n" + json.dumps(list(claims)) + "\n```"}


def tool_results(body):
    return sum(1 for m in body["messages"] if m["role"] == "tool")


if __name__ == "__main__":
    # A repair that only tags a claim as unverified makes zero tool calls and passes.
    bad = {"id": "c1", "claim": "Revenue", "callId": "call_big", "quote": "record revenue of $1 billion"}
    worker = iter([answer(bad), answer({"id": "c1", "claim": "Revenue", "unverified": True})])
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else (next(worker) if tool_results(body) else CALL) if role == "worker" else {"content": "done [1.1]"}, retries=1)
    assert [e["attempt"] for e in events(run, "tool_start")] == [0]
    assert [r["passed"] for r in events(run, "reflection_result")] == [False, True] and run.events[-1]["type"] == "task_complete"
    repair = fake.of("worker")[-1]["messages"]
    assert repair[-1]["content"].startswith("Reviewer verdict: score 1/5 — Claims check: 1 problem(s)\nFix these, keeping everything that was fine:\n"
                                            "- Claim c1 (callId call_big): the quote is not in the cited tool result.\n")

    # A repetition loop: the looped reply is dropped and the nudge is a new turn in the same conversation.
    worker = iter([{"content": "I hope this helps! " * 3, "looped": "content"}, answer({"id": "c1", "claim": "Revenue", "unverified": True})])
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else (next(worker) if tool_results(body) else CALL) if role == "worker" else {"content": "done [1.1]"}, retries=1)
    first, second = fake.of("worker")[1:3]
    assert second["messages"] == first["messages"] + [{"role": "user", "content": s.LOOP_NUDGE}]
    assert events(run, "retry")[0]["reason"] == "repetition loop" and run.events[-1]["type"] == "task_complete"

    # compact_to_fit: untouched when it fits or the window is unknown; stubs oldest-first just enough; fails only when nothing is left.
    def history():
        msgs = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}]
        for call_id, result in (("a", R1), ("b", R2), ("c", R1)):
            msgs += [{"role": "assistant", "content": "", "tool_calls": [{"id": call_id}]}, {"role": "tool", "tool_call_id": call_id, "content": f"[callId: {call_id}]\n{result}"}]
        return msgs

    store = {k: {"name": "fs__read_file", "args": json.dumps({"path": f"/{k}"}), "ok": True, "attempt": 0, "result": v} for k, v in (("a", R1), ("b", R2), ("c", R1))}

    def run_with_window(window):
        return s.Run("w", s.RunRequest(runId="w", chatId="c", task="t", openRouterApiKey="k", currentDateTime="d",
                                       pricing={"m/w": s.Pricing(prompt=0, completion=0, contextLength=window)},
                                       config=s.Config(maxAgents=1, budgetCapUsd=1, models={}, reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=1_000)))
    for window in (0, 100_000):
        msgs = history()
        assert s.compact_to_fit(run_with_window(window), "m/w", msgs, store, set()) is None and msgs == history()
    msgs, compacted = history(), set()
    size = s.estimate_tokens(json.dumps(msgs))
    window = int(size * 1.25) - 200  # just too small: one 2,000-token result has to go
    stubbed, freed = s.compact_to_fit(run_with_window(window), "m/w", msgs, store, compacted)
    assert stubbed == 1 and compacted == {3} and freed == size - s.estimate_tokens(json.dumps(msgs)) and freed > 1_500
    assert msgs[3]["content"] == '[a fs__read_file {"path": "/a"}: result compacted, 8400 chars, first 300 chars: ' + R1[:300] + "]"
    assert msgs[5:] == history()[5:]
    try:
        s.compact_to_fit(run_with_window(200), "m/w", history(), store, set())
        raise AssertionError("did not raise")
    except s.ContextExceeded as exc:
        assert "even with every tool result compacted" in str(exc)

    # End to end: two 8,400-char results overflow a small window before the answer; the oldest is stubbed,
    # the run continues, and a quote from beyond the stub's first 300 chars still verifies from the store.
    calls = iter([{"tool_calls": [{"id": "call_r1", "type": "function", "function": {"name": "fs__read_file", "arguments": '{"path": "/1"}'}}]},
                  {"tool_calls": [{"id": "call_r2", "type": "function", "function": {"name": "fs__read_file", "arguments": '{"path": "/2"}'}}]},
                  answer({"id": "c1", "claim": "Line 300 exists", "callId": "call_r1", "quote": "first file line 0300"})])
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else next(calls) if role == "worker" else {"content": "done [1.1]"},
                             tool_result=lambda n: R1 if n == 1 else R2, request={"pricing": {"m/w": s.Pricing(prompt=0, completion=0, contextLength=4_500)}})
    [note] = events(run, "context_compacted")
    assert (note["agentId"], note["attempt"], note["stubbed"]) == ("1.1", 0, 1) and note["tokensFreed"] > 1_500, note
    final = fake.of("worker")[-1]["messages"]
    assert [m["content"].startswith("[call_r1 fs__read_file") for m in final if m["role"] == "tool"] == [True, False]
    assert fake.of("worker")[1]["messages"][3]["content"] == "[callId: call_r1]\n" + R1  # the earlier request was never touched
    assert events(run, "reflection_result")[0]["claimStatuses"] == {"c1": "verified"} and run.events[-1]["type"] == "task_complete"
    print("ok")
