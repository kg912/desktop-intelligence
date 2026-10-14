"""Spec B Phase 2: the assess node between workers and synthesis, and its stop rules (enforced in code, not by the model).
The fake harness runs the real orchestrate(); the assess model's reply is scripted per test."""
import json
import statistics

import fake_harness as h
import fixture_run
import multi_agent_sidecar as s
from test_ledger import fixture_ledger

PLAN = {"steps": [{"id": "1.1", "label": "Leg 2 schedule", "role": "Leg 2", "dependsOn": [], "covers": ["r1", "r2"]},
                  {"id": "1.2", "label": "Leg 2 from airline pages", "role": "Airline pages", "dependsOn": [], "covers": ["r1"]}],
        "checklist": [{"id": "r1", "text": "Days of operation, leg 2", "scope": "1.1"}, {"id": "r2", "text": "Exact times on Dec 22", "scope": "1.1"}]}
CONFLICT = {"1.1": [("Direct ASR-ADB flights run every day", "r1", "verified"), ("Exact Dec 22 times", "r2", "unverified")],
            "1.2": [("Direct ASR-ADB flights run Mon, Tue, Thu", "r1", "verified")]}
SETTLED = {**CONFLICT, "2.1": [("Direct ASR-ADB flights run Mon, Wed, Fri per the airline page", "r1", "verified")]}
SETTLE = {"title": "Settle ASR-ADB days", "task": "Check the airline schedule pages for ASR-ADB days in December.", "covers": ["r1"], "tools": ["web__search"]}
TIMES = {"title": "Exact Dec 22 times", "task": "Open the airline timetable widget for Dec 22.", "covers": ["r2"], "tools": ["web__fetch"]}


def assessor(*replies):
    """The assess model: each call returns the next reply (the last one repeats)."""
    calls = []

    def route(_agent, body):
        calls.append(body)
        return {"content": json.dumps(replies[min(len(calls), len(replies)) - 1])}
    return route, calls


def follow_up(*steps, **extra):
    return {"decision": "follow_up", "reason": "One conflict can be settled.", "steps": list(steps), "unclosable": [], **extra}


def go(facts, *replies, plan=PLAN, approve=None, **config):
    route, calls = assessor(*replies)
    run, fake = h.run(plan, h.researcher(facts), extra_routes={"assess": route}, approve=approve, **config)
    return run, fake, calls


def decisions(run):
    return [(e["decision"], e.get("forced")) for e in h.events(run, "assess_decision")]


def test_all_verified_is_done_with_no_model_call():
    run, fake, calls = go({"1.1": [("Direct ASR-ADB flights run every day", "r1", "verified"), ("TK2313 leaves 10:40", "r2", "verified")]},
                          follow_up(SETTLE))
    assert not calls and [r for r, _, _ in fake.calls].count("assess") == 0
    [start] = h.events(run, "assess_start")
    assert start["wave"] == 1
    [decision] = h.events(run, "assess_decision")
    assert (decision["decision"], decision["costUsd"], decision["steps"], decision["unclosable"]) == ("done", 0, [], [])
    assert decision["rules"]["checklist"] == {"open": 0, "total": 2}
    assert h.events(run, "task_complete")


