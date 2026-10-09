"""Reflection hardening Phase 5: exhausted retries pass the best attempt on, degraded, with its caveats;
only a step with no usable output fails."""
import asyncio
import json

import multi_agent_sidecar as s
from test_reflection_evidence import FakeOpenRouter

PLAN = json.dumps([{"id": "1.1", "label": "Screen the names", "role": "Screener", "dependsOn": []},
                   {"id": "2.1", "label": "Rank the shortlist", "role": "Ranker", "dependsOn": ["1.1"]}])
CALL = {"tool_calls": [{"id": "call_q", "type": "function", "function": {"name": "web__search", "arguments": '{"q": "ALAB"}'}}]}
RESULT = "ALAB reported record revenue of $392.4 million for the quarter, up 12% year over year."
CLAIMS = [{"id": "c1", "claim": "ALAB revenue $392.4M", "callId": "call_q", "quote": "record revenue of $392.4 million"},
          {"id": "c2", "claim": "13F trend", "unverified": True}]


def shortlist(n):
    return {"content": f"Shortlist v{n}: ALAB passes the revenue screen [c1]; its 13F trend is unverified [c2].\n\n```claims\n{json.dumps(CLAIMS)}\n```"}


def run_plan(screener, scores, config=None, ranker=None):
    """1.1 (Screener) then 2.1 (Ranker, depends on 1.1). scores: judge verdicts for 1.1, in order (2.1 always gets 5)."""
    verdicts = iter(scores)

    def route(role, body):
        user = body["messages"][1]["content"] if len(body["messages"]) > 1 else ""
        if role == "planner":
            return {"content": PLAN}
        if role == "judge":
            if "Subtask (2.1)" in user:
                return {"content": '{"score": 5, "reason": "ok", "issues": []}'}
            v = next(verdicts)
            return {"content": v} if isinstance(v, str) else {"content": json.dumps({"score": v, "reason": f"scored {v}", "issues": [f"issue at {v}"]})}
        if role == "synthesis":
            caveat = "Step 1.1 was accepted with caveats [1.1]." if "DEGRADED" in user or "UNREVIEWED" in user else "All steps passed [1.1]."
            return {"content": caveat + " Ranked [2.1]."}
        if "Ranker agent" in body["messages"][0]["content"]:
            return ranker(body) if ranker else {"content": "Ranking: ALAB first, per the screen [c1].\n\n```claims\n" +
                                                json.dumps([{"id": "c1", "claim": "ALAB first", "source": "1.1"}]) + "\n```"}
        return screener(body)

    fake = FakeOpenRouter(route)
    s._stream_openrouter = fake
    cfg = s.Config(maxAgents=2, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                   reflectionPassThreshold=4, maxRetriesPerAgent=2, hitlTimeoutMs=60_000, **(config or {}))
    run = s.Run("r", s.RunRequest(runId="r", chatId="c", task="Screen 12 names on 6 criteria", config=cfg, openRouterApiKey="k",
                                  currentDateTime="Current date and time: x.",
                                  tools=[{"name": "web__search", "description": "", "parameters": {"type": "object"}}]))

    async def approve(agent_id, *_a, **_k):
        return True, RESULT

    run.wait_for_approval = approve
    asyncio.run(s.orchestrate(run))
    return run, fake


def screener_with_tool(answers):
    it = iter(answers)
    return lambda body: next(it) if any(m["role"] == "tool" for m in body["messages"]) else CALL


def of(run, kind, agent="1.1"):
    return [e for e in run.events if e["type"] == kind and e.get("agentId", agent) == agent]


