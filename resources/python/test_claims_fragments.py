"""Spec A Phase 1: ellipsis-stitched quotes verify fragment by fragment, and every failing claim carries a failure class.
Also the fixture replay of the Istanbul run's 24 failing attempt-0 claims."""
import fixture_run
import multi_agent_sidecar as s

RESULT = ("Flights from Istanbul to Cappadocia: TK2000 06:25 07:45 Istanbul IST Cappadocia NAV. "
          "Pegasus also flies daily. Via Istanbul IST 1 stop with Turkish Airlines. 12-15 flights per day. Duration 3h 45m total.")
STORE = {"call_a": {"name": "brave", "args": "{}", "ok": True, "attempt": 0, "result": RESULT}}


def claim(quote, call_id="call_a"):
    return {"id": "c1", "claim": "x", "callId": call_id, "quote": quote}


def test_fragments_in_order_verify():
    c = claim("TK2000 06:25 07:45 Istanbul IST ... Turkish Airlines. 12-15 flights per day…3h 45m")
    assert s.verify_claim(c, STORE) == "verified_fragments"
    assert s.failure_class(c, "verified_fragments") is None


def test_a_short_fragment_is_fine_when_the_whole_quote_is_long_enough():
    # Decision (Phase 1): the 12-char minimum applies to the whole quote, not to each fragment.
    assert s.verify_claim(claim("Turkish Airlines. 12-15 flights per day ... 3h 45m"), STORE) == "verified_fragments"


def test_fragments_out_of_order_or_missing_fail_as_ellipsis_fragment_missing():
    for quote in ("3h 45m total ... TK2000 06:25 07:45", "TK2000 06:25 07:45 ... 9h 99m nowhere"):
        c = claim(quote)
        assert s.verify_claim(c, STORE) == "quote_not_found"
        assert s.failure_class(c, "quote_not_found") == "ellipsis_fragment_missing"


def test_length_limits_apply_to_the_sum_of_fragments():
    assert s.verify_claim(claim("TK2000 ... 3h 45"), STORE) == "quote_too_short"  # 6 + 5 = 11 normalised chars
    assert s.verify_claim(claim("TK2000 ... 3h 45m"), STORE) == "verified_fragments"  # 6 + 6 = 12: the minimum
    assert s.verify_claim(claim("TK ... 3h"), STORE) == "quote_too_short"
    long = " ... ".join(["Pegasus also flies daily."] * 20)  # 25 × 20 = 500 > 400
    assert s.verify_claim(claim(long), STORE) == "quote_too_long"
    assert s.failure_class(claim(long), "quote_too_long") == "too_long"
    assert s.failure_class(claim("TK ... 3h"), "quote_too_short") == "too_short"


def test_leading_and_trailing_ellipses_are_not_fragments():
    assert s.verify_claim(claim("... Pegasus also flies daily ..."), STORE) == "verified"


def test_plain_quotes_unchanged():
    assert s.verify_claim(claim("Pegasus also flies daily."), STORE) == "verified"
    c = claim("Pegasus flies hourly to Mars.")
    assert s.verify_claim(c, STORE) == "quote_not_found" and s.failure_class(c, "quote_not_found") == "mismatch"


def test_normalise_quote_semantics_unchanged():
    # Hard rule: formatting only. These pin the pre-Phase-1 behaviour.
    assert s.normalise_quote("  “$392.4&nbsp;million” — **record** <b>Q2</b>  1,234 ") == '"$392.4 million" - record q2 1234'
    assert s.normalise_quote("a...b") == "a...b"  # ellipses are split by verify_claim, not normalised away


# The Istanbul run (spec §0): the 24 claims that failed attempt 0, by agent and claim id.
EXPECTED = {
    **{("1.1", c): "verified_fragments" for c in ("c7", "c8", "c12", "c13", "c14", "c16")},
    **{("1.2", c): "verified_fragments" for c in ("c4", "c6", "c7", "c8", "c13")},
    ("1.3", "c8"): "verified_fragments",
    ("1.2", "c2"): "verified_repointed", ("1.3", "c4"): "verified_repointed", ("1.3", "c6"): "verified_repointed",
    ("1.4", "c7"): "verified_repointed",
    ("1.3", "c16"): "verified_fragments_repointed",
    ("1.2", "c11"): "ellipsis_fragment_missing", ("1.3", "c18"): "ellipsis_fragment_missing",
    **{k: "mismatch" for k in (("1.2", "c16"), ("1.4", "c16"), ("1.4", "c17"), ("1.4", "c18"), ("1.5", "c15"))},
}


def replay_attempt0():
    """(agent, claim id) → (old status recorded in the run, new status, failure class)."""
    run = fixture_run.load()
    out = {}
    for agent in fixture_run.worker_agents(run):
        recs = run["records"][agent]
        old = next(e for e in run["events"] if e["type"] == "reflection_result" and e["agentId"] == agent and e["attempt"] == 0)["claimStatuses"]
        _, claims, _ = s.parse_claims(fixture_run.final_answer(recs, 0))
        store = fixture_run.store(recs, 0)
        for c in claims:
            new = s.verify_claim(c, store)
            out[(agent, c["id"])] = (old[c["id"]], new, s.failure_class(c, new))
    return out


def test_fixture_replay_reclassifies_the_24_failing_claims():
    out = replay_attempt0()
    failing = {k: v for k, v in out.items() if v[0] not in s.CLAIM_OK}
    assert len(failing) == 24 and set(failing) == set(EXPECTED)
    got = {k: (new if new in s.CLAIM_OK else cls) for k, (_, new, cls) in failing.items()}
    assert got == EXPECTED
    counts = {}
    for v in got.values():
        counts[v] = counts.get(v, 0) + 1
    assert counts == {"verified_fragments": 12, "verified_repointed": 4, "verified_fragments_repointed": 1,
                      "ellipsis_fragment_missing": 2, "mismatch": 5}


def test_fixture_replay_keeps_every_claim_that_already_verified():
    for key, (old, new, _) in replay_attempt0().items():
        if old in s.CLAIM_OK:
            assert new == old, (key, old, new)
