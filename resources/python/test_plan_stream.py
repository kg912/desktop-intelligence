"""UI Goal 5: the plan streams to the UI as it is written, and the fallback plan is never silent.
A fake OpenRouter streams the planner reply in small chunks; the real ask() and plan_node() run."""
import asyncio
import json

import multi_agent_sidecar as s

PLAN = [{"id": "1.1", "label": "Core route {Istanbul}", "role": "Route", "dependsOn": []},
        {"id": "1.2", "label": "Safety by region", "role": "Safety", "dependsOn": []},
        {"id": "2.1", "label": "Draft the itinerary", "role": "Planner", "dependsOn": ["1.1", "1.2"]}]


def chunks(text, size=7):
    return [text[i:i + size] for i in range(0, len(text), size)]


class FakePlanner:
    def __init__(self, reply=None, error=None, reasoning="", on_chunk=None):
        self.reply, self.error, self.reasoning, self.on_chunk, self.calls = reply, error, reasoning, on_chunk, 0

    def __call__(self, _key, model, messages, tools, _max_tokens, on_delta, cancelled, reasoning_effort=None, *_a, **_k):
        self.calls += 1
        assert reasoning_effort is None  # the planner never asks for reasoning
        if self.error:
            raise self.error
        if self.reasoning:
            on_delta("reasoning", self.reasoning)
        sent = []
        for part in chunks(self.reply):
            if self.on_chunk:
                self.on_chunk()
            if cancelled():
                break
            on_delta("content", part)
            sent.append(part)
        return {"role": "assistant", "content": "".join(sent), "finish_reason": "stop"}, {"prompt_tokens": 1, "completion_tokens": 1, "cost": 0}


def plan_only(fake):
    s._stream_openrouter = fake
    cfg = s.Config(maxAgents=4, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    run = s.Run("r", s.RunRequest(runId="r", chatId="c", task="Turkey in December", config=cfg, tools=[], openRouterApiKey="k",
                                  currentDateTime="Current date and time: x."))
    run.executor = s.ThreadPoolExecutor(max_workers=2)
    asyncio.run(s.plan_node({"run": run}))
    run.executor.shutdown()
    return run


def plan_of(run):
    return next(e for e in run.events if e["type"] == "orchestrator_plan")


def types(run):
    return [e["type"] for e in run.events]


# partial_plan_steps: only complete objects, braces inside strings ignored, nothing before the array.
text = json.dumps(PLAN)
assert s.partial_plan_steps("thinking { not a plan") == []
assert [o["id"] for o in s.partial_plan_steps(text[: text.index('"1.2"')])] == ["1.1"]
assert [o["id"] for o in s.partial_plan_steps(text)] == ["1.1", "1.2", "2.1"]
assert s.partial_plan_steps(text)[0]["label"] == "Core route {Istanbul}"
assert s.partial_plan_steps('[{"id":"a","label":"x \\" } y"}') == [{"id": "a", "label": 'x " } y'}]

# A streamed plan: started → reading → splitting → one subtask_added per step as it completes → assigning → wiring → plan.
run = plan_only(FakePlanner(reply="Here is the plan:\n" + json.dumps(PLAN), reasoning="Group by region."))
t = types(run)
assert t[:3] == ["plan_started", "plan_stage_changed", "plan_reasoning"], t
stages = [e["stage"] for e in run.events if e["type"] == "plan_stage_changed"]
assert stages == ["reading", "splitting", "assigning", "wiring"], stages
added = [e for e in run.events if e["type"] == "plan_subtask_added"]
assert [(e["index"], e["step"]) for e in added] == [
    (0, {"id": "1.1", "label": "Core route {Istanbul}", "role": "Route", "dependsOn": []}),
    (1, {"id": "1.2", "label": "Safety by region", "role": "Safety", "dependsOn": []}),
    (2, {"id": "2.1", "label": "Draft the itinerary", "role": "Planner", "dependsOn": ["1.1", "1.2"]}),
], added
assert t.index("plan_subtask_added") > t.index("plan_stage_changed") and t[-2:] == ["orchestrator_plan", "run_config"]
plan = plan_of(run)
assert "fallback" not in plan and [st["id"] for st in plan["steps"]] == ["1.1", "1.2", "2.1"]
assert next(e for e in run.events if e["type"] == "plan_reasoning")["token"] == "Group by region."

# A planner error is not a silent fallback: the plan says so and why.
run = plan_only(FakePlanner(error=RuntimeError("OpenRouter HTTP 502: upstream error")))
plan = plan_of(run)
assert plan["fallback"] is True
assert plan["fallbackReason"] == "The orchestrator failed: OpenRouter HTTP 502: upstream error", plan
assert [st["label"] for st in plan["steps"]] == ["Analyze the task", "Research supporting evidence", "Review risks and recommendations"]

# Four unusable replies: fallback with that reason.
run = plan_only(FakePlanner(reply="no plan here"))
assert plan_of(run)["fallbackReason"] == "The orchestrator did not return a usable plan after 4 attempts."

# Quick plan chosen mid-stream: the request stops at the next chunk and the fallback says the user chose it.
holder = {}
fake = FakePlanner(reply=json.dumps(PLAN), on_chunk=lambda: setattr(holder["run"], "quick_plan", True) if len(holder["run"].events) > 3 else None)
orig = s.Run.__init__
def capture_init(self, *a, **k):
    orig(self, *a, **k)
    holder["run"] = self
s.Run.__init__ = capture_init
try:
    run = plan_only(fake)
finally:
    s.Run.__init__ = orig
assert fake.calls == 1
assert plan_of(run)["fallback"] is True and plan_of(run)["fallbackReason"] == "You chose the quick 3-step plan.", plan_of(run)

# Budget and abort still end the run (not a fallback).
for exc in (s.BudgetReached(),):
    try:
        plan_only(FakePlanner(error=exc))
    except s.BudgetReached:
        pass
    else:
        raise AssertionError("BudgetReached must propagate")

print("ok")
