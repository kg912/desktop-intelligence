"""Spec A Phase 3: the judge works on excerpts by default, asks for little reasoning and a short reply,
sees the claim-check history, and is told not to re-verify quotes. Fixture replay of the Istanbul judge calls."""
import json
import re

import fixture_run
import multi_agent_sidecar as s
from test_reflection_evidence import events, run_one_step, verdicts, worker_reply

SMALL = "The museum opens at 09:00 and closes at 17:00 every day except Monday."


def claims_answer(quote):
    return {"content": "The museum opens at nine in the morning on most days of the week [c1].\n\n```claims\n"
                       + json.dumps([{"id": "c1", "claim": "Opens 09:00", "callId": "call_big", "quote": quote}]) + "\n```"}


def test_excerpt_finds_the_quote_in_whitespace_heavy_text():
    text = "nav\n\n\n\n   \t\n" * 3_000 + "It offers connections to 5 destinations. The most frequent routes include Istanbul (IST)." + "\n\n x" * 3_000
    cut = s.excerpt(text, "It offers connections to 5 destinations.")
    assert cut is not None and "It offers connections to 5 destinations." in cut


def test_excerpts_by_default_even_when_everything_fits():
    run, fake = run_one_step(lambda role, body: verdicts(5)() if role == "judge" else
                             (claims_answer("opens at 09:00 and closes at 17:00") if any(m["role"] == "tool" for m in body["messages"]) else worker_reply(body)),
                             tool_result=lambda n: SMALL)
    [result] = events(run, "reflection_result")
    assert result["evidenceMode"] == "excerpts" and result["passed"]
    judge = fake.of("judge")[0]["messages"]
    assert s.EVIDENCE_MODE_SENTENCE["excerpts"] in judge[0]["content"]
    assert "opens at 09:00 and closes at 17:00" in judge[1]["content"]


def test_full_only_when_the_user_sets_it():
    run, _ = run_one_step(lambda role, body: verdicts(5)() if role == "judge" else
                          (claims_answer("opens at 09:00 and closes at 17:00") if any(m["role"] == "tool" for m in body["messages"]) else worker_reply(body)),
                          tool_result=lambda n: SMALL, judgeEvidenceMode="full")
    assert events(run, "reflection_result")[0]["evidenceMode"] == "full"


def test_judge_request_low_reasoning_and_short_reply():
    seen = []
    original = s.ask

    async def spy(run, model, messages, **kw):
        seen.append((kw.get("obs", {}).get("role"), kw.get("effort"), kw.get("max_tokens_cap")))
        return await original(run, model, messages, **kw)
    s.ask = spy
    try:
        run_one_step(lambda role, body: verdicts(5)() if role == "judge" else
                     (claims_answer("opens at 09:00 and closes at 17:00") if any(m["role"] == "tool" for m in body["messages"]) else worker_reply(body)),
                     tool_result=lambda n: SMALL)
    finally:
        s.ask = original
    assert ("reflection", "low", s.JUDGE_MAX_TOKENS) in seen and s.JUDGE_MAX_TOKENS == 600


