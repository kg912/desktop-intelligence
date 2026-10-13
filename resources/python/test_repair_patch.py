"""Spec A Phase 5: patch-only repairs (only the failing claims are re-sent and patched into the previous report)
and model escalation from the second repair on."""
import json

import fixture_run
import multi_agent_sidecar as s
from test_reflection_evidence import CALL, events, run_one_step, verdicts

RESULT = "The museum opens at 09:00. It closes at 17:00. Tickets cost 12 EUR. Closed on Mondays."
PROSE = "The museum opens at nine [c1], tickets are twelve euros [c2] and it closes on Mondays [c3]."
C1 = {"id": "c1", "claim": "Opens 09:00", "callId": "call_big", "quote": "The museum opens at 09:00."}
C2_BAD = {"id": "c2", "claim": "Tickets 12 EUR", "callId": "call_big", "quote": "Tickets cost 15 EUR."}
C2_GOOD = {"id": "c2", "claim": "Tickets 12 EUR", "callId": "call_big", "quote": "Tickets cost 12 EUR."}
C3 = {"id": "c3", "claim": "Closed Mondays", "callId": "call_big", "quote": "Closed on Mondays."}


def full(*claims, prose=PROSE):
    return {"content": prose + "\n\n```claims\n" + json.dumps(list(claims)) + "\n```"}


def patch(replace=(), drop=()):
    return {"content": "```claims_patch\n" + json.dumps({"replace": list(replace), "drop": list(drop)}) + "\n```"}


def worker(answers, judge=lambda: {"content": '{"score": 5, "reason": "ok", "issues": []}'}):
    it = iter(answers)
    return lambda role, body: judge() if role == "judge" else (next(it) if any(m["role"] == "tool" for m in body["messages"]) else CALL) \
        if role == "worker" else {"content": "done [1.1]"}


def test_apply_claims_patch():
    claims = [dict(C1), dict(C2_BAD), dict(C3)]
    merged, errors = s.apply_claims_patch(claims, {"replace": [C2_GOOD], "drop": ["c3"]})
    assert errors == []
    assert merged == [C1, C2_GOOD, {"id": "c3", "claim": "Closed Mondays", "unverified": True}]
    assert claims[0] == C1  # the input is not mutated
    _, errors = s.apply_claims_patch(claims, {"replace": [{"id": "c2"}], "drop": "c3"})
    assert errors == ['Claim c2 needs an "id" and a "claim".', 'The claims_patch "drop" must be a list of claim ids.']


def test_some_claims_failed_patch_repair_keeps_the_rest_and_the_prose():
    run, fake = run_one_step(worker([full(C1, C2_BAD, C3), patch([C2_GOOD])]), tool_result=lambda n: RESULT)
    first, second = events(run, "reflection_result")
    assert first["model"] == "claims check" and first["claimStatuses"] == {"c1": "verified", "c2": "quote_not_found", "c3": "verified"}
    repair = fake.of("worker")[-1]["messages"][-1]["content"]
    assert repair == s.patch_turn([dict(C2_BAD, **{})], {"c2": "quote_not_found"}, {"call_big": {"ok": True, "result": RESULT}})
    assert "c1" not in repair.split("Reply with")[0] and "- c2 [mismatch]:" in repair and "```claims_patch" in repair
    assert second["passed"] and second["claimStatuses"] == {"c1": "verified", "c2": "verified", "c3": "verified"}
    completes = events(run, "agent_complete")
    assert [c["output"] for c in completes] == [PROSE, PROSE]  # the report text was not rewritten
    judge = fake.of("judge")[0]["messages"][1]["content"]
    assert 'quote: "The museum opens at 09:00."' in judge and 'quote: "Tickets cost 12 EUR."' in judge and "Output to judge:\n" + PROSE in judge


def test_dropped_claim_becomes_unverified():
    run, _ = run_one_step(worker([full(C1, C2_BAD, C3), patch(drop=["c2"])]), tool_result=lambda n: RESULT)
    assert events(run, "reflection_result")[1]["claimStatuses"] == {"c1": "verified", "c2": "unverified_declared", "c3": "verified"}