if __name__ == "__main__":
    # Three rejections: the best attempt (score 3 at attempt 0, not the latest) is passed on, degraded; the dependant runs on it.
    run, fake = run_plan(screener_with_tool([shortlist(0), shortlist(1), shortlist(2)]), [3, 2, 2])
    [degraded] = of(run, "agent_degraded")
    assert degraded == {**degraded, "attempt": 0, "score": 3, "issues": ["issue at 3"],
                        "claimStatuses": {"c1": "verified", "c2": "unverified_declared"}}, degraded
    assert degraded["reason"].startswith("reflection retry limit exceeded (score 2/5")
    assert not [e for e in run.events if e["type"] == "agent_failed"]
    ranker_prompt = [b for r, b in fake.requests if r == "worker" and "Ranker agent" in b["messages"][0]["content"]][0]["messages"][1]["content"]
    downstream = ("[1.1 DEGRADED: score 3/5; open issues: issue at 3]\n"
                  "Shortlist v0: ALAB passes the revenue screen [c1]; its 13F trend is unverified [c2].\n\n"
                  "Claims (1.1): c1 verified; c2 unverified")
    assert f"[1.1] {downstream}" in ranker_prompt, ranker_prompt
    synth = [b for r, b in fake.requests if r == "synthesis"][0]["messages"]
    assert downstream in synth[1]["content"] and "drop or explicitly caveat any claim marked failed-check" in synth[0]["content"]
    assert "Claims (2.1): c1 from 1.1" in synth[1]["content"]
    assert run.events[-1]["type"] == "task_complete" and "accepted with caveats" in run.events[-1]["finalOutput"]

    # A failing claim is labelled failed-check downstream (ties going to the latest attempt are pinned in test_reflection_evidence).
    bad = [{"id": "c1", "claim": "ALAB revenue", "callId": "call_q", "quote": "record revenue of $500 million"}]
    answers = [{"content": "Shortlist with a wrong figure for ALAB revenue in it [c1].\n\n```claims\n" + json.dumps(bad) + "\n```"}] * 3
    run, fake = run_plan(screener_with_tool(answers), [2])  # attempts 0 and 1: claims check (score 1); attempt 2 judged 2
    [degraded] = of(run, "agent_degraded")
    assert (degraded["attempt"], degraded["score"]) == (2, 2) and len([r for r, _ in fake.requests if r == "judge"]) == 2  # 1.1 once, 2.1 once
    assert "Claims (1.1): c1 failed-check" in [b for r, b in fake.requests if r == "synthesis"][0]["messages"][1]["content"]

    # The judge unavailable (score 0) is not a rejection: accepted as unreviewed, the worker is not re-asked.
    run, fake = run_plan(screener_with_tool([shortlist(0)]), ["no json", "still no json"])
    [degraded] = of(run, "agent_degraded")
    assert degraded["unreviewed"] is True and degraded["score"] == 0 and not of(run, "retry")
    assert "[1.1 UNREVIEWED: the reviewer was unavailable]" in [b for r, b in fake.requests if r == "synthesis"][0]["messages"][1]["content"]

    # No usable output fails the step and cascades as before: empty every attempt, or a failing precheck every attempt.
    for screener in (lambda body: {"content": ""}, screener_with_tool([{"content": "Too short.\n\n```claims\n[]\n```"}] * 3)):
        run, fake = run_plan(screener, [5, 5, 5])
        failed = {e["agentId"]: e["reason"] for e in run.events if e["type"] == "agent_failed"}
        assert set(failed) == {"1.1", "2.1"} and failed["2.1"] == "dependency 1.1 failed" and not of(run, "agent_degraded"), failed
        assert run.events[-1]["type"] == "task_failed"

    # A later empty answer after a usable one still degrades to the usable one.
    answers = iter([shortlist(0), {"content": ""}, {"content": ""}])
    run, fake = run_plan(lambda body: next(answers) if any(m["role"] == "tool" for m in body["messages"]) else CALL, [2])
    [degraded] = of(run, "agent_degraded")
    assert degraded["attempt"] == 0 and degraded["reason"].startswith("no final answer") and run.events[-1]["type"] == "task_complete"

    # 'fail' keeps today's behaviour.
    run, fake = run_plan(screener_with_tool([shortlist(0), shortlist(1), shortlist(2)]), [3, 2, 2], {"onRetryExhausted": "fail"})
    failed = {e["agentId"]: e["reason"] for e in run.events if e["type"] == "agent_failed"}
    assert failed["1.1"].startswith("reflection retry limit exceeded") and failed["2.1"] == "dependency 1.1 failed"
    print("ok")
