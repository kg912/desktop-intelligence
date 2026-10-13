"""Spec A Phase 9: Electron reports how a worker tool call was approved, the person's wait and the tool's own time;
the sidecar puts them on hitl_resume, tool_done and the tool's call record. Drives the real /hitl handler."""
import asyncio
import json

import multi_agent_sidecar as s
from test_reflection_evidence import FakeOpenRouter, worker_reply, NO_CLAIMS


def run_with_hitl(meta_for):
    fake = FakeOpenRouter(lambda role, body: {"content": json.dumps([{"id": "1.1", "label": "Read it", "role": "Reader", "dependsOn": []}])}
                          if role == "planner" else {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                          else worker_reply(body) if role == "worker" else {"content": "done [1.1]"})
    s._stream_openrouter = fake
    cfg = s.Config(maxAgents=1, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    run = s.Run("hitl-run", s.RunRequest(runId="hitl-run", chatId="c", task="t", config=cfg, openRouterApiKey="k", currentDateTime="x", observe=True,
                                         tools=[{"name": "fs__read_file", "description": "", "parameters": {"type": "object"}}]))
    s.RUNS[run.run_id] = run

    async def scenario():
        queue: asyncio.Queue = asyncio.Queue()
        run.subscribers.append(queue)
        task = asyncio.create_task(s.orchestrate(run))
        while (event := await queue.get()) is not None:
            if event.get("type") == "hitl_pause":
                extra = {} if event["agentId"] == "orchestrator" else meta_for(event)
                await s.hitl(run.run_id, s.HitlResponse(runId=run.run_id, agentId=event["agentId"], approved=True, result="file text", **extra))
        await task
    asyncio.run(scenario())
    s.RUNS.pop(run.run_id, None)
    return run


def test_asked_call_wait_and_tool_time_reach_every_trace():
    run = run_with_hitl(lambda _e: {"approvalMode": "asked", "waitMs": 4_000, "toolMs": 900})
    resume = [e for e in run.events if e.get("type") == "hitl_resume" and e["agentId"] == "1.1"]
    done = [e for e in run.events if e.get("type") == "tool_done"]
    assert resume and (resume[0]["approvalMode"], resume[0]["waitMs"], resume[0]["toolMs"]) == ("asked", 4_000, 900)
    assert done and (done[0]["approvalMode"], done[0]["waitMs"], done[0]["toolMs"]) == ("asked", 4_000, 900)
    [record] = [e["record"] for e in run.events if e.get("type") == "obs_record" and e["record"]["kind"] == "tool"]
    assert record["approvalMode"] == "asked" and (record["timing"]["waitMs"], record["timing"]["toolMs"]) == (4_000, 900)


def test_trusted_call_and_older_electron_without_the_fields():
    run = run_with_hitl(lambda _e: {"approvalMode": "trusted", "waitMs": 0, "toolMs": 12})
    assert [e["approvalMode"] for e in run.events if e.get("type") == "tool_done"] == ["trusted"]
    run = run_with_hitl(lambda _e: {})
    done = [e for e in run.events if e.get("type") == "tool_done"][0]
    assert "approvalMode" not in done and "waitMs" not in done  # nothing invented when Electron did not say
    plan_resume = next(e for e in run.events if e.get("type") == "hitl_resume" and e["agentId"] == "orchestrator")
    assert "approvalMode" not in plan_resume


assert NO_CLAIMS
