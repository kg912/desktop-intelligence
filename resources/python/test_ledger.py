"""Spec B Phase 1: the planner's acceptance checklist and the coverage ledger computed from claim statuses (no model call).
Replayed on the Istanbul run: its final claims, re-verified by the shipped verify_claim, with the checklist and claim
tags in tests/fixtures/runs/istanbul-3leg/checklist.json (the recorded planner predates the checklist)."""
import json

import fake_harness as h
import fixture_run
import multi_agent_sidecar as s

FX = fixture_run.load()
LABELS = json.loads((fixture_run.RUNS / "istanbul-3leg" / "checklist.json").read_text(encoding="utf-8"))


def fixture_ledger():
    plan = [e for e in FX["events"] if e["type"] == "orchestrator_plan"][0]["steps"]
    steps = [dict(st, covers=LABELS["covers"].get(st["id"], [])) for st in plan if st["id"] != "2.1"]  # 2.1 (merge) is dropped (spec A Phase 4)
    finished = {}
    for agent, attempt in LABELS["final_attempt"].items():
        recs = FX["records"][agent]
        _, claims, errors = s.parse_claims(fixture_run.final_answer(recs, attempt))
        assert not errors
        for claim in claims:
            if claim["id"] in LABELS["req"][agent]:
                claim["req"] = LABELS["req"][agent][claim["id"]]
        store = fixture_run.store(recs)
        finished[agent] = {"claims": claims, "statuses": {c["id"]: s.verify_claim(c, store) for c in claims}}
    return s.compute_ledger(LABELS["checklist"], steps, finished)


def test_fixture_ledger():
    ledger = fixture_ledger()
    assert len(ledger) == 18
    # Decision (spec B Phase 1): design 12's 11/4/2/1 is sample data drawn on the old run with its merge step 2.1; the
    # recorded claims give 12 verified, 3 unverified (the exact-date times of every leg), 3 possible conflicts, 0 missing.
    assert s.ledger_counts(ledger) == {"verified": 12, "unverified": 3, "conflicted": 3, "missing": 0, "pending": 0}
    assert {k for k, e in ledger.items() if e["status"] == "unverified"} == {"times-1", "times-2", "times-3"}
    conflicts = {k: e["conflict"]["claimIds"] for k, e in ledger.items() if e["status"] == "conflicted"}
    # Leg 2 days of operation (the conflict the task asked to settle) and AJet Premium 25 vs 30 kg are real;
    # TK economy cabin vs business cabin is the heuristic's false positive, which is why it is never "confirmed".
    assert conflicts == {"days-2": ["1.2 c2", "1.5 c16"], "bag-1": ["1.1 c11", "1.4 c8"], "bag-3": ["1.3 c12", "1.4 c2"]}
    assert not any(e["conflict"]["confirmed"] for e in ledger.values() if "conflict" in e)
    assert "1.5 c23" in ledger["risk-2"]["claimIds"] and "1.2 c24" in ledger["times-2"]["claimIds"]


def entry(cid, claim, req=None, **kind):
    return {"id": cid, "claim": claim, **({"req": req} if req else {}), **kind}


def test_statuses():
    checklist = [{"id": r, "text": r, "scope": "global"} for r in ("ok", "decl", "miss", "pend", "multi", "same", "failing")]
    steps = [{"id": "1.1", "covers": ["ok", "decl", "miss", "multi", "same", "failing"]}, {"id": "1.2", "covers": ["pend"]}, {"id": "1.3", "covers": ["miss"]}]
    finished = {
        "1.1": {"claims": [entry("c1", "IST-NAV is flown by Turkish Airlines", "ok"), entry("c2", "Exact times for Dec 18", "decl", unverified=True),
                           entry("c3", "Unmapped fact about the city"), entry("c4", "Pegasus cabin bag 8 kg", ["multi", "ok"]),
                           entry("c5", "ASR-ADB direct runs Mon, Wed", "same"), entry("c6", "ASR-ADB direct runs Tue, Thu", "same"),
                           entry("c7", "A quote that was not found", "failing")],
                "statuses": {"c1": "verified", "c2": "unverified_declared", "c3": "verified", "c4": "verified_repointed", "c5": "verified", "c6": "verified",
                             "c7": "quote_not_found"}},
        "1.3": {"claims": [], "statuses": {}},  # failed: no claims
    }
    ledger = s.compute_ledger(checklist, steps, finished)
    assert {k: e["status"] for k, e in ledger.items()} == {
        "ok": "verified", "decl": "unverified", "miss": "missing", "pend": "pending", "multi": "verified",
        "same": "verified",  # one agent disagreeing with itself is not a cross-agent conflict
        "failing": "missing",  # a failing claim fills nothing
    }
    assert ledger["ok"]["claimIds"] == ["1.1 c1", "1.1 c4"]  # a req list fills each requirement; the unmapped c3 fills none


