"""Spec A Phase 2: cite-by-snippet-ID. Tool results are split into labelled snippets; claims cite snippet ids and the
sidecar fills callId and quote. The legacy callId+quote format still works behind config.claimFormat."""
import json

import multi_agent_sidecar as s
from test_reflection_evidence import events, run_one_step

BRAVE = ("[1] Flights From Istanbul to Nevsehir | Turkish Airlines\nhttps://www.turkishairlines.com/x\n"
         "Skip to content. Direct flights between the two cities take about an hour and 20 minutes. Book today!\n\n"
         "[2] Nevsehir airport guide\nhttps://example.com/nav\nThe airport is 40 km from Goreme. Shuttles cost 10 EUR per person.")
CALL = {"tool_calls": [{"id": "call_t", "type": "function", "function": {"name": "fs__read_file", "arguments": '{"path": "/x"}'}}]}
PROSE = "Direct flights from Istanbul to Nevsehir take about 1 h 20 min [c1], and the airport is 40 km from Goreme [c2]."


def answer(*claims):
    return {"content": PROSE + "\n\n```claims\n" + json.dumps(list(claims)) + "\n```"}


def route(worker_answers):
    it = iter(worker_answers)

    def r(role, body):
        if role == "judge":
            return {"content": '{"score": 5, "reason": "ok", "issues": []}'}
        if role == "worker":
            return next(it) if any(m["role"] == "tool" for m in body["messages"]) else CALL
        return {"content": "done [1.1]"}
    return r


def test_split_snippets():
    assert s.split_snippets(BRAVE, 3) == {
        "S3.1": "Flights From Istanbul to Nevsehir | Turkish Airlines\nhttps://www.turkishairlines.com/x\n"
                "Skip to content. Direct flights between the two cities take about an hour and 20 minutes. Book today!",
        "S3.2": "Nevsehir airport guide\nhttps://example.com/nav\nThe airport is 40 km from Goreme. Shuttles cost 10 EUR per person."}
    assert s.split_snippets("AAPL: 231.4 USD", 1) == {"S1.1": "AAPL: 231.4 USD"}


def test_best_quote_is_the_sentence_with_most_claim_words():
    store = {"call_t": {"ok": True, "result": BRAVE, "snippets": s.split_snippets(BRAVE, 1)}}
    c = {"id": "c1", "claim": "Direct flights take about an hour and 20 minutes", "snippets": ["S1.1"]}
    assert s.verify_claim(c, store) == "verified"
    assert c["callId"] == "call_t" and c["quote"] == "Direct flights between the two cities take about an hour and 20 minutes."
    long = "word " * 200
    store2 = {"call_l": {"ok": True, "result": long, "snippets": {"S2.1": long}}}
    c2 = {"id": "c2", "claim": "word", "snippets": ["S2.1"]}
    assert s.verify_claim(c2, store2) == "verified" and len(c2["quote"]) <= s.QUOTE_MAX_CHARS


def test_unknown_snippet_and_no_citation():
    store = {"call_t": {"ok": True, "result": BRAVE, "snippets": s.split_snippets(BRAVE, 1)}}
    c = {"id": "c1", "claim": "x", "snippets": ["S1.1", "S9.9"]}
    assert s.verify_claim(c, store) == "snippet_not_found" and s.failure_class(c, "snippet_not_found") == "wrong_call"
    assert s.claim_problems([c], {"c1": "snippet_not_found"}) == [
        "Claim c1 (snippets S1.1, S9.9): snippet S9.9 does not exist; cite only ids shown as [S…] in your tool results."]
    _, claims, errors = s.parse_claims('ok\n```claims\n[{"id": "c3", "claim": "Goreme is 40 km away"}, {"id": "c4", "claim": "y", "snippets": []}]\n```')
    assert errors == [] and [s.verify_claim(c, store) for c in claims] == ["no_citation", "no_citation"]
    assert s.failure_class(claims[0], "no_citation") == "no_citation"


def test_snippet_run_verifies_with_no_formatting_failure():
    run, fake = run_one_step(route([answer({"id": "c1", "claim": "Direct flights take about an hour and 20 minutes", "snippets": ["S1.1"]},
                                           {"id": "c2", "claim": "The airport is 40 km from Goreme", "snippets": ["S1.2"]})]),
                             tool_result=lambda n: BRAVE)
    [result] = events(run, "reflection_result")
    assert result["passed"] and result["claimStatuses"] == {"c1": "verified", "c2": "verified"} and result["claimsFailed"] == 0
    assert not events(run, "retry")
    tool_msg = next(m for m in fake.of("worker")[-1]["messages"] if m["role"] == "tool")
    assert tool_msg["content"] == ("[callId: call_t]\n[S1.1] Flights From Istanbul to Nevsehir | Turkish Airlines\nhttps://www.turkishairlines.com/x\n"
                                   "Skip to content. Direct flights between the two cities take about an hour and 20 minutes. Book today!\n\n"
                                   "[S1.2] Nevsehir airport guide\nhttps://example.com/nav\nThe airport is 40 km from Goreme. Shuttles cost 10 EUR per person.")
    assert s.SNIPPET_CLAIMS_CONTRACT in fake.of("worker")[0]["messages"][0]["content"]
    judge = fake.of("judge")[0]["messages"][1]["content"]
    assert '- c2 | The airport is 40 km from Goreme | verified | quote: "The airport is 40 km from Goreme." | callId: call_t' in judge
    assert run.evidence["1.1"]["call_t"]["snippets"]["S1.2"].startswith("Nevsehir airport guide")


def test_bad_snippet_id_triggers_a_repair_naming_it():
    bad = answer({"id": "c1", "claim": "Direct flights take 1 h 20", "snippets": ["S4.7"]})
    good = answer({"id": "c1", "claim": "Direct flights take 1 h 20", "snippets": ["S1.1"]})
    run, fake = run_one_step(route([bad, good]), tool_result=lambda n: BRAVE)
    first, second = events(run, "reflection_result")
    assert first["model"] == "claims check" and first["claimStatuses"] == {"c1": "snippet_not_found"}
    assert first["claimFailureClasses"] == {"c1": "wrong_call"}
    assert "snippet S4.7 does not exist" in fake.of("worker")[-1]["messages"][-1]["content"]
    assert second["passed"]


def test_snippet_mode_still_accepts_a_quote_with_a_call_id():
    run, _ = run_one_step(route([answer({"id": "c1", "claim": "1 h 20", "callId": "call_t", "quote": "take about an hour and 20 minutes"})]),
                          tool_result=lambda n: BRAVE)
    assert events(run, "reflection_result")[0]["claimStatuses"] == {"c1": "verified"}


def test_legacy_format_unchanged():
    run, fake = run_one_step(route([answer({"id": "c1", "claim": "1 h 20", "callId": "call_t", "quote": "take about an hour and 20 minutes"})]),
                             tool_result=lambda n: BRAVE, claimFormat="legacy")
    assert events(run, "reflection_result")[0]["passed"]
    worker = fake.of("worker")[-1]["messages"]
    assert next(m for m in worker if m["role"] == "tool")["content"] == "[callId: call_t]\n" + BRAVE
    assert worker[0]["content"].endswith(s.CLAIMS_CONTRACT + "\n\nCurrent date and time: x.")
    assert "snippets" not in worker[0]["content"]
