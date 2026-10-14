"""Spec B Phase 3: a step with a condition runs only if its dependencies' claims say the condition holds. One cheap
yes/no call per conditional step (none when the dependencies made no claims), and dependants unblock either way."""
import fake_harness as h

PLAN = {"steps": [{"id": "1.1", "label": "Leg 2 door-to-door time", "role": "Leg 2", "dependsOn": [], "covers": ["r1"]},
                  {"id": "2.1", "label": "Overnight bus fallback", "role": "Fallback", "dependsOn": [], "covers": ["r2"],
                   "condition": "only if leg 2 (1.1) takes more than 5 hours door to door"},
                  {"id": "3.1", "label": "Write the day plan", "role": "Planner", "dependsOn": ["2.1"]}],
        "checklist": [{"id": "r1", "text": "Leg 2 door-to-door time", "scope": "1.1"}, {"id": "r2", "text": "Fallback if over 5 h", "scope": "2.1"}]}
FACTS = {"1.1": [("Leg 2 door to door takes about 6 hours via IST", "r1", "verified")],
         "2.1": [("The overnight bus takes 12 hours", "r2", "verified")], "3.1": [("Day 5 is in Selcuk", None, "verified")]}


def go(answer, facts=FACTS, plan=PLAN, **config):
    asked = []

    def condition(_agent, body):
        asked.append(body)
        return {"content": answer}
    return (*h.run(plan, h.researcher(facts), extra_routes={"condition": condition}, maxWaves=1, **config), asked)


def workers(fake):
    return sorted({agent for agent, _ in fake.of("worker")})


def test_skipped_when_the_condition_is_false():
    run, fake, asked = go("no")
    assert len(asked) == 1 and workers(fake) == ["1.1", "3.1"]  # 2.1 never ran
    [skipped] = h.events(run, "agent_skipped")
    assert skipped == {**skipped, "agentId": "2.1", "reason": "condition not met: only if leg 2 (1.1) takes more than 5 hours door to door",
                       "condition": "only if leg 2 (1.1) takes more than 5 hours door to door", "basis": "condition"}
    # The dependant unblocks and is told why 2.1 has nothing; so is the synthesizer.
    task = next(body["messages"][1]["content"] for agent, body in fake.of("worker") if agent == "3.1")
    assert "[2.1 SKIPPED: condition not met" in task
    assert "[2.1 SKIPPED: condition not met" in fake.of("synthesis")[0][1]["messages"][1]["content"]
    assert h.events(run, "ledger_update")[-1]["ledger"]["r2"]["status"] == "missing"


def test_runs_when_the_condition_is_true():
    run, fake, asked = go("Yes.")
    assert workers(fake) == ["1.1", "2.1", "3.1"] and not h.events(run, "agent_skipped")
    order = [e["agentId"] for e in run.events if e["type"] == "agent_start"]
    assert order.index("2.1") > order.index("1.1") and order.index("3.1") > order.index("2.1")


def test_the_check_sees_the_dependency_claims_and_is_cheap():
    _, fake, asked = go("yes")
    [body] = asked
    assert body["model"] == "m/r"  # the assess model, which defaults to the judge model
    user = body["messages"][1]["content"]
    assert "Condition: only if leg 2 (1.1) takes more than 5 hours door to door" in user
    assert "1.1 c1 (verified): Leg 2 door to door takes about 6 hours via IST" in user


def test_no_claims_to_judge_by_skips_with_no_call():
    run, fake, asked = go("yes", facts={**FACTS, "1.1": []})
    assert not asked and workers(fake) == ["1.1", "3.1"]
    [skipped] = h.events(run, "agent_skipped")
    assert (skipped["reason"], skipped["basis"]) == ("no_basis: 1.1 made no claims to judge the condition by", "no_basis")


def test_unclear_answer_runs_the_step():
    run, fake, asked = go("It depends on the season.")
    assert "2.1" in workers(fake) and not h.events(run, "agent_skipped")