def test_cross_agent_conflict_heuristic():
    assert s.possible_conflict("Direct ASR-ADB flights run every day", "Direct ASR-ADB flights run Mon, Tue, Thu")
    assert not s.possible_conflict("Direct ASR-ADB flights run Mon, Tue", "Direct ASR-ADB flights run Monday and Tuesday")
    assert not s.possible_conflict("SunExpress SunEco fare: 15 kg checked", "Pegasus Saver fare: 15 kg checked")  # "Sun…" is not Sunday
    assert s.possible_conflict("AJet Premium checked baggage 25 kg", "AJet Premium checked baggage 30 kg")
    assert not s.possible_conflict("ADB-Selcuk taxi about 42 min", "ADB-Selcuk taxi about 45 min")  # within 15%
    assert not s.possible_conflict("NAV to Goreme shuttle 40 min", "ASR to Goreme shuttle 75 min")  # different airports
    assert not s.possible_conflict("Turkish Airlines cabin bag 8 kg", "Turkish Airlines cabin bag 8 kg and a 4 kg personal item")  # detail added


def test_parse_checklist_and_covers():
    items = [{"id": f"r{i}", "text": f"req {i}", "scope": "1.1" if i == 1 else "nope"} for i in range(1, 30)] + [{"id": "r1", "text": "dup"}, {"text": ""}]
    text = "Plan:\n" + json.dumps({"steps": [{"id": "1.1", "label": "Leg 1", "role": "R", "dependsOn": [], "covers": ["r1", "r99", "r2"]}], "checklist": items})
    steps = s.parse_plan(text, s.Config(maxAgents=4, budgetCapUsd=1, models={}, reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=1000))
    checklist = s.parse_checklist(text, steps)
    assert len(checklist) == s.CHECKLIST_MAX == 25 and checklist[0] == {"id": "r1", "text": "req 1", "scope": "1.1"} and checklist[1]["scope"] == "global"
    assert steps[0]["covers"] == ["r1", "r2"]
    # The plan streams from the steps array of the object, even when the checklist comes first.
    assert [o["id"] for o in s.partial_plan_steps('{"checklist": [{"id": "r1", "text": "x"}], "steps": [{"id": "1.1", "label": "a"}, {"id": "1.2"')] == ["1.1"]
    assert s.parse_checklist(json.dumps([{"id": "1.1", "label": "x"}]), steps) == []  # an older bare array: no checklist


PLAN = {"steps": [{"id": "1.1", "label": "Leg 1 flights", "role": "Leg 1", "dependsOn": [], "covers": ["r1", "r2"]},
                  {"id": "1.2", "label": "Leg 2 flights", "role": "Leg 2", "dependsOn": [], "covers": ["r3"]}],
        "checklist": [{"id": "r1", "text": "Airlines, leg 1", "scope": "1.1"}, {"id": "r2", "text": "Times, leg 1", "scope": "1.1"},
                      {"id": "r3", "text": "Airlines, leg 2", "scope": "1.2"}]}
FACTS = {"1.1": [("Turkish Airlines flies IST-NAV", "r1", "verified"), ("Exact Dec 18 times", "r2", "unverified")],
         "1.2": [("Pegasus flies ASR-ADB", "r3", "verified")]}


def test_run_emits_ledger_with_no_model_call():
    run, fake = h.run(PLAN, h.researcher(FACTS))
    [plan] = h.events(run, "orchestrator_plan")
    assert plan["checklist"] == PLAN["checklist"] and [st["covers"] for st in plan["steps"]] == [["r1", "r2"], ["r3"]]
    worker_task = next(body["messages"][1]["content"] for agent, body in fake.of("worker") if agent == "1.1")
    assert "- r1: Airlines, leg 1\n- r2: Times, leg 1" in worker_task and '"req"' in worker_task
    updates = h.events(run, "ledger_update")
    assert len(updates) == 2  # one per step that ended
    assert updates[-1]["ledger"] == {"r1": {"status": "verified", "claimIds": ["1.1 c1"]}, "r2": {"status": "unverified", "claimIds": ["1.1 c2"]},
                                     "r3": {"status": "verified", "claimIds": ["1.2 c1"]}}
    assert updates[-1]["counts"] == {"verified": 2, "unverified": 1, "conflicted": 0, "missing": 0, "pending": 0}
    # The ledger costs nothing: planner + 2 workers × (search, answer) + 2 judges + synthesis, as without a checklist.
    assert [r for r, _, _ in fake.calls].count("worker") == 4 and len(fake.calls) == 1 + 4 + 2 + 1


def test_no_checklist_no_ledger():
    run, fake = h.run(PLAN["steps"], h.researcher(FACTS))  # an older planner: a bare array
    assert "checklist" not in h.events(run, "orchestrator_plan")[0] and not h.events(run, "ledger_update")
    assert "Requirements this step covers" not in json.dumps(fake.of("worker"))
