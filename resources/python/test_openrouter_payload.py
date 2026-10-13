"""Spec A Phase 8: OpenRouter request parameters per role, prompt caching, and cache fields in call records.
The real ask() → _stream_openrouter() run against a fake urlopen, so the exact bytes sent are checked."""
import asyncio
import importlib.util
import io
import json
import sys
from pathlib import Path

# An isolated copy of the sidecar: other test files replace multi_agent_sidecar._stream_openrouter in this process.
_spec = importlib.util.spec_from_file_location("sidecar_payload_copy", Path(__file__).parent / "multi_agent_sidecar.py")
s = importlib.util.module_from_spec(_spec)
sys.modules["sidecar_payload_copy"] = s
_spec.loader.exec_module(s)

SENT: list[dict] = []
GENERATION_LOOKUPS: list[str] = []


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def fake_urlopen(usage):
    def opener(request, timeout=None):
        if request.get_method() == "GET":  # the generation endpoint (cache backfill)
            GENERATION_LOOKUPS.append(request.full_url)
            return FakeResponse(json.dumps({"data": {"native_tokens_cached": 900, "cache_discount": 0.0012}}).encode())
        SENT.append(json.loads(request.data))
        lines = [{"id": "gen-1", "model": "m", "choices": [{"delta": {"content": '{"score": 5}'}, "finish_reason": "stop"}]},
                 {"id": "gen-1", "model": "m", "choices": [], "usage": usage}]
        return FakeResponse("".join(f"data: {json.dumps(x)}\n\n" for x in lines).encode() + b"data: [DONE]\n\n")
    return opener


