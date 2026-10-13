"""Spec A Phase 1: a quote cited to the wrong call is re-pointed when exactly one other result holds it;
with several candidates it fails as wrong_call and the repair turn names them."""
import json

import fixture_run
import multi_agent_sidecar as s
from test_reflection_evidence import TOOLS, events, run_one_step

A = "Kayseri to Izmir: direct flights 6 days a week with SunExpress."
B = "There are direct flights on this route 6 days a week: Mon, Tue, Wed, Thu, Fri, Sun."
C = "Nevsehir airport: 2 destinations served in winter."


def store(**results):
    return {cid: {"name": "brave", "args": "{}", "ok": ok, "attempt": 0, "result": text} for cid, (text, ok) in results.items()}


def claim(quote, call_id):
    return {"id": "c2", "claim": "6 days a week", "callId": call_id, "quote": quote}


def test_quote_in_exactly_one_other_result_is_repointed():
    c = claim("direct flights on this route 6 days a week", "call_a")
    assert s.verify_claim(c, store(call_a=(A, True), call_b=(B, True), call_c=(C, True))) == "verified_repointed"
    assert c["callId"] == "call_b" and c["repointedFrom"] == "call_a"


def test_unknown_call_id_is_repointed_too():
    c = claim("direct flights on this route 6 days a week", "call_typo")
    assert s.verify_claim(c, store(call_a=(A, True), call_b=(B, True))) == "verified_repointed" and c["callId"] == "call_b"


def test_fragments_and_repoint_together():
    c = claim("There are direct flights ... Thu, Fri, Sun", "call_a")
    assert s.verify_claim(c, store(call_a=(A, True), call_b=(B, True))) == "verified_fragments_repointed" and c["callId"] == "call_b"


def test_several_candidates_are_never_guessed():
    c = claim("2 destinations served in winter", "call_a")
    st = s.verify_claim(c, store(call_a=(A, True), call_b=(C, True), call_c=(C + " More.", True)))
    assert st == "quote_found_elsewhere" and c["callId"] == "call_a" and c["candidates"] == ["call_b", "call_c"]
    assert s.failure_class(c, st) == "wrong_call"
    assert s.claim_problems([c], {"c2": st}) == [
        "Claim c2 (callId call_a): the quote is not in the cited tool result but is in several others; cite one of: call_b, call_c."]


def test_failed_calls_are_not_candidates_and_failed_citation_classes():
    c = claim("direct flights on this route 6 days a week", "call_a")
    assert s.verify_claim(c, store(call_a=(A, True), call_b=(B, False))) == "quote_not_found"
    assert s.failure_class(c, "quote_not_found") == "mismatch"
    c = claim("direct flights on this route 6 days a week", "call_b")
    assert s.verify_claim(c, store(call_b=(B, False))) == "call_failed" and s.failure_class(c, "call_failed") == "call_failed"
    c = claim("direct flights on this route 6 days a week", "nope")
    assert s.verify_claim(c, store(call_a=(A, True))) == "call_not_found" and s.failure_class(c, "call_not_found") == "wrong_call"


def two_call_worker(answers):
    it = iter(answers)
    calls = {"tool_calls": [{"id": f"call_{x}", "type": "function", "function": {"name": "fs__read_file", "arguments": json.dumps({"path": x})}}
                            for x in ("a", "b", "c")]}

    def route(role, body):
        if role == "judge":
            return {"content": '{"score": 5, "reason": "ok", "issues": []}'}
        if role == "worker":
            return next(it) if any(m["role"] == "tool" for m in body["messages"]) else calls
        return {"content": "done [1.1]"}
    return route


def answer(*claims):
    return {"content": "The Kayseri to Izmir route has direct flights six days a week [c2].\n\n```claims\n" + json.dumps(list(claims)) + "\n```"}


def test_end_to_end_repointed_claim_needs_no_repair_turn():
    run, fake = run_one_step(two_call_worker([answer(claim("direct flights on this route 6 days a week", "call_a"))]),
                             tool_result=lambda n: (A, B, C)[n - 1])
    [result] = events(run, "reflection_result")
    assert result["passed"] and result["claimStatuses"] == {"c2": "verified_repointed"} and result["claimFailureClasses"] == {}
    assert len(fake.of("judge")) == 1 and not events(run, "retry")
    assert "call_b" in json.dumps(fake.of("judge")[0])  # the judge sees the re-pointed call id


def test_end_to_end_several_candidates_repair_names_them():
    first = answer(claim("2 destinations served in winter", "call_a"))
    fixed = answer(claim("2 destinations served in winter", "call_c"))
    run, fake = run_one_step(two_call_worker([first, fixed]), tool_result=lambda n: (A, C, C)[n - 1])
    results = events(run, "reflection_result")
    assert results[0]["model"] == "claims check" and results[0]["claimFailureClasses"] == {"c2": "wrong_call"}
    assert results[0]["claimStatuses"] == {"c2": "quote_found_elsewhere"}
    repair = fake.of("worker")[-1]["messages"][-1]["content"]
    assert repair.startswith("Reviewer verdict") and "cite one of: call_b, call_c" in repair
    assert results[1]["passed"] and results[1]["claimStatuses"] == {"c2": "verified"}


def test_fixture_repointed_claims_land_on_a_result_that_holds_the_quote():
    run = fixture_run.load()
    for agent, cid in (("1.2", "c2"), ("1.3", "c4"), ("1.3", "c6"), ("1.4", "c7"), ("1.3", "c16")):
        recs = run["records"][agent]
        _, claims, _ = s.parse_claims(fixture_run.final_answer(recs, 0))
        c = next(c for c in claims if c["id"] == cid)
        st = fixture_run.store(recs, 0)
        cited = c["callId"]
        assert s.verify_claim(c, st).endswith("repointed") and c["callId"] != cited and c["repointedFrom"] == cited


assert TOOLS  # the fake harness offers fs__read_file
