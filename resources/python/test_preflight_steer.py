"""Spec B 7d (sidecar): an edited plan from pre-flight is validated like the planner's and run; a per-step budget
forces that step's wrap-up; a steer message reaches the agent at its next round and is logged; a lock on a live run
is announced. (A locked step not re-run: test_resume_rerun.py.)"""
import asyncio
import json
import threading

import fake_harness as h
import multi_agent_sidecar as s

PLAN = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": [], "covers": ["r1"]},
                  {"id": "1.2", "label": "Leg 2", "role": "Leg 2", "dependsOn": [], "covers": ["r2"]}],
        "checklist": [{"id": "r1", "text": "Leg 1 airlines", "scope": "1.1"}, {"id": "r2", "text": "Leg 2 airlines", "scope": "1.2"}]}
FACTS = {a: [(f"Airline for {a}", f"r{a[-1]}", "verified")] for a in ("1.1", "1.2", "2.1")}


def approve_with(plan_json):
    async def approve(agent_id, *_a, **_k):
        if agent_id == "orchestrator":
            return True, plan_json
        return True, "Search result text about the subject."
    return approve


def test_an_edited_plan_is_validated_and_run():
    edited = {"steps": [{"id": "1.1", "label": "Leg 1 via SAW only", "task": "Only Sabiha Gökçen departures.", "role": "Leg 1", "dependsOn": [], "covers": ["r1"],
                         "model": "m/strong", "budgetUsd": 0.2},
                        {"id": "2.1", "label": "Compare legs", "role": "Analyst", "dependsOn": ["1.1"]}]}  # 1.2 removed, 2.1 added
    run, fake = h.run(PLAN, h.researcher(FACTS), approve=approve_with(json.dumps(edited)), maxWaves=1)
    plans = h.events(run, "orchestrator_plan")
    assert len(plans) == 2 and plans[1]["edited"] is True
    assert [(st["id"], st["label"], st.get("model"), st.get("budgetUsd")) for st in plans[1]["steps"]] == [
        ("1.1", "Leg 1 via SAW only", "m/strong", 0.2), ("2.1", "Compare legs", "m/w", None)]
    workers = {a for r, a, _ in fake.calls if r == "worker"}
    assert workers == {"1.1", "2.1"}
    task = next(body["messages"][1]["content"] for agent, body in fake.of("worker") if agent == "1.1")
    assert "Only Sabiha Gökçen departures." in task
    assert {body["model"] for agent, body in fake.of("worker") if agent == "1.1"} == {"m/strong"}
    assert run.checklist == PLAN["checklist"]  # the checklist stays; covers re-validated against it


def test_an_invalid_edited_plan_fails_the_run_with_the_reason():
    cyclic = {"steps": [{"id": "1.1", "label": "A", "role": "R", "dependsOn": ["1.2"]}, {"id": "1.2", "label": "B", "role": "R", "dependsOn": ["1.1"]}]}
    run, fake = h.run(PLAN, h.researcher(FACTS), approve=approve_with(json.dumps(cyclic)), maxWaves=1)
    assert h.events(run, "task_failed")[0]["reason"] == "The edited plan is not valid: dependency cycle through 1.1"
    assert not [r for r, _, _ in fake.calls if r == "worker"]
    too_many = {"steps": [{"id": f"1.{i}", "label": f"S{i}", "role": "R", "dependsOn": []} for i in range(1, 7)]}
    run, _ = h.run(PLAN, h.researcher(FACTS), approve=approve_with(json.dumps(too_many)), maxWaves=1)
    assert h.events(run, "task_failed")[0]["reason"] == "The edited plan is not valid: 6 steps, the maximum is 4"