def make_run(observe=False, **config):
    cfg = s.Config(maxAgents=2, budgetCapUsd=5, models={"orchestrator": "m/plan", "worker": "m/work", "reflection": "m/judge", "synthesizer": "m/synth"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000, **config)
    run = s.Run("run-7", s.RunRequest(runId="run-7", chatId="c", task="t", config=cfg, openRouterApiKey="k", currentDateTime="x", observe=observe))
    run.executor = s.ThreadPoolExecutor(max_workers=2)
    return run


def send(run, model, role, agent=None, messages=None, **kw):
    SENT.clear()
    obs = {"role": role, **({"agentId": agent} if agent else {})}

    async def go():
        return await s.ask(run, model, messages or [{"role": "system", "content": "sys"}, {"role": "user", "content": "hi"}], obs=obs,
                           on_reasoning=(lambda _t: asyncio.sleep(0)) if role == "worker" else None, **kw)
    asyncio.run(go())
    return SENT[-1]


USAGE = {"prompt_tokens": 1000, "completion_tokens": 10, "total_tokens": 1010, "cost": 0.001,
         "prompt_tokens_details": {"cached_tokens": 800, "cache_write_tokens": 150}}


def test_payload_per_role():
    s.urlopen = fake_urlopen(USAGE)
    run = make_run()
    planner = send(run, "m/plan", "planner")
    worker = send(run, "m/work", "worker", "1.1")
    judge = send(run, "m/judge", "reflection", "1.1")
    synth = send(run, "m/synth", "synthesis")
    assert [b["max_tokens"] for b in (planner, worker, judge, synth)] == [4_000, 12_000, 600, 16_000]
    assert [b.get("reasoning") for b in (planner, worker, judge, synth)] == [{"effort": "medium"}, {"effort": "low"}, {"effort": "low"}, {"effort": "medium"}]
    assert planner["provider"] == worker["provider"] == synth["provider"] == {"require_parameters": True, "data_collection": "allow"}
    assert judge["provider"] == {"require_parameters": True, "data_collection": "allow", "sort": "price"}
    assert worker["session_id"] == judge["session_id"] == "run-7:1.1" and "session_id" not in planner and "session_id" not in synth


def test_worker_effort_follows_the_setting_and_overrides_apply():
    s.urlopen = fake_urlopen(USAGE)
    run = make_run(reasoningEffort="high", dataCollection="deny",
                   maxTokensByRole={"worker": 9_000}, reasoningByRole={"planner": "off", "judge": "high"},
                   providerPrefs={"worker": {"sort": "throughput"}, "judge": {"sort": "latency"}})
    worker = send(run, "m/work", "worker", "1.1")
    assert worker["max_tokens"] == 9_000 and worker["reasoning"] == {"effort": "high"}  # the Settings value
    assert worker["provider"] == {"require_parameters": True, "data_collection": "deny", "sort": "throughput"}
    assert "reasoning" not in send(run, "m/plan", "planner")
    judge = send(run, "m/judge", "reflection", "1.1")
    assert judge["reasoning"] == {"effort": "high"} and judge["provider"]["sort"] == "latency"
    run.request.noReasoning.append("m/synth")
    assert "reasoning" not in send(run, "m/synth", "synthesis")  # never to a model that takes no reasoning parameter


def test_budget_still_bounds_max_tokens():
    s.urlopen = fake_urlopen(USAGE)
    run = make_run()
    run.request.pricing["m/work"] = s.Pricing(prompt=1e-6, completion=1e-3, contextLength=1_000_000)
    run.config.budgetCapUsd = 1.0
    assert send(run, "m/work", "worker", "1.1")["max_tokens"] < 1_000  # the allowance is smaller than the role cap


def test_cache_policy_and_explicit_breakpoints():
    assert [s.cache_policy(m) for m in ("anthropic/claude-sonnet-5", "qwen/qwen3-max", "google/gemini-2.0-flash", "google/gemini-3.8-flash",
                                        "openai/gpt-5", "deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "moonshotai/kimi-k3")] == \
        ["explicit", "explicit", "explicit", "automatic", "automatic", "automatic", "automatic", "automatic"]
    s.urlopen = fake_urlopen(USAGE)
    run = make_run()
    history = [{"role": "system", "content": "sys"}, {"role": "user", "content": "task"}, {"role": "assistant", "content": "", "tool_calls": [{"id": "c"}]},
               {"role": "tool", "tool_call_id": "c", "content": "result"}]
    sent = send(run, "anthropic/claude-sonnet-5", "worker", "1.1", messages=history)
    mark = {"type": "ephemeral"}
    assert sent["messages"][0]["content"] == [{"type": "text", "text": "sys", "cache_control": mark}]
    assert sent["messages"][3]["content"] == [{"type": "text", "text": "result", "cache_control": mark}]
    assert sent["messages"][1]["content"] == "task" and history[0]["content"] == "sys"  # only the wire copy is marked
    assert send(run, "deepseek/deepseek-v4.1-flash", "worker", "1.1", messages=history)["messages"] == history


def test_call_record_carries_cache_fields_and_backfills_them():
    s.urlopen = fake_urlopen(USAGE)
    run = make_run(observe=True)
    send(run, "m/work", "worker", "1.1")
    record = [e["record"] for e in run.events if e["type"] == "obs_record"][-1]
    assert (record["usage"]["cachedTokens"], record["usage"]["cacheWriteTokens"], record["usage"]["cacheDiscountUsd"]) == (800, 150, None)
    GENERATION_LOOKUPS.clear()
    s.urlopen = fake_urlopen({"prompt_tokens": 1000, "completion_tokens": 10, "total_tokens": 1010, "cost": 0.001})
    send(run, "m/work", "worker", "1.1")
    record = [e["record"] for e in run.events if e["type"] == "obs_record"][-1]
    assert GENERATION_LOOKUPS == [f"{s.OPENROUTER_BASE_URL}/generation?id=gen-1"]
    assert (record["usage"]["cachedTokens"], record["usage"]["cacheDiscountUsd"]) == (900, 0.0012)
    run_off = make_run(observe=False)
    GENERATION_LOOKUPS.clear()
    send(run_off, "m/work", "worker", "1.1")
    assert GENERATION_LOOKUPS == []  # no extra request when nothing is recorded
