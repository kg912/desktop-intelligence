"""Reflection hardening pins (specs/multi-agent-reflection-hardening.md).
A fake OpenRouter replaces _stream_openrouter, so the real ask(), reflect() and run_worker() run."""
import asyncio
import json

import multi_agent_sidecar as s

NEEDLE = "NEEDLE-4711"
# 20,000 chars with the needle at 15,000.
BIG = ("filler " * 3000)[:15_000] + NEEDLE + ("tail " * 2000)[: 20_000 - 15_000 - len(NEEDLE)]
assert len(BIG) == 20_000 and BIG.index(NEEDLE) == 15_000
ANSWER = "The file contains the release marker near its end; everything else in it is filler text."
CALL = {"tool_calls": [{"id": "call_big", "type": "function", "function": {"name": "fs__read_file", "arguments": '{"path": "/big.txt"}'}}]}
TOOLS = [{"name": "fs__read_file", "description": "", "parameters": {"type": "object"}}]


def role_of(body):
    system = body["messages"][0]["content"]
    if "orchestrator of a team" in system:
        return "planner"
    if "strict reviewer" in system:
        return "judge"
    if "synthesize" in system:
        return "synthesis"
    return "worker"


class FakeOpenRouter:
    """route(role, body) → reply dict ({"content": ...} or {"tool_calls": [...]}). Records every body."""

    def __init__(self, route):
        self.route, self.requests = route, []

    def __call__(self, _key, model, messages, tools, _max_tokens, on_delta, _cancelled, *_a, **_k):
        body = json.loads(json.dumps({"model": model, "messages": messages, "tools": tools}))
        role = role_of(body)
        self.requests.append((role, body))
        reply = dict(self.route(role, body))
        if reply.get("content"):
            on_delta("content", reply["content"])
        return {"role": "assistant", "content": reply.get("content", ""), **({"tool_calls": reply["tool_calls"]} if reply.get("tool_calls") else {}),
                "finish_reason": "tool_calls" if reply.get("tool_calls") else "stop"}, {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2, "cost": 0}

    def of(self, role):
        return [body for r, body in self.requests if r == role]


def run_one_step(route, tool_result=lambda n: BIG, retries=2, request=None, observe=False, **config):
    """Full orchestrate() of a one-step plan. Returns (run, fake)."""
    fake = FakeOpenRouter(lambda role, body: {"content": json.dumps([{"id": "1.1", "label": "Read the file", "role": "Reader", "dependsOn": []}])}
                          if role == "planner" else route(role, body))
    s._stream_openrouter = fake
    cfg = s.Config(maxAgents=1, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=retries, hitlTimeoutMs=60_000, **config)
    run = s.Run("r", s.RunRequest(runId="r", chatId="c", task="What is in the file?", config=cfg, tools=TOOLS, openRouterApiKey="k", observe=observe,
                                  currentDateTime="Current date and time: x.", **(request or {})))
    calls = [0]

    async def approve(agent_id, *_a, **_k):
        if agent_id == "orchestrator":
            return True, ""
        calls[0] += 1
        return True, tool_result(calls[0])

    run.wait_for_approval = approve
    asyncio.run(s.orchestrate(run))
    return run, fake


def worker_reply(body):
    """Tool call until a tool result is in this attempt's history, then the answer."""
    return {"content": ANSWER} if any(m["role"] == "tool" for m in body["messages"]) else CALL


def verdicts(*scores):
    it = iter(scores)
    return lambda: {"content": json.dumps({"score": next(it), "reason": "unsupported figures", "issues": ["Back the figures"]})}


def events(run, kind):
    return [e for e in run.events if e["type"] == kind]