def test_effort_and_cap_reach_the_payload():
    captured = []

    def fake(_key, model, messages, tools, max_tokens, on_delta, _cancelled, reasoning_effort=None, *_a, **_k):
        captured.append((max_tokens, reasoning_effort))
        on_delta("content", '{"score": 5, "reason": "ok", "issues": []}')
        return {"role": "assistant", "content": '{"score": 5, "reason": "ok", "issues": []}', "finish_reason": "stop"}, {"total_tokens": 2, "cost": 0}
    s._stream_openrouter = fake
    cfg = s.Config(maxAgents=1, budgetCapUsd=1, models={"orchestrator": "a", "worker": "b", "reflection": "m/r", "synthesizer": "d"},
                   reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    import asyncio
    run = s.Run("r", s.RunRequest(runId="r", chatId="c", task="t", config=cfg, openRouterApiKey="k", currentDateTime="x",
                                  pricing={"m/r": s.Pricing(prompt=1e-7, completion=1e-6, contextLength=1_000_000)}))
    run.executor = s.ThreadPoolExecutor(max_workers=1)
    asyncio.run(s.ask(run, "m/r", [{"role": "user", "content": "hi"}], effort="low", max_tokens_cap=600))
    asyncio.run(s.ask(run, "m/r", [{"role": "user", "content": "hi"}], effort="low", max_tokens_cap=600))
    run.request.noReasoning.append("m/r")
    asyncio.run(s.ask(run, "m/r", [{"role": "user", "content": "hi"}], effort="low", max_tokens_cap=600))
    assert captured == [(600, "low"), (600, "low"), (600, None)]  # never sent to a model that takes no reasoning parameter


def test_judge_prompt_says_do_not_reverify_and_carries_the_claim_check_history():
    first = claims_answer("this quote is nowhere in the result")
    fixed = claims_answer("opens at 09:00 and closes at 17:00")
    answers = iter([first, fixed])
    run, fake = run_one_step(lambda role, body: verdicts(5)() if role == "judge" else
                             (next(answers) if any(m["role"] == "tool" for m in body["messages"]) else worker_reply(body)),
                             tool_result=lambda n: SMALL)
    judge = fake.of("judge")[0]["messages"]
    assert "Do not re-check whether a quote is in its result" in judge[0]["content"]
    assert "Claim check history: attempt 0: c1 mismatch" in judge[1]["content"]


# ── Fixture replay: the six recorded judge calls of the Istanbul run ──────────

SECTION = re.compile(r"Overall task: (?P<task>.*?)\nSubtask \((?P<id>[^)]*)\): (?P<label>.*?)\n\n.*?"
                     r"Earlier agents' outputs it depends on:\n(?P<prior>.*?)\n\nOutput to judge:\n(?P<output>.*?)\n\nClaims \(id \|", re.S)


def replay_judges():
    """[(agent, attempt, recorded prompt tokens, recorded completion tokens, recorded cost, excerpts-mode messages)]."""
    fx = fixture_run.load()
    out = []
    for agent in fixture_run.worker_agents(fx):
        recs = fx["records"][agent]
        for judge in (r for r in recs if r["kind"] == "model" and r["role"] == "reflection"):
            m = SECTION.search(judge["request"]["messages"][1]["content"])
            attempt = judge["attempt"]
            _, claims, _ = s.parse_claims(fixture_run.final_answer(recs, attempt))
            store = fixture_run.store(recs, attempt)
            statuses = {c["id"]: s.verify_claim(c, store) for c in claims}
            prior = {} if m["prior"].startswith("(this step") else {"*": m["prior"]}
            cfg = s.Config(**{**fx["meta"]["config"], "maxAgents": fx["meta"]["config"]["maxAgents"]})
            run = s.Run("r", s.RunRequest(runId="r", chatId="c", task=m["task"], config=cfg, openRouterApiKey="k", currentDateTime="Current date and time: x."))
            history = [f"attempt {a}: earlier failures" for a in range(attempt)]
            msgs = s.judge_messages(run, {"id": agent, "label": m["label"]}, m["output"], prior, store, claims, statuses, "excerpts", history)
            u = judge["usage"]
            out.append((agent, attempt, u["promptTokens"], u["completionTokens"], u["costUsd"], msgs, claims))
    return out


def test_fixture_judge_input_falls_by_at_least_80_percent():
    # Same unit on both sides: the recorded judgeInputChars of each judge call vs the excerpts-mode input's chars.
    # (Recorded inputs run ~2.8 chars per real token, so a chars/4 estimate against recorded tokens would flatter "after".)
    calls = replay_judges()
    assert len(calls) == 6
    recorded = {(e["agentId"], e["attempt"]): e["judgeInputChars"] for e in fixture_run.load()["events"]
                if e["type"] == "reflection_result" and e.get("judgeInputChars")}
    before = sum(recorded[(c[0], c[1])] for c in calls)
    after = sum(len(m["content"]) for c in calls for m in c[5])
    assert before == 1_168_831 and after <= 0.2 * before, (before, after)
    assert sum(s.estimate_tokens(json.dumps(c[5])) for c in calls) <= 0.2 * sum(c[2] for c in calls)  # and in tokens


def test_fixture_judge_cost_share_at_most_25_percent():
    # Fit the judge model's two prices to the six recorded calls, then price the excerpts-mode calls with a 600-token cap.
    calls = replay_judges()
    sxx = sum(c[2] * c[2] for c in calls); sxy = sum(c[2] * c[3] for c in calls); syy = sum(c[3] * c[3] for c in calls)
    sxc = sum(c[2] * c[4] for c in calls); syc = sum(c[3] * c[4] for c in calls)
    det = sxx * syy - sxy * sxy
    p_in, p_out = (sxc * syy - syc * sxy) / det, (syc * sxx - sxc * sxy) / det
    for c in calls:  # the fit reproduces each recorded cost to within 1%
        assert abs(p_in * c[2] + p_out * c[3] - c[4]) <= 0.01 * c[4]
    # New input tokens at the recorded density (recorded tokens per recorded char), not chars/4, which undercounts here.
    recorded = {(e["agentId"], e["attempt"]): e["judgeInputChars"] for e in fixture_run.load()["events"]
                if e["type"] == "reflection_result" and e.get("judgeInputChars")}
    per_char = sum(c[2] for c in calls) / sum(recorded[(c[0], c[1])] for c in calls)
    judge_after = sum(p_in * per_char * sum(len(m["content"]) for m in c[5]) + p_out * s.JUDGE_MAX_TOKENS for c in calls)
    judge_before = sum(c[4] for c in calls)
    total_before = 0.62839207
    share = judge_after / (total_before - judge_before + judge_after)
    assert share <= 0.25, share


def test_fixture_real_catches_are_visible_on_excerpts():
    by = {(c[0], c[1]): c for c in replay_judges()}
    # 1.5 c7: the claim says NAV serves 2 destinations; its own quote says 5. Both must reach the judge.
    text = by[("1.5", 1)][5][1]["content"]
    assert "NAV serves 2 destinations (IST, SAW) with 2 airlines" in text
    assert "It offers connections to 5 destinations" in text.split("Excerpts around each cited quote:")[1]
    # 1.2 c2: was mis-cited; re-pointed (Phase 1), its excerpt now comes from the result that holds the quote.
    text = by[("1.2", 2)][5][1]["content"]
    block = re.search(r"\[([^\]]*\bc2\b[^\]]*)\] from call_01a130fb29337261b7db7d5a:\n(.*?)(?:\n\n\[|\n\nEarlier agents)", text, re.S)
    assert block and "6 days a week: Mon, Tue, Wed, Thu, Fri, Sun" in block.group(2)