def test_conflict_with_a_capable_tool_runs_one_wave_then_done():
    run, fake, calls = go(SETTLED, follow_up(SETTLE, confirmed=["r1"]))
    assert len(calls) == 1  # wave 2 ends at the wave cap (maxWaves 2) with no second assess call
    assert decisions(run) == [("follow_up", None), ("done", "wave_cap")]
    first = h.events(run, "assess_decision")[0]
    assert first["autoRun"] is True and first["estimatedUsd"] <= s.Config.model_fields["followUpAutoUsd"].default == 0.15
    [wave] = h.events(run, "wave_start")
    assert wave["n"] == 2 and [st["id"] for st in wave["steps"]] == ["2.1"]
    step = wave["steps"][0]
    assert (step["label"], step["covers"], step["dependsOn"], step["wave"]) == ("Settle ASR-ADB days", ["r1"], ["1.1", "1.2"], 2)
    # The follow-up worker gets the task and its dependencies' outputs; its claim settles r1 (latest wave wins).
    task = next(body["messages"][1]["content"] for agent, body in fake.of("worker") if agent == "2.1")
    assert "Check the airline schedule pages" in task and "[1.1]" in task and "[1.2]" in task
    ledger = h.events(run, "ledger_update")
    assert ledger[-1]["ledger"]["r1"] == {"status": "verified", "claimIds": ["2.1 c1"]}
    # The assess model confirmed the conflict before the wave: no longer "possible".
    assert any(e["ledger"]["r1"].get("conflict") == {"claimIds": ["1.1 c1", "1.2 c1"], "confirmed": True} for e in ledger)
    # r2 stayed open: a mandatory caveat for the synthesizer.
    synthesis = fake.of("synthesis")[0][1]["messages"][1]["content"]
    assert "Open requirements" in synthesis and "r2" in synthesis and "Exact times on Dec 22" in synthesis


def test_gap_no_tool_can_close_is_unclosable_and_costs_nothing():
    facts = {"1.1": [("Direct ASR-ADB flights run every day", "r1", "verified"), ("Exact Dec 22 times", "r2", "unverified")]}
    run, fake, calls = go(facts, follow_up(TIMES))
    [decision] = h.events(run, "assess_decision")
    assert (decision["decision"], decision["forced"], decision["steps"]) == ("done", "no_capable_tool", [])
    assert decision["unclosable"] == [{"checklistId": "r2", "reason": "no available tool can close this gap (needs web__fetch)"}]
    assert decision["rules"]["tools"] == "none"
    assert not h.events(run, "wave_start") and [r for r, _, _ in fake.calls].count("worker") == 4  # 2 steps × (search, answer); no follow-up
    synthesis = fake.of("synthesis")[0][1]["messages"][1]["content"]
    assert "r2 (Exact times on Dec 22): no available tool can close this gap (needs web__fetch)" in synthesis


def test_the_model_cannot_overrule_the_wave_cap():
    run, fake, calls = go(CONFLICT, follow_up(SETTLE), maxWaves=1)
    assert not calls  # maxWaves 1: the first round only, no assess spend
    assert decisions(run) == [("done", "wave_cap")] and not h.events(run, "wave_start")
    assert h.events(run, "assess_decision")[0]["rules"]["waves"] == {"used": 1, "max": 1}


def test_no_progress_stops_even_with_waves_left():
    unsettled = {**CONFLICT, "2.1": [("ASR-ADB days could not be confirmed", "r1", "unverified")]}
    run, fake, calls = go(unsettled, follow_up(SETTLE), maxWaves=3)
    assert len(calls) == 1 and len(h.events(run, "wave_start")) == 1
    assert decisions(run) == [("follow_up", None), ("done", "no_progress")]
    assert h.events(run, "assess_decision")[1]["rules"]["progress"] == "none"


def test_max_waves_two_allows_exactly_one_follow_up_wave():
    run, _, calls = go(SETTLED, follow_up(SETTLE), follow_up({**SETTLE, "title": "Again"}), maxWaves=2)
    assert len(h.events(run, "wave_start")) == 1 and len(calls) == 1


def test_budget_left_below_the_estimate_forces_done():
    cost = {"planner": 0, "judge": 0, "assess": 0, "synthesis": 0, "worker": 0.01}
    route, calls = assessor(follow_up(SETTLE))
    run, fake = h.run(PLAN, h.researcher(CONFLICT), extra_routes={"assess": route}, cost=cost, budgetCapUsd=0.05)
    [decision] = h.events(run, "assess_decision")
    # Spent 0.04 (2 steps × 2 worker calls × 0.01); one more step is estimated at the mean step cost, 0.02 > 0.01 left.
    assert (decision["decision"], decision["forced"], decision["estimatedUsd"]) == ("done", "budget", 0.02)
    assert decision["rules"]["budget"] == {"spentUsd": 0.04, "capUsd": 0.05} and not h.events(run, "wave_start")


