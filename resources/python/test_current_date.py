"""Every role's system message ends with Electron's date line; a run without it is rejected."""
import asyncio
import json

import pydantic

import multi_agent_sidecar as s

DATE = "Current date and time: Monday, October 5, 2026, 10:38 PM GMT+8."
ANSWER = "Findings: the itinerary covers three cities over ten days with rail between them."
PLAN = json.dumps([{"id": "1.1", "label": "Research", "role": "Researcher", "dependsOn": []},
                   {"id": "1.2", "label": "Budget", "role": "Planner", "dependsOn": []}])


def request(**extra):
    config = s.Config(maxAgents=2, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesis": "m/s"},
                      reflectionPassThreshold=1, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    return s.RunRequest(runId="r", chatId="c", task="Plan a December trip", config=config, openRouterApiKey="k", **extra)


if __name__ == "__main__":
    calls = []
    replies = {"planner": PLAN, "worker": ANSWER + "\n\n```claims\n[]\n```", "reflection": '{"score": 5, "reason": "ok", "issues": []}', "synthesis": ANSWER}

    async def ask(_run, _model, messages, *, obs=None, synthesis=False, **_k):
        role = "synthesis" if synthesis else (obs or {}).get("role")
        calls.append((role, [dict(m) for m in messages]))
        return {"content": replies[role]}, 1, 0.0

    async def approve(*_a, **_k):
        return True, ""

    s.ask = ask
    run = s.Run("r", request(currentDateTime=DATE))
    run.wait_for_approval = approve
    asyncio.run(s.orchestrate(run))
    assert run.events[-1]["type"] == "task_complete", run.events[-1]
    assert {role for role, _ in calls} == {"planner", "worker", "reflection", "synthesis"}, calls
    for role, messages in calls:
        assert messages[0]["role"] == "system" and messages[0]["content"].endswith("\n\n" + DATE), (role, messages[0])

    for bad in ({}, {"currentDateTime": ""}):
        try:
            request(**bad)
        except pydantic.ValidationError:
            continue
        raise AssertionError(f"RunRequest accepted {bad}")
    print("ok")
