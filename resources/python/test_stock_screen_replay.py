"""Reflection hardening Phase 6: the failing stock screen (run 69750960), replayed from its recorded
fixture, now reaches synthesis; and the planner is told to split wide screening work."""
import asyncio
import json
import os

import multi_agent_sidecar as s
from test_reflection_evidence import FakeOpenRouter

FIXTURE = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "stock_screen_69750960.json")))
BUILTINS = [{"name": n, "description": "", "parameters": {"type": "object"}} for n in ("builtin__brave_web_search", "builtin__get_ticker_price")]
SHORT = "Findings for this lens: ALAB and CRDO lead on the evidence passed in from the screen [c1].\n\n```claims\n" + \
        json.dumps([{"id": "c1", "claim": "ALAB and CRDO lead", "source": "1.1"}]) + "\n```"


def subtask(body):
    user = body["messages"][1]["content"] if len(body["messages"]) > 1 else ""
    return user.split("Your subtask (", 1)[1].split(")", 1)[0] if "Your subtask (" in user else user.split("Subtask (", 1)[-1].split(")", 1)[0]


def orchestrate(route, config, tools, results):
    fake = FakeOpenRouter(route)
    s._stream_openrouter = fake
    run = s.Run("r", s.RunRequest(runId="r", chatId="c", task=FIXTURE["task"], config=s.Config(**config), tools=tools,
                                  openRouterApiKey="k", currentDateTime="Current date and time: Wednesday, October 7, 2026, 11:32 PM GMT+8."))
    approvals = []

    async def approve(agent_id, _role, _model, tool, server, args):
        if agent_id == "orchestrator":
            return True, ""
        approvals.append(f"{server}__{tool}")
        return results(agent_id)

    run.wait_for_approval = approve
    asyncio.run(s.orchestrate(run))
    return run, fake, approvals


if __name__ == "__main__":
    # Replay: 1.1 gives its three recorded attempts (tool calls and answers, in order), the judge its recorded
    # verdicts (2, 1, 2), the bypassed MCP servers are no longer offered; every other step answers briefly.
    replies = iter(FIXTURE["worker_1_1"])
    verdicts = iter(FIXTURE["verdicts_1_1"])
    recorded = iter([t for t in FIXTURE["tools_1_1"] if t["name"].startswith("builtin__")])
    last = [None]

    def route(role, body):
        if role == "planner":
            return {"content": FIXTURE["plan"]}
        if role == "synthesis":
            user = body["messages"][1]["content"]
            return {"content": ("Screening (1.1) was accepted with caveats. " if "[1.1 DEGRADED" in user else "") + "Recommendations follow [1.1] [3.1]."}
        if role == "judge":
            return {"content": next(verdicts)} if subtask(body) == "1.1" else {"content": '{"score": 5, "reason": "ok", "issues": []}'}
        if subtask(body) != "1.1":
            return {"content": SHORT}
        reply = next(replies, last[0])
        last[0] = reply
        calls = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in reply["toolCalls"]]
        return {"tool_calls": calls} if calls else {"content": reply["content"]}

    def tool_result(agent_id):
        item = next(recorded)
        return item["approved"], item["result"]

    config = {**FIXTURE["config"], "budgetCapUsd": 10}  # the fake reports $0 per call; the cap is not what is under test
    run, fake, approvals = orchestrate(route, config, BUILTINS, tool_result)
    kinds = [e["type"] for e in run.events]
    by_agent = lambda kind: {e["agentId"]: e for e in run.events if e["type"] == kind}
    assert kinds[-1] == "task_complete", [e for e in run.events if e["type"] in ("agent_failed", "task_failed")]
    assert "1.1" in by_agent("agent_degraded") or by_agent("reflection_result")["1.1"]["passed"]
    assert not [e for e in run.events if e["type"] == "agent_failed"]
    assert {e["agentId"] for e in run.events if e["type"] == "agent_complete"} == {"1.1", "2.1", "2.2", "2.3", "2.4", "3.1"}
    assert any(r == "synthesis" for r, _ in fake.requests) and "accepted with caveats" in run.events[-1]["finalOutput"]
    # Only callable tools reached Electron; the recorded filesystem/memory calls were rejected in the sidecar.
    assert approvals and all(a.startswith("builtin__") for a in approvals)
    # Missing claims blocks were caught mechanically: the judge saw 1.1 once, on its last attempt.
    assert sum(1 for r, b in fake.requests if r == "judge" and subtask(b) == "1.1") == 1
    assert [e["model"] for e in run.events if e["type"] == "reflection_result" and e["agentId"] == "1.1"] == ["claims check", "claims check", config["models"]["reflection"]]

    # Prompts: the worker's unverifiable-criterion rule; the rubric's quote rule; the judge's discipline; item 4 only with dependencies.
    worker_system = next(b for r, b in fake.requests if r == "worker")["messages"][0]["content"]
    assert ("If a criterion cannot be verified with your tools, report it as unverified with the reason. Never report an unverifiable "
            "criterion as met or as failed, and do not eliminate an item only because data is missing; flag it instead.") in worker_system
    assert "Never claim to have executed anything you did not." in worker_system
    assert s.REFLECTION_RUBRIC[1] == ("Every factual claim carries a quote from a tool result that supports it, or is explicitly marked "
                                      "unverified; a claim marked unverified is not an issue") and len(s.REFLECTION_RUBRIC) == 4
    judges = {subtask(b): b["messages"][0]["content"] for r, b in fake.requests if r == "judge"}
    for system in judges.values():
        assert ("Do not infer that something was invented from its absence in an excerpt; report only claims whose quote does not "
                "support them, assertions with no marker, and rubric failures.") in system and "Score 1 (useless) to 5 (excellent)." in system
    assert "skip rubric item 4" in judges["1.1"] and "skip rubric item 4" not in judges["2.1"]

    # Planner: told to split wide screening by sector/theme with a merge step; such a plan runs its sector steps in parallel.
    sectors = json.dumps([{"id": f"1.{i}", "label": f"Screen {name} names", "role": "Screener", "dependsOn": []}
                          for i, name in ((1, "semiconductor"), (2, "software"), (3, "healthcare"))]
                         + [{"id": "2.1", "label": "Merge the screens and apply the exclusions", "role": "Merger", "dependsOn": ["1.1", "1.2", "1.3"]}])
    plan_route = lambda role, body: ({"content": sectors} if role == "planner" else
                                     {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge" else
                                     {"content": "Done."} if role == "synthesis" else {"content": SHORT})
    run, fake, _ = orchestrate(plan_route, {**FIXTURE["config"], "budgetCapUsd": 10}, [], lambda _a: (True, ""))
    planner_system = next(b for r, b in fake.requests if r == "planner")["messages"][0]["content"]
    assert ("If a step must evaluate many candidates against several criteria, split it by sector, theme or criterion group into "
            "parallel steps and add one merge step that applies the exclusions and combines the results.") in planner_system
    [plan] = [e for e in run.events if e["type"] == "orchestrator_plan"]
    assert [st["phase"] for st in plan["steps"]] == [1, 1, 1, 2] and plan["steps"][3]["dependsOn"] == ["1.1", "1.2", "1.3"]
    starts = [i for i, e in enumerate(run.events) if e["type"] == "agent_start" and e["agentId"].startswith("1.")]
    first_done = next(i for i, e in enumerate(run.events) if e["type"] == "agent_complete")
    assert len(starts) == 3 and max(starts) < first_done  # all three sector screens were running at once
    assert run.events[-1]["type"] == "task_complete"
    print("ok")