if __name__ == "__main__":
    # 1. Phase 0 pinned that the judge saw ~600-char previews (a needle at 15,000 of 20,000 never reached it).
    # Phase 2 flipped it: within judgeEvidenceMaxTokens the judge gets every result in full, and is told so.
    judge = verdicts(5)
    run, fake = run_one_step(lambda role, body: judge() if role == "judge" else worker_reply(body) if role == "worker" else {"content": "done [1.1]"},
                             observe=True)
    [judge_body] = fake.of("judge")
    assert NEEDLE in json.dumps(judge_body) and BIG in judge_body["messages"][1]["content"]
    assert s.EVIDENCE_MODE_SENTENCE["full"] in judge_body["messages"][0]["content"]
    [result] = events(run, "reflection_result")
    input_chars = sum(len(m["content"]) for m in judge_body["messages"])
    assert result["evidenceMode"] == "full" and result["judgeInputChars"] == input_chars, result
    [record] = [e["record"] for e in run.events if e["type"] == "obs_record" and e["record"].get("role") == "reflection"]
    assert (record["evidenceMode"], record["judgeInputChars"], record["evidenceChars"]) == ("full", input_chars, 20_000), record
    assert run.evidence["1.1"]["call_big"] == {"name": "fs__read_file", "args": '{"path": "/big.txt"}', "ok": True, "attempt": 0, "result": BIG}

    # Over judgeEvidenceMaxTokens: excerpts mode — an index line per call, never the full result, and the judge is told.
    judge = verdicts(5)
    run, fake = run_one_step(lambda role, body: judge() if role == "judge" else worker_reply(body) if role == "worker" else {"content": "done [1.1]"},
                             judgeEvidenceMaxTokens=1_000)
    [judge_body] = fake.of("judge")
    assert NEEDLE not in json.dumps(judge_body) and s.EVIDENCE_MODE_SENTENCE["excerpts"] in judge_body["messages"][0]["content"]
    assert '- call_big · fs__read_file · {"path": "/big.txt"} · ok · 20000 chars' in judge_body["messages"][1]["content"]
    assert events(run, "reflection_result")[0]["evidenceMode"] == "excerpts"

    # Full mode that the remaining budget cannot pay for falls back to excerpts instead of waiting.
    judge = verdicts(5)
    run, fake = run_one_step(lambda role, body: judge() if role == "judge" else worker_reply(body) if role == "worker" else {"content": "done [1.1]"},
                             request={"pricing": {"m/r": s.Pricing(prompt=3e-4, completion=1e-6)}})
    assert events(run, "reflection_result")[0]["evidenceMode"] == "excerpts" and NEEDLE not in json.dumps(fake.of("judge")[0])

    # Half the judge's context window caps the full-evidence budget.
    run = s.Run("x", s.RunRequest(runId="x", chatId="c", task="t", openRouterApiKey="k", currentDateTime="d", pricing={"m/r": s.Pricing(prompt=0, completion=0, contextLength=8_000)},
                                  config=s.Config(maxAgents=1, budgetCapUsd=1, models={}, reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=1_000)))
    assert s.judge_evidence_limit(run, "m/r") == 4_000 and s.judge_evidence_limit(run, "unknown") == 100_000

    # 2. Three score-2 verdicts with maxRetriesPerAgent=2 fail the step and the run. // flips in Phase 5
    judge = verdicts(2, 2, 2)
    run, fake = run_one_step(lambda role, body: judge() if role == "judge" else worker_reply(body) if role == "worker" else {"content": "done [1.1]"})
    failed = events(run, "agent_failed")
    assert len(failed) == 1 and failed[0]["reason"].startswith("reflection retry limit exceeded"), failed
    assert run.events[-1]["type"] == "task_failed" and not fake.of("synthesis")

    # 3. A retry starts from nothing: attempt 1's first request has none of attempt 0's tool results. // flips in Phase 4
    judge = verdicts(2, 5)
    run, fake = run_one_step(lambda role, body: judge() if role == "judge" else worker_reply(body) if role == "worker" else {"content": "done [1.1]"},
                             tool_result=lambda n: f"RESULT-{n} " + "x" * 100)
    order = [role for role, _ in fake.requests]
    first_judge = order.index("judge")
    attempt0 = [b for r, b in fake.requests[:first_judge] if r == "worker"]
    attempt1_first = next(b for r, b in fake.requests[first_judge:] if r == "worker")
    assert "RESULT-1" in json.dumps(attempt0[-1])
    assert "RESULT-1" not in json.dumps(attempt1_first) and ANSWER not in json.dumps(attempt1_first)
    assert not any(m["role"] == "tool" for m in attempt1_first["messages"])
    # Phase 1: servers Electron left out of the worker tools are echoed in run_config (the trace).
    excluded = [{"server": "memory", "reason": "sandbox bypassed"}]
    run, _ = run_one_step(lambda role, body: {"content": json.dumps({"score": 5, "reason": "ok", "issues": []})} if role == "judge" else worker_reply(body)
                          if role == "worker" else {"content": "done [1.1]"}, request={"excludedServers": excluded})
    assert events(run, "run_config")[0]["excludedServers"] == excluded
    print("ok")