def approvals(answers):
    """Approves the plan; answers the assess pauses in order (an exception = the timeout)."""
    seen, it = [], iter(answers)

    async def approve(agent_id, role, model, tool, server, args):
        if agent_id == "orchestrator":
            return True, ""
        if agent_id == "assess":
            seen.append((tool, server, args))
            answer = next(it)
            if isinstance(answer, Exception):
                raise answer
            return answer
        return True, "Search result text about the subject."
    return approve, seen


def test_ask_user_timeout_proceeds_as_done():
    approve, seen = approvals([s.AgentFailed("approval for multi-agent:ask_user timed out after 60s")])
    run, fake, _ = go(CONFLICT, {"decision": "ask_user", "question": "Do you prefer Kayseri or Nevsehir?", "steps": [], "unclosable": []}, approve=approve)
    assert seen == [("ask_user", "multi-agent", {"question": "Do you prefer Kayseri or Nevsehir?"})]
    assert decisions(run) == [("ask_user", None), ("done", "ask_user_timeout")]
    assert h.events(run, "task_complete")


def test_ask_user_answer_reaches_the_synthesizer():
    approve, _ = approvals([(True, "Kayseri, please")])
    run, fake, _ = go(CONFLICT, {"decision": "ask_user", "question": "Kayseri or Nevsehir?", "steps": [], "unclosable": []}, approve=approve)
    assert "The user answered the question \"Kayseri or Nevsehir?\": Kayseri, please" in fake.of("synthesis")[0][1]["messages"][1]["content"]


def test_follow_up_auto_usd_zero_always_asks():
    approve, seen = approvals([(True, "")])
    run, _, _ = go(SETTLED, follow_up(SETTLE), approve=approve, followUpAutoUsd=0)
    assert [t for t, _, _ in seen] == ["approve_followup"] and seen[0][2]["steps"][0]["id"] == "2.1"
    assert h.events(run, "assess_decision")[0]["autoRun"] is False and len(h.events(run, "wave_start")) == 1
    approve, _ = approvals([(False, "")])  # Finish now
    run, _, _ = go(SETTLED, follow_up(SETTLE), approve=approve, followUpAutoUsd=0)
    assert decisions(run) == [("follow_up", None), ("done", "finished_by_user")] and not h.events(run, "wave_start")


def test_default_follow_up_auto_usd_runs_a_cheap_wave_without_asking():
    approve, seen = approvals([])
    run, _, _ = go(SETTLED, follow_up(SETTLE), approve=approve)
    assert not seen and len(h.events(run, "wave_start")) == 1


