"""Spec A Phase 10: the planner slices research on one axis (entities or topics, never both) and makes a step whose
premise is a condition on another step's answer depend on it. Replayed on the Istanbul run's own prompt and plan."""
import asyncio
import json

import fixture_run
import multi_agent_sidecar as s

FX = fixture_run.load()
RECORDED = [e["steps"] for e in FX["events"] if e["type"] == "orchestrator_plan"][0]
TASK = FX["meta"]["task"]


def plain(steps, **extra):
    """The recorded steps as the planner wrote them (id, label, role, dependsOn) plus optional per-step fields."""
    return [{"id": st["id"], "label": st["label"], "role": st["role"], "dependsOn": st["dependsOn"], **extra.get(st["id"], {})} for st in steps]


# What the recorded plan looks like with the axis each step really took: legs by entity, baggage and snow by topic.
MIXED = plain(RECORDED, **{i: {"axis": "entity"} for i in ("1.1", "1.2", "1.3")}, **{i: {"axis": "topic"} for i in ("1.4", "1.5")})
FIXED = [
    {"id": "1.1", "label": "Verify Dec 18 Istanbul to Cappadocia: flights, times, baggage, transfer to Goreme", "role": "Leg 1", "dependsOn": [], "axis": "entity"},
    {"id": "1.2", "label": "Verify Dec 22 Cappadocia to Izmir: flights, times, baggage, total door-to-door time", "role": "Leg 2", "dependsOn": [], "axis": "entity"},
    {"id": "1.3", "label": "Verify Dec 24 Izmir to Istanbul: morning flights, baggage, Selcuk to ADB transfer", "role": "Leg 3", "dependsOn": [], "axis": "entity"},
    {"id": "2.1", "label": "Snow risk at NAV/ASR and a fallback route to Selcuk", "role": "Fallback", "dependsOn": [], "axis": "entity",
     "condition": "only if leg 2 (1.2) takes more than 5 hours door to door"},
]


def test_prompt_rules():
    for rule in ("Slice research on one axis: by entity (e.g. each leg, city or company) or by topic (e.g. baggage, prices, risks), never both",
                 '"axis": "entity" or "topic"',
                 "If a step only matters depending on another step's answer",
                 '"condition"'):
        assert rule in s.PLANNER_SYSTEM, rule


def test_the_recorded_plan_has_both_problems():
    steps = s.parse_plan(json.dumps(MIXED), s.Config(**FX["meta"]["config"]))
    problems = s.slicing_problems(steps)
    assert problems == [
        "Steps 1.1, 1.2, 1.3 are sliced by entity and 1.4, 1.5 by topic. Slice research on one axis: fold each topic into the entity steps, or split only by topic.",
        "Step 1.5 is conditional (\"if Dec 22 Cappadocia-Selçuk exceeds 5 hours\") but depends on no step. Add the step whose answer decides it to dependsOn and state the condition in \"condition\".",
    ]


def test_a_condition_naming_a_step_adds_the_dependency():
    steps = s.parse_plan(json.dumps(FIXED), s.Config(**FX["meta"]["config"]))
    by = {st["id"]: st for st in steps}
    assert by["2.1"]["dependsOn"] == ["1.2"] and by["2.1"]["condition"] == FIXED[3]["condition"] and by["2.1"]["phase"] == 2
    assert s.slicing_problems(steps) == []


def plan_with(replies):
    it = iter(replies)
    seen = []

    def fake(_key, _model, messages, *_a, **_k):
        seen.append(json.loads(json.dumps(messages)))
        return {"role": "assistant", "content": json.dumps(next(it)), "finish_reason": "stop"}, {"total_tokens": 1, "cost": 0}
    s._stream_openrouter = fake
    cfg = s.Config(**{**FX["meta"]["config"], "maxAgents": 6})
    run = s.Run("slice", s.RunRequest(runId="slice", chatId="c", task=TASK, config=cfg, openRouterApiKey="k", currentDateTime="x"))
    run.executor = s.ThreadPoolExecutor(max_workers=1)
    state = asyncio.run(s.plan_node({"run": run}))
    return state["steps"], seen


def test_fixture_prompt_mixed_plan_is_corrected_once():
    steps, seen = plan_with([MIXED, FIXED])
    correction = seen[1][-1]["content"]
    assert correction.startswith(s.SLICING_CORRECTION) and "sliced by entity and 1.4, 1.5 by topic" in correction and "Step 1.5 is conditional" in correction
    by = {st["id"]: st for st in steps}
    # No topic is sliced both ways: every research step is on the entity axis, baggage folded into the legs.
    assert {st["axis"] for st in steps} == {"entity"} and not any("baggage allowances for" in st["label"] for st in steps)
    # The "if leg 2 exceeds 5 h" step waits for the leg-2 step.
    assert by["2.1"]["dependsOn"] == ["1.2"]


def test_one_correction_only_then_the_answer_is_kept():
    steps, seen = plan_with([MIXED, MIXED])
    assert len(seen) == 2 and [st["id"] for st in steps] == ["1.1", "1.2", "1.3", "1.4", "1.5"]  # 2.1 (merge) is dropped by Phase 4
    assert plan_with([FIXED])[1].__len__() == 1  # a clean plan is not questioned