def test_a_step_budget_forces_its_wrap_up_round():
    cost = {"planner": 0, "judge": 0, "synthesis": 0, "worker": 0.05}
    rounds = []

    def worker(agent, body):
        rounds.append(body["tools"] is not None)
        if body["tools"] is None:  # the wrap-up round: no tools offered
            return {"content": h.answer("Findings for step 1.1: the sources agree on the facts listed in the claims below, each cited.", [])}
        return {"tool_calls": [{"id": f"call_{len(rounds)}", "type": "function", "function": {"name": "web__search", "arguments": '{"query": "q"}'}}]}
    plan = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": []}]}
    edited = {"steps": [{**plan["steps"][0], "budgetUsd": 0.1}]}
    run, _ = h.run(plan, worker, approve=approve_with(json.dumps(edited)), cost=cost, maxWaves=1, maxToolRounds=12)
    assert rounds == [True, True, False]  # 0.05 + 0.05 reaches the step's 0.10: the next round has no tools
    assert h.events(run, "task_complete")


def test_steer_reaches_the_agent_at_its_next_round_and_is_logged():
    steered = threading.Event()
    seen = []

    def worker(agent, body):
        seen.append([m["content"] for m in body["messages"] if m["role"] == "user"])
        if len(seen) == 1:
            steered.wait(5)  # the user steers while the first round is in flight
            return {"tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "web__search", "arguments": '{"query": "q"}'}}]}
        return {"content": h.answer("Findings for step 1.1: the sources agree on the facts listed in the claims below, each cited.", [])}
    plan = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": []}]}
    holder = {}
    original_run = s.run_worker

    async def spy(run, step, prior):
        holder["run"] = run
        return await original_run(run, step, prior)
    s.run_worker = spy

    async def steer_soon():
        while "run" not in holder:
            await asyncio.sleep(0.01)
        run = holder["run"]
        s.RUNS[run.run_id] = run
        try:
            out = await s.steer(run.run_id, "1.1", s.SteerRequest(message="Only use airline schedule pages, ignore aggregators."))
            assert out == {"ok": True}
            try:
                await s.steer(run.run_id, "9.9", s.SteerRequest(message="x"))
            except s.HTTPException as exc:
                assert exc.status_code == 409
        finally:
            steered.set()
    try:
        fake = h.Fake({"planner": h.planner(plan), "worker": worker, "judge": h.passing_judge, "synthesis": lambda _a, _b: {"content": "ok"}})
        s._stream_openrouter = fake
        cfg = s.Config(maxAgents=2, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                       reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000, maxWaves=1)
        run = s.Run("run", s.RunRequest(runId="run", chatId="c", task="t", config=cfg, tools=h.TOOLS, openRouterApiKey="k", currentDateTime="x"))

        async def approve(agent_id, *_a, **_k):
            return (True, "") if agent_id == "orchestrator" else (True, "Search result text.")
        run.wait_for_approval = approve

        async def both():
            await asyncio.gather(s.orchestrate(run), steer_soon())
        asyncio.run(both())
    finally:
        s.run_worker = original_run
        s.RUNS.pop("run", None)
    assert "Steering from the user: Only use airline schedule pages, ignore aggregators." in seen[1]  # the next round
    assert not any("Steering" in m for m in seen[0])
    steers = h.events(run, "steer")
    assert [(e["agentId"], e["status"]) for e in steers] == [("1.1", "queued"), ("1.1", "delivered")]
    assert steers[1]["message"] == "Only use airline schedule pages, ignore aggregators." and steers[1]["round"] == 1


def test_lock_on_a_live_run_is_announced():
    run, _ = h.run(PLAN, h.researcher(FACTS), maxWaves=1)
    run.finished = False
    s.RUNS[run.run_id] = run
    try:
        asyncio.run(s.lock_step(run.run_id, "1.1", s.LockRequest(locked=True)))
        assert h.events(run, "step_locked")[-1] | {} == {**h.events(run, "step_locked")[-1], "agentId": "1.1", "locked": True}
        assert "1.1" in run.locked
    finally:
        s.RUNS.pop(run.run_id, None)
