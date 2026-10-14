"""Spec B 7a: the claims behind every [1.2 c3] chip travel with reflection_result, and their evidence is fetched lazily
by id (live run, or the saved state after the run left memory). Old runs have none: the UI says "evidence not stored"."""
import asyncio

import fake_harness as h
import multi_agent_sidecar as s

PLAN = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": [], "covers": ["r1"]},
                  {"id": "2.1", "label": "Check", "role": "Checker", "dependsOn": ["1.1"]}],
        "checklist": [{"id": "r1", "text": "Airlines, leg 1", "scope": "1.1"}]}
FACTS = {"1.1": [("Turkish Airlines flies IST-NAV", "r1", "verified"), ("Exact Dec 18 times", "r1", "unverified")],
         "2.1": [("Pegasus flies SAW-ASR", None, "verified")]}
RESULT = "Turkish Airlines flies IST to NAV daily in winter."


def test_reflection_result_carries_the_claims():
    run, _ = h.run(PLAN, h.researcher(FACTS), tool_result=RESULT, maxWaves=1)
    [gate] = [e for e in h.events(run, "reflection_result") if e["agentId"] == "1.1"]
    assert gate["claims"] == [
        {"id": "c1", "claim": "Turkish Airlines flies IST-NAV", "req": "r1", "snippets": ["S1.1"], "callId": "call_1.1", "quote": RESULT},
        {"id": "c2", "claim": "Exact Dec 18 times", "req": "r1", "unverified": True},
    ]
    assert gate["claimStatuses"] == {"c1": "verified", "c2": "unverified_declared"}


def test_evidence_by_id_live_then_from_saved_state(tmp_path):
    s.STATE = s.StateStore(str(tmp_path / "state.sqlite"))
    try:
        run, _ = h.run(PLAN, h.researcher(FACTS), tool_result=RESULT, maxWaves=1)
        s.RUNS[run.run_id] = run

        async def get(agent, call):
            try:
                return await s.get_evidence(run.run_id, agent, call)
            except s.HTTPException as exc:
                return exc.status_code
        live = asyncio.run(get("1.1", "call_1.1"))
        assert (live["agentId"], live["callId"], live["name"], live["ok"], live["result"]) == ("1.1", "call_1.1", "web__search", True, RESULT)
        assert live["snippets"] == {"S1.1": RESULT}
        # A cross-agent citation ("1.1/call_1.1") from step 2.1 resolves to 1.1's evidence.
        assert asyncio.run(get("2.1", "1.1/call_1.1"))["agentId"] == "1.1"
        assert asyncio.run(get("1.1", "call_nope")) == 404
        s.RUNS.pop(run.run_id)
        assert asyncio.run(get("1.1", "call_1.1"))["result"] == RESULT  # from the saved state
        s.STATE = None
        assert asyncio.run(get("1.1", "call_1.1")) == 404  # an old run: nothing stored
    finally:
        s.STATE = None
        s.RUNS.pop("run", None)


def test_synthesis_is_asked_for_claim_markers():
    assert "cite that claim as [1.1 c3] (agent marker, a space, the claim id)" in s.SYNTHESIS_SYSTEM
