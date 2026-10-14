"""Spec B Phase 5: run state survives a sidecar kill (manual state dump in SQLite, no checkpointer), and one step can
be re-run without touching the other agents' records. The kill is a real SIGKILL of a child process mid-run."""
import asyncio
import json
import os
import signal
import sqlite3
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import fake_harness as h
import multi_agent_sidecar as s

PLAN = {"steps": [{"id": "1.1", "label": "Leg 1", "role": "Leg 1", "dependsOn": [], "covers": ["r1"]},
                  {"id": "1.2", "label": "Leg 2", "role": "Leg 2", "dependsOn": [], "covers": ["r2"]},
                  {"id": "2.1", "label": "Day plan", "role": "Planner", "dependsOn": ["1.2"]}],
        "checklist": [{"id": "r1", "text": "Leg 1 airlines", "scope": "1.1"}, {"id": "r2", "text": "Leg 2 airlines", "scope": "1.2"}]}
FACTS = {"1.1": [("Turkish Airlines flies IST-NAV", "r1", "verified")], "1.2": [("Pegasus flies ASR-ADB", "r2", "verified")],
         "2.1": [("Day 5 is in Selcuk", None, "verified")]}

CHILD = textwrap.dedent("""
    import sys, time
    sys.path.insert(0, {here!r})
    import fake_harness as h, multi_agent_sidecar as s
    s.STATE = s.StateStore({db!r})
    research = h.researcher({facts!r})
    def worker(agent, body):
        if agent == "1.2":
            time.sleep(600)  # killed here, mid-step
        return research(agent, body)
    h.run({plan!r}, worker, maxWaves=1)
""")


