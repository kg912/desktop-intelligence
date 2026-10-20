"""Rectification R4: every path that ends an agent with an answer emits its claims. agent_complete carries the attempt's
claims (as verified: quotes filled from snippets, re-pointed callIds) and their statuses, so the UI has them even when no
reflection_result follows: the budget-reached return, the degraded answer, a re-run (and a resumed run, which runs the
same worker code). The UI falls back to agent_complete's claims when the gate has none."""
import asyncio

import fake_harness as h
import multi_agent_sidecar as s

PLAN = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": [], "covers": ["r1"]}],
        "checklist": [{"id": "r1", "text": "Airlines, leg 1", "scope": "1.1"}]}
FACTS = {"1.1": [("Turkish Airlines flies IST-NAV", "r1", "verified"), ("Exact Dec 18 times", "r1", "unverified")]}
RESULT = "Turkish Airlines flies IST to NAV daily in winter."
CLAIMS = [{"id": "c1", "claim": "Turkish Airlines flies IST-NAV", "req": "r1", "snippets": ["S1.1"], "callId": "call_1.1", "quote": RESULT},
          {"id": "c2", "claim": "Exact Dec 18 times", "req": "r1", "unverified": True}]
STATUSES = {"c1": "verified", "c2": "unverified_declared"}


def answers(run, agent="1.1"):
    return [e for e in h.events(run, "agent_complete") if e["agentId"] == agent]


def test_a_passing_answer_carries_its_claims_on_agent_complete_and_on_the_gate():
    run, _ = h.run(PLAN, h.researcher(FACTS), tool_result=RESULT, maxWaves=1)
    [done] = answers(run)
    assert (done["claims"], done["claimStatuses"]) == (CLAIMS, STATUSES)
    [gate] = h.events(run, "reflection_result")
    assert (gate["claims"], gate["claimStatuses"]) == (CLAIMS, STATUSES)


def test_budget_reached_after_the_answer_still_emits_the_claims():
    research = h.researcher(FACTS)

    def worker(agent, body):
        reply = research(agent, body)
        return {**reply, "cost": 2.0} if "content" in reply else reply  # the answer itself spends past the cap
    run, _ = h.run(PLAN, worker, tool_result=RESULT, maxWaves=1, budgetCapUsd=1)
    assert run.budget_reached
    assert h.events(run, "reflection_result") == []  # the early return: no gate, so the gate carries nothing
    [done] = answers(run)
    assert (done["claims"], done["claimStatuses"]) == (CLAIMS, STATUSES)
    assert run.step_results["1.1"]["statuses"] == STATUSES


def test_a_degraded_answer_carries_its_claims():
    def failing_judge(_agent, _body):
        return {"content": '{"score": 2, "reason": "thin", "issues": ["thin"]}'}
    run, _ = h.run(PLAN, h.researcher(FACTS), tool_result=RESULT, maxWaves=1, extra_routes={"judge": failing_judge}, onRetryExhausted="degrade")
    [degraded] = h.events(run, "agent_degraded")
    [done] = [e for e in answers(run) if e["attempt"] == degraded["attempt"]]
    assert (done["claims"], done["claimStatuses"]) == (CLAIMS, STATUSES)


def test_a_rerun_step_emits_its_new_claims(tmp_path):
    s.STATE = s.StateStore(str(tmp_path / "state.sqlite"))
    try:
        run, _ = h.run(PLAN, h.researcher(FACTS), tool_result=RESULT, maxWaves=1)
        s._stream_openrouter = h.Fake({"worker": h.researcher({"1.1": [("Pegasus flies SAW-NAV", "r1", "verified")]}), "judge": h.passing_judge,
                                       "synthesis": lambda _a, _b: {"content": "Second answer."}})
        rerun, state = s.prepare_rerun("run", "1.1", api_key="k", last_seq=run.seq)

        async def approve(agent_id, *_a, **_k):
            return (True, "") if agent_id == "orchestrator" else (True, "Pegasus flies SAW to NAV on Fridays.")
        rerun.wait_for_approval = approve
        asyncio.run(s.orchestrate(rerun, state))
        [done] = answers(rerun)
        assert [c["claim"] for c in done["claims"]] == ["Pegasus flies SAW-NAV"]
        assert done["claimStatuses"] == {"c1": "verified"}
    finally:
        s.STATE = None