def test_assess_request_is_small_and_cheap():
    run, fake, calls = go(SETTLED, follow_up(SETTLE))
    [body] = calls
    assert body["model"] == "m/r"  # models.assess defaults to the judge model
    assert s.estimate_tokens(json.dumps(body["messages"])) <= 4_000
    assert s.ROLE_MAX_TOKENS["assess"] == 800 and s.ROLE_REASONING["assess"] == "low"
    user = body["messages"][1]["content"]
    assert "r1 · possible conflict · Days of operation, leg 2" in user and "1.1 c1: Direct ASR-ADB flights run every day" in user
    assert "web__search" in user and "Waves: 1 of 2 used" in user
    run, _, calls = go(SETTLED, follow_up(SETTLE), models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s", "assess": "m/a"})
    assert calls[0]["model"] == "m/a"


def test_no_checklist_no_assess():
    run, fake, calls = go(CONFLICT, follow_up(SETTLE), plan=PLAN["steps"])
    assert not calls and not h.events(run, "assess_start") and not h.events(run, "assess_decision") and h.events(run, "task_complete")


def test_istanbul_fixture_flags_the_leg2_conflict_and_the_exact_date_gap():
    """On the recorded run's ledger and tools: the assess input names the leg-2 days conflict and the exact-date gap; a
    reply proposing a search for the first and a timetable fetch for the second keeps the search and reports the fetch
    gap as unclosable, with no spend on it."""
    fx = fixture_run.load()
    tools = [{"name": n, "description": ""} for n in [e for e in fx["events"] if e["type"] == "run_config"][0]["tools"]]
    cfg = s.Config(**fx["meta"]["config"])
    run = s.Run("fx", s.RunRequest(runId="fx", chatId="c", task=fx["meta"]["task"], config=cfg, tools=tools, openRouterApiKey="k", currentDateTime="x"))
    run.checklist = json.loads((fixture_run.RUNS / "istanbul-3leg" / "checklist.json").read_text())["checklist"]
    run.ledger, run.step_results = fixture_ledger(with_results=True)
    run.total_cost = 0.628392074
    messages = s.assess_messages(run)
    user = messages[1]["content"]
    assert "days-2 · possible conflict · Days of operation, leg 2" in user
    assert "1.2 c2: Google Flights lists direct ASR-ADB 6 days a week including Tuesday" in user and "1.5 c16: Direct ASR-ADB runs 6 days/week" in user
    for leg in ("times-1", "times-2", "times-3"):
        assert f"{leg} · unverified" in user
    assert "builtin__brave_web_search" in user and "Budget: 0.63 of 2.00 USD spent" in user
    assert s.estimate_tokens(json.dumps(messages)) <= 4_000
    reply = {"decision": "follow_up", "steps": [{"title": "Settle ASR-ADB days for Dec 22", "task": "Search the Pegasus and SunExpress schedules.",
                                                  "covers": ["days-2"], "tools": ["builtin__brave_web_search"]},
                                                 {"title": "Exact-date times", "task": "Read the airline timetable widgets for the three dates.",
                                                  "covers": ["times-1", "times-2", "times-3"], "tools": ["fetch"]}], "unclosable": []}
    steps, unclosable, coverage = s.plan_follow_up(run, reply, [dict(st, wave=1) for st in fixture_steps()])
    assert [(st["id"], st["covers"]) for st in steps] == [("2.1", ["days-2"])]
    assert [u["checklistId"] for u in unclosable] == ["times-1", "times-2", "times-3"] and coverage == "partly"


def fixture_steps():
    plan = [e for e in fixture_run.load()["events"] if e["type"] == "orchestrator_plan"][0]["steps"]
    labels = json.loads((fixture_run.RUNS / "istanbul-3leg" / "checklist.json").read_text())
    return [dict(st, covers=labels["covers"].get(st["id"], [])) for st in plan if st["id"] != "2.1"]


def test_istanbul_projection_against_baseline():
    """The Phase 2 report's numbers (fixture replay, no live run): one assess call plus one follow-up step for the leg-2
    conflict stays within +25% of Spec A's projected run cost. Prices: the judge model's two prices fitted to the six
    recorded judge calls (as in test_judge_excerpts); the assess input at the recorded tokens-per-char density."""
    from test_judge_excerpts import replay_judges
    fx = fixture_run.load()
    calls = replay_judges()
    sxx = sum(c[2] * c[2] for c in calls); sxy = sum(c[2] * c[3] for c in calls); syy = sum(c[3] * c[3] for c in calls)
    sxc = sum(c[2] * c[4] for c in calls); syc = sum(c[3] * c[4] for c in calls)
    det = sxx * syy - sxy * sxy
    p_in, p_out = (sxc * syy - syc * sxy) / det, (syc * sxx - sxc * sxy) / det
    recorded = {(e["agentId"], e["attempt"]): e["judgeInputChars"] for e in fx["events"] if e["type"] == "reflection_result" and e.get("judgeInputChars")}
    per_char = sum(c[2] for c in calls) / sum(recorded[(c[0], c[1])] for c in calls)
    judge_before = sum(c[4] for c in calls)
    judge_after = [p_in * per_char * sum(len(m["content"]) for m in c[5]) + p_out * s.JUDGE_MAX_TOKENS for c in calls]
    baseline = json.loads((fixture_run.RUNS / "istanbul-3leg" / "baseline.json").read_text())
    spec_a = baseline["costUsd"] - judge_before + sum(judge_after) - baseline["agents"]["2.1"]["costUsd"]  # excerpts judge, no merge step

    tools = [{"name": n, "description": ""} for n in [e for e in fx["events"] if e["type"] == "run_config"][0]["tools"]]
    run = s.Run("fx", s.RunRequest(runId="fx", chatId="c", task=fx["meta"]["task"], config=s.Config(**fx["meta"]["config"]), tools=tools,
                                   openRouterApiKey="k", currentDateTime="x"))
    run.checklist = LABELS_CHECKLIST()
    run.ledger, run.step_results = fixture_ledger(with_results=True)
    workers = ["1.1", "1.2", "1.3", "1.4", "1.5"]
    for a in workers:  # what run_worker records per step: the worker's own spend
        run.step_results[a]["costUsd"] = sum(r["usage"]["costUsd"] or 0 for r in fx["records"][a] if r["kind"] == "model" and r["role"] == "worker")
    assess_chars = sum(len(m["content"]) for m in s.assess_messages(run))
    assess_cost = p_in * per_char * assess_chars + p_out * s.ROLE_MAX_TOKENS["assess"]  # worst case: the whole 800-token cap
    estimate = s.step_cost_estimate(run)  # the in-code estimate that decides auto-run
    one_pass = statistics.mean(sum(r["usage"]["costUsd"] or 0 for r in fx["records"][a] if r["kind"] == "model" and r["role"] == "worker" and r["attempt"] == 0)
                               for a in workers) + sum(judge_after) / len(judge_after)
    after = spec_a + assess_cost + one_pass
    assert round(spec_a, 3) == 0.312 and round(assess_chars * per_char) == 2_129 and round(assess_cost, 4) == 0.0046
    assert round(estimate, 4) == 0.0534 and estimate <= run.config.followUpAutoUsd  # the leg-2 follow-up runs without asking
    assert round(one_pass, 4) == 0.0431 and round(after, 3) == 0.360 and after <= 1.25 * spec_a


def LABELS_CHECKLIST():
    return json.loads((fixture_run.RUNS / "istanbul-3leg" / "checklist.json").read_text())["checklist"]


def test_edited_follow_up_steps_from_the_approval():
    """Spec B 7b "Edit steps": the approval may send back the proposed steps with new titles/tasks, or fewer of them;
    nothing else (no new step, so no unchecked tool)."""
    two = follow_up(SETTLE, {**SETTLE, "title": "Second check", "task": "Another page."})

    async def approve(agent_id, role, model, tool, server, args):
        if agent_id == "orchestrator":
            return True, ""
        if agent_id == "assess":
            first = args["steps"][0]
            edited = [{**first, "label": "Settle it on the Pegasus page", "task": "Open the Pegasus timetable."},
                      {"id": "9.9", "label": "Sneaked in", "task": "x", "covers": ["r2"]}]
            return True, json.dumps(edited)
        return True, "Search result text about the subject."
    run, fake, _ = go(SETTLED, two, approve=approve, followUpAutoUsd=0)
    [wave] = h.events(run, "wave_start")
    assert [(st["id"], st["label"], st["task"]) for st in wave["steps"]] == [("2.1", "Settle it on the Pegasus page", "Open the Pegasus timetable.")]
    task = next(body["messages"][1]["content"] for agent, body in fake.of("worker") if agent == "2.1")
    assert "Open the Pegasus timetable." in task


def test_checklist_topic():
    text = json.dumps({"steps": [{"id": "1.1", "label": "Leg 1", "role": "R", "dependsOn": [], "covers": ["r1"]}],
                       "checklist": [{"id": "r1", "text": "Baggage allowance, leg 1", "scope": "1.1", "topic": "Baggage allowance"}, {"id": "r2", "text": "x"}]})
    steps = s.parse_plan(text, s.Config(maxAgents=2, budgetCapUsd=1, models={}, reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=1000))
    assert s.parse_checklist(text, steps) == [{"id": "r1", "text": "Baggage allowance, leg 1", "scope": "1.1", "topic": "Baggage allowance"},
                                              {"id": "r2", "text": "x", "scope": "global"}]
    assert '"topic"' in s.PLANNER_SYSTEM