def wait_for(predicate, timeout=20.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("timed out")


def finished_agents(db):
    try:
        with sqlite3.connect(db) as conn:
            return {row[0] for row in conn.execute("SELECT agent_id FROM agent_state WHERE run_id = 'run'")}
    except sqlite3.Error:
        return set()


def test_killed_mid_run_resumes_without_repeating_finished_steps(tmp_path):
    db = str(tmp_path / "state.sqlite")
    child = subprocess.Popen([sys.executable, "-c", CHILD.format(here=str(Path(__file__).parent), db=db, facts=FACTS, plan=PLAN)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(lambda: "1.1" in finished_agents(db))
        time.sleep(0.2)
        child.send_signal(signal.SIGKILL)  # no finally blocks, no terminal event
        child.wait(10)
    finally:
        if child.poll() is None:
            child.kill()
    s.STATE = s.StateStore(db)
    try:
        [row] = s.STATE.resumable()
        assert (row["runId"], row["chatId"], row["finishedSteps"], row["totalSteps"]) == ("run", "c", ["1.1"], 3)
        assert "openRouterApiKey" not in json.dumps(s.STATE.load("run"))  # the key is never written
        fake = h.Fake({"planner": h.planner(PLAN), "worker": h.researcher(FACTS), "judge": h.passing_judge,
                       "synthesis": lambda _a, _b: {"content": "Final answer."}})
        s._stream_openrouter = fake
        run, state = s.resume_run("run", "key-2", last_seq=10_000)
        run.wait_for_approval = h_approve
        asyncio.run(s.orchestrate(run, state))
        agents = [agent for role, agent, _ in fake.calls if role == "worker"]
        assert "1.1" not in agents and set(agents) == {"1.2", "2.1"}  # the finished step made no new call
        assert [r for r, _, _ in fake.calls].count("planner") == 0  # nor did the planner
        assert run.events[0]["type"] == "run_resumed" and run.events[0]["finishedSteps"] == ["1.1"] and run.events[0]["seq"] == 10_001
        assert h.events(run, "task_complete")
        synthesis = fake.of("synthesis")[0][1]["messages"][1]["content"]
        assert "[1.1]" in synthesis and "Findings for step 1.1" in synthesis  # the stored output, unchanged
        assert s.STATE.resumable() == []  # completed
    finally:
        s.STATE = None


async def h_approve(agent_id, *_a, **_k):
    return (True, "") if agent_id == "orchestrator" else (True, "Search result text about the subject.")


def completed_run(tmp_path):
    s.STATE = s.StateStore(str(tmp_path / "state.sqlite"))
    run, fake = h.run(PLAN, h.researcher(FACTS), maxWaves=1)
    return run, fake


def test_rerun_one_step_leaves_the_other_records_intact(tmp_path):
    try:
        run, _ = completed_run(tmp_path)
        before = {a: json.dumps(run.step_results[a], sort_keys=True) for a in ("1.1", "2.1")}
        evidence_11 = json.dumps(run.evidence["1.1"], sort_keys=True)
        fake = h.Fake({"worker": h.researcher({**FACTS, "1.2": [("SunExpress flies ASR-ADB", "r2", "verified")]}), "judge": h.passing_judge,
                       "synthesis": lambda _a, _b: {"content": "Second answer."}})
        s._stream_openrouter = fake
        rerun, state = s.prepare_rerun("run", "1.2", api_key="k", model="m/strong", with_dependents=False, last_seq=run.seq)
        rerun.wait_for_approval = h_approve
        asyncio.run(s.orchestrate(rerun, state))
        assert {a for r, a, _ in fake.calls if r == "worker"} == {"1.2"}
        assert {b["model"] for r, a, b in fake.calls if r == "worker"} == {"m/strong"}
        assert {a: json.dumps(rerun.step_results[a], sort_keys=True) for a in ("1.1", "2.1")} == before
        assert json.dumps(rerun.evidence["1.1"], sort_keys=True) == evidence_11
        assert rerun.step_results["1.2"]["claims"][0]["claim"] == "SunExpress flies ASR-ADB"
        types = [e["type"] for e in rerun.events]
        assert types[0] == "rerun_start" and rerun.events[0]["seq"] == run.seq + 1
        [stale] = h.events(rerun, "agent_stale")
        assert (stale["agentId"], stale["reason"]) == ("2.1", "built on the earlier output of 1.2")
        assert "[2.1 STALE: built on the earlier output of 1.2]" in fake.of("synthesis")[0][1]["messages"][1]["content"]
        assert h.events(rerun, "task_complete")[0]["finalOutput"] == "Second answer."
    finally:
        s.STATE = None


def test_rerun_with_dependents_and_locked_steps(tmp_path):
    try:
        run, _ = completed_run(tmp_path)
        fake = h.Fake({"worker": h.researcher(FACTS), "judge": h.passing_judge, "synthesis": lambda _a, _b: {"content": "Third."}})
        s._stream_openrouter = fake
        rerun, state = s.prepare_rerun("run", "1.2", api_key="k", with_dependents=True, last_seq=run.seq)
        rerun.wait_for_approval = h_approve
        asyncio.run(s.orchestrate(rerun, state))
        assert sorted({a for r, a, _ in fake.calls if r == "worker"}) == ["1.2", "2.1"] and not h.events(rerun, "agent_stale")
        # A locked step is never invalidated: not re-run, not marked stale, and cannot itself be re-run.
        s.STATE.set_locked("run", "2.1", True)
        fake.calls.clear()
        rerun, state = s.prepare_rerun("run", "1.2", api_key="k", with_dependents=True, last_seq=rerun.seq)
        rerun.wait_for_approval = h_approve
        asyncio.run(s.orchestrate(rerun, state))
        assert {a for r, a, _ in fake.calls if r == "worker"} == {"1.2"} and not h.events(rerun, "agent_stale")
        try:
            s.prepare_rerun("run", "2.1", api_key="k", last_seq=rerun.seq)
        except s.RerunRefused as exc:
            assert str(exc) == "Step 2.1 is locked: unlock it to re-run it."
        else:
            raise AssertionError("a locked step must not re-run")
    finally:
        s.STATE = None


def test_no_state_db_means_no_persistence():
    s.STATE = None
    run, _ = h.run(PLAN, h.researcher(FACTS), maxWaves=1)
    assert h.events(run, "task_complete")


def test_endpoints(tmp_path):
    try:
        run, _ = completed_run(tmp_path)

        async def scenario():
            assert await s.resumable() == []
            assert await s.lock_step("run", "2.1", s.LockRequest(locked=True)) == {"ok": True}
            assert s.STATE.load("run")["state"]["locked"] == ["2.1"]
            try:
                await s.rerun_step("run", "2.1", s.RerunRequest(openRouterApiKey="k"))
            except s.HTTPException as exc:
                assert (exc.status_code, exc.detail) == (409, "Step 2.1 is locked: unlock it to re-run it.")
            else:
                raise AssertionError("locked")
            await s.lock_step("run", "2.1", s.LockRequest(locked=False))
            assert s.STATE.load("run")["state"]["locked"] == []
            try:
                await s.resume(" nope", s.ResumeRequest(openRouterApiKey="k"))
            except s.HTTPException as exc:
                assert exc.status_code == 404
            s.STATE.set_status("run", "running")
            assert [r["runId"] for r in await s.resumable()] == ["run"]
            await s.discard("run")
            assert await s.resumable() == []
        asyncio.run(scenario())
    finally:
        s.STATE = None
