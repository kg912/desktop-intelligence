"""Spec A Phase 4: no final merge step — the synthesizer merges. The planner is told so, and plan_node drops a final
merge/combine/consolidate/synthesis step that every other step feeds into, logging plan_step_removed."""
import asyncio
import json

import fixture_run
import multi_agent_sidecar as s


def step(sid, label, deps=()):
    return {"id": sid, "label": label, "role": "R", "dependsOn": list(deps)}


def test_istanbul_plan_loses_its_merge_step():
    [plan] = [e["steps"] for e in fixture_run.load()["events"] if e["type"] == "orchestrator_plan"]
    kept, removed = s.drop_final_merge(plan)
    assert [st["id"] for st in kept] == ["1.1", "1.2", "1.3", "1.4", "1.5"] and [st["id"] for st in removed] == ["2.1"]


def test_a_final_synthesis_that_depends_on_everything_transitively_is_dropped():
    plan = [step("1.1", "Screen universe"), step("2.1", "Moats", ["1.1"]), step("2.2", "Financials", ["1.1"]),
            step("3.1", "Cross-reference findings, resolve conflicts, and synthesize final recommendations", ["2.1", "2.2"])]
    kept, removed = s.drop_final_merge(plan)
    assert [st["id"] for st in removed] == ["3.1"] and [st["id"] for st in kept] == ["1.1", "2.1", "2.2"]


def test_a_last_step_that_does_new_research_is_kept():
    plan = [step("1.1", "Flights leg 1"), step("1.2", "Flights leg 2"),
            step("2.1", "Find rail options from Selcuk to the airport for the flights found", ["1.1", "1.2"])]
    assert s.drop_final_merge(plan) == (plan, [])


def test_merge_words_without_depending_on_everything_are_kept():
    plan = [step("1.1", "Leg 1"), step("1.2", "Leg 2"), step("1.3", "Baggage"), step("2.1", "Combine leg 1 and 2 timetables", ["1.1", "1.2"])]
    assert s.drop_final_merge(plan) == (plan, [])
    single = [step("1.1", "Summarise and consolidate the report")]
    assert s.drop_final_merge(single) == (single, [])


def test_plan_node_removes_it_and_says_so():
    plan = json.dumps([step("1.1", "Research A"), step("1.2", "Research B"), step("2.1", "Merge all findings", ["1.1", "1.2"])])
    s._stream_openrouter = lambda *a, **k: ({"role": "assistant", "content": plan, "finish_reason": "stop"}, {"total_tokens": 1, "cost": 0})
    cfg = s.Config(maxAgents=4, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    run = s.Run("p", s.RunRequest(runId="p", chatId="c", task="t", config=cfg, openRouterApiKey="k", currentDateTime="x"))
    run.executor = s.ThreadPoolExecutor(max_workers=1)
    state = asyncio.run(s.plan_node({"run": run}))
    assert [st["id"] for st in state["steps"]] == ["1.1", "1.2"]
    types = [e["type"] for e in run.events]
    removed = next(e for e in run.events if e["type"] == "plan_step_removed")
    assert types.index("plan_step_removed") < types.index("orchestrator_plan")
    assert (removed["stepId"], removed["label"]) == ("2.1", "Merge all findings")
    assert removed["reason"] == "a final merge step: the synthesizer merges every step's output"


def test_prompts_give_merging_to_the_synthesizer():
    assert "Do not add a final step that merges, combines, consolidates or summarises the others" in s.PLANNER_SYSTEM
    assert "add one merge step" not in s.PLANNER_SYSTEM and "final assembly step" not in s.PLANNER_SYSTEM
    assert '"dependsOn": ["1.2"]' in s.PLANNER_SYSTEM  # the example of a follow-up research step
    assert "synthesize" not in s.PLANNER_SYSTEM  # role detection (tests, logs) keys on "synthesize" for the synthesis call
    assert "Merging is your job" in s.SYNTHESIS_SYSTEM and "apply any exclusions or criteria the task states" in s.SYNTHESIS_SYSTEM