def test_a_full_answer_instead_of_a_patch_is_accepted():
    run, _ = run_one_step(worker([full(C1, C2_BAD, C3), full(C1, C2_GOOD, C3, prose=PROSE + " Updated.")]), tool_result=lambda n: RESULT)
    assert events(run, "reflection_result")[1]["passed"] and events(run, "agent_complete")[1]["output"] == PROSE + " Updated."


def test_all_claims_failed_gets_a_full_rewrite_turn():
    bad1 = dict(C1, quote="The museum opens at 10:00.")
    run, fake = run_one_step(worker([full(bad1, C2_BAD), full(C1, C2_GOOD)]), tool_result=lambda n: RESULT)
    assert fake.of("worker")[-1]["messages"][-1]["content"].startswith("Reviewer verdict: score 1/5")
    assert events(run, "reflection_result")[1]["passed"]


def test_wrong_call_lists_candidate_snippet_ids():
    store = {"a": {"ok": True, "result": "x", "snippets": {"S1.1": "x"}},
             "b": {"ok": True, "result": "[1] T\nu\nDirect flights 6 days a week.\n\n[2] U\nv\nother", "snippets": {"S2.1": "T\nu\nDirect flights 6 days a week.", "S2.2": "U\nv\nother"}},
             "c": {"ok": True, "result": "Direct flights 6 days a week, it says.", "snippets": {"S3.1": "Direct flights 6 days a week, it says."}}}
    claim = {"id": "c2", "claim": "6 days", "callId": "a", "quote": "Direct flights 6 days a week"}
    status = s.verify_claim(claim, store)
    assert status == "quote_found_elsewhere"
    turn = s.patch_turn([claim], {"c2": status}, store)
    assert "- c2 [wrong_call]: the quote is not in the cited tool result but is in several others; candidate snippets: S2.1, S3.1" in turn


def test_escalation_model_from_the_second_repair():
    judge = verdicts(2, 2, 2)
    run, fake = run_one_step(worker([full(C1, C2_GOOD, C3)] * 3, judge=judge), tool_result=lambda n: RESULT)  # no escalation model
    assert [r.get("escalated") for r in events(run, "retry")] == [None, None]
    judge = verdicts(2, 2, 2)
    run, fake = run_one_step(worker([full(C1, C2_GOOD, C3)] * 3, judge=judge), tool_result=lambda n: RESULT, models={"escalation": "m/esc"})
    retries = events(run, "retry")
    assert [(r["attempt"], r.get("escalated")) for r in retries] == [(1, None), (2, True)] and retries[1]["model"] == "m/esc"
    models = [(b["model"], len([m for m in b["messages"] if m["role"] == "user"])) for b in fake.of("worker")]
    assert {m for m, users in models if users >= 3} == {"m/esc"}  # attempt 2 (after the second verdict turn) runs on the escalation model
    assert {m for m, users in models if users < 3} == {"m/w"}


def test_fixture_patch_output_is_under_a_quarter_of_a_full_rewrite():
    """Each agent that failed the claims check at attempt 0: its recorded attempt-1 answer (a full rewrite) vs a
    claims_patch carrying only the attempt-1 versions of the claims that had failed."""
    fx = fixture_run.load()
    full_tokens = patch_tokens = 0
    for agent in fixture_run.worker_agents(fx):
        gate = next(e for e in fx["events"] if e["type"] == "reflection_result" and e["agentId"] == agent and e["attempt"] == 0)
        failed = [cid for cid, st in gate["claimStatuses"].items() if st not in s.CLAIM_OK]
        if not failed:
            continue
        rewrite = fixture_run.final_answer(fx["records"][agent], 1)
        _, fixed, _ = s.parse_claims(rewrite)
        replace = [c for c in fixed if c["id"] in failed]
        full_tokens += s.estimate_tokens(rewrite)
        patch_tokens += s.estimate_tokens(patch(replace)["content"])
    assert full_tokens and patch_tokens < 0.25 * full_tokens, (patch_tokens, full_tokens)
