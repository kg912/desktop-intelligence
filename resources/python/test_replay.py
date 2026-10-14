"""Spec B Phase 6: replay one stage of a recorded run from its logs. On the Istanbul fixture the judge replay reproduces the
recorded claim-status table (the only difference is the claim spec A Phase 1 re-points) and calls only the judge."""
import asyncio
import subprocess
import sys
from pathlib import Path

import fake_harness as h
import fixture_run
import multi_agent_sidecar as s
import replay

FX = fixture_run.load()
HERE = Path(__file__).parent


def fake(judge_score=4, synthesis="Final answer."):
    f = h.Fake({"judge": lambda _a, _b: {"content": f'{{"score": {judge_score}, "reason": "ok", "issues": []}}'},
                "synthesis": lambda _a, _b: {"content": synthesis}}, cost={"judge": 0.002, "synthesis": 0.01})
    s._stream_openrouter = f
    return f


def test_judge_replay_reproduces_the_claim_status_table_and_costs_only_judge_calls():
    f = fake()
    out = asyncio.run(replay.replay_judge(FX, api_key="k"))
    assert [(c["agent"], c["attempt"]) for c in out["cases"]] == [("1.1", 1), ("1.2", 2), ("1.3", 2), ("1.4", 2), ("1.5", 1), ("2.1", 0)]
    # Claim statuses are deterministic: the recorded table, except 1.2 c2, which spec A Phase 1 re-points to the result holding its quote.
    assert out["statusDiff"] == [("1.2", 2, "c2", "quote_not_found", "verified_repointed")]
    assert asyncio.run(replay.replay_judge(FX, dry_run=True))["statusDiff"] == out["statusDiff"]
    assert {role for role, _, _ in f.calls} == {"judge"} and out["calls"] == 6 and round(out["costUsd"], 6) == 0.012
    assert out["verdicts"][0] == {"agent": "1.1", "attempt": 1, "recorded": (5, True), "now": (4, True), "reason": "ok"}
    assert round(out["recordedCostUsd"], 6) == 0.328518


def test_model_and_prompt_overrides():
    f = fake()
    asyncio.run(replay.replay_judge(FX, api_key="k", model="m/other", system="You are a strict reviewer, lenient this time. Reply with JSON."))
    assert {body["model"] for _, _, body in f.calls} == {"m/other"}
    assert {body["messages"][0]["content"] for _, _, body in f.calls} == {"You are a strict reviewer, lenient this time. Reply with JSON."}
    assert s.judge_messages.__name__ == "judge_messages"  # restored


def test_synthesis_replay_diffs_against_the_recorded_answer():
    recorded = next(e["finalOutput"] for e in FX["events"] if e["type"] == "task_complete")
    changed = recorded.replace(recorded.splitlines()[0], "A different first line.", 1)
    f = fake(synthesis=changed)
    out = asyncio.run(replay.replay_synthesis(FX, api_key="k"))
    assert [r for r, _, _ in f.calls] == ["synthesis"] and out["calls"] == 1 and out["costUsd"] == 0.01
    assert "+A different first line." in out["diff"] and f"-{recorded.splitlines()[0]}" in out["diff"]
    synth_input = next(r for r in FX["records"]["synthesis"] if r["kind"] == "model")["request"]["messages"][1]
    assert out["messages"][1] == synth_input and out["messages"][0]["content"].startswith(s.SYNTHESIS_SYSTEM)


def test_cli():
    done = subprocess.run([sys.executable, "-W", "ignore", "replay.py", "istanbul-3leg", "--stage", "judge", "--dry-run"], cwd=HERE,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    assert "Judged attempts: 6" in done.stdout and "1.2 a2 c2: quote_not_found -> verified_repointed" in done.stdout
    assert "Model calls: 0, cost $0.000000 (recorded judge calls: $0.328518)" in done.stdout
    run_dir = str(fixture_run.RUNS / "istanbul-3leg")  # a run directory works as well as a fixture name
    done = subprocess.run([sys.executable, "-W", "ignore", "replay.py", run_dir, "--stage", "synthesize"], cwd=HERE, capture_output=True, text=True,
                          timeout=120, env={"PATH": "/usr/bin:/bin"})
    assert done.returncode == 2 and "OPENROUTER_API_KEY is not set" in done.stderr
