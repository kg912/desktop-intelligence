"""Spec A Phase 6: consumed tool results become stubs in the worker's history; read_evidence / grep_evidence
re-read them from the evidence store (no Electron round trip, no approval)."""
import json

import fixture_run
import multi_agent_sidecar as s
from test_reflection_evidence import events, run_one_step

BRAVE = ("[1] Istanbul to Nevsehir flights\nhttps://a.example/x\nDirect flights take about an hour and 20 minutes.\n\n"
         "[2] Nevsehir airport guide\nhttps://b.example/y\nThe airport is 40 km from Goreme.")
RAIL = "[1] Izmir rail\nhttps://c.example/z\nThe IZBAN train runs every 30 minutes to Selcuk."


def tool_call(cid, path):
    return {"tool_calls": [{"id": cid, "type": "function", "function": {"name": "fs__read_file", "arguments": json.dumps({"path": path})}}]}


def test_stub_text():
    entry = {"name": "builtin__brave_web_search", "args": '{"query": "IST NAV"}', "ok": True, "attempt": 0, "result": BRAVE,
             "snippets": s.split_snippets(BRAVE, 3)}
    assert s.evidence_stub("call_x", entry) == (
        '[callId: call_x] builtin__brave_web_search {"query": "IST NAV"}: 2 snippets S3.1–S3.2, 0.2 KB — titles: '
        "Istanbul to Nevsehir flights; Nevsehir airport guide — an earlier result shown as a stub; "
        'use read_evidence("S3.1") or grep_evidence to see its text]')


def test_read_and_grep_evidence():
    store = {"call_x": {"name": "b", "args": "{}", "ok": True, "attempt": 0, "result": BRAVE, "snippets": s.split_snippets(BRAVE, 1)},
             "call_y": {"name": "b", "args": "{}", "ok": True, "attempt": 0, "result": RAIL, "snippets": s.split_snippets(RAIL, 2)}}
    assert s.evidence_tool("read_evidence", '{"ref": "S1.2"}', store) == (
        "[S1.2] (chars 0–76 of 76)\nNevsehir airport guide\nhttps://b.example/y\nThe airport is 40 km from Goreme.")
    assert s.evidence_tool("read_evidence", '{"ref": "call_y", "start": 4, "length": 10}', store) == "[call_y] (chars 4–14 of 83)\nIzmir rail"
    assert s.evidence_tool("read_evidence", '{"ref": "S9.9"}', store).startswith("No snippet or call S9.9. Known: S1.1, S1.2, S2.1")
    assert s.evidence_tool("grep_evidence", '{"pattern": "airport|train"}', store) == (
        "[S1.2] Nevsehir airport guide\n[S1.2] The airport is 40 km from Goreme.\n[S2.1] The IZBAN train runs every 30 minutes to Selcuk.")
    assert s.evidence_tool("grep_evidence", '{"pattern": "train", "callId": "call_x"}', store) == "No match for train."
    assert s.evidence_tool("grep_evidence", '{"pattern": "[unclosed"}', store) == "No match for [unclosed."  # bad regex → literal


def test_only_the_last_round_stays_in_full_and_older_snippets_still_verify():
    calls = iter([tool_call("call_a", "/a"), tool_call("call_b", "/b"),
                  {"content": "Flights take 1 h 20 [c1]; the IZBAN train runs every 30 minutes [c2].\n\n```claims\n"
                              + json.dumps([{"id": "c1", "claim": "flights 1 h 20", "snippets": ["S1.1"]},
                                            {"id": "c2", "claim": "IZBAN every 30 minutes", "snippets": ["S2.1"]}]) + "\n```"}])
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else next(calls) if role == "worker" else {"content": "done [1.1]"},
                             tool_result=lambda n: (BRAVE, RAIL)[n - 1])
    last = fake.of("worker")[-1]["messages"]
    tools = [m["content"] for m in last if m["role"] == "tool"]
    assert tools[0].startswith("[callId: call_a] fs__read_file") and "use read_evidence" in tools[0]  # consumed: stubbed
    assert tools[1] == "[callId: call_b]\n[S2.1] Izmir rail\nhttps://c.example/z\nThe IZBAN train runs every 30 minutes to Selcuk."
    [result] = events(run, "reflection_result")
    assert result["passed"] and result["claimStatuses"] == {"c1": "verified", "c2": "verified"}  # a never-re-read stub still cites
    assert run.evidence["1.1"]["call_a"]["result"] == BRAVE  # the store keeps it in full
    # The evidence tools are offered, and the system prompt says how to use them.
    assert {"read_evidence", "grep_evidence"} <= {t["name"] for t in fake.of("worker")[0]["tools"]}
    assert "read_evidence" in fake.of("worker")[0]["messages"][0]["content"]


def test_read_evidence_needs_no_approval_and_is_not_evidence():
    calls = iter([tool_call("call_a", "/a"), tool_call("call_b", "/b"),
                  {"tool_calls": [{"id": "call_r", "type": "function", "function": {"name": "read_evidence", "arguments": '{"ref": "S1.2"}'}}]},
                  {"content": "The airport is 40 km from Goreme, as the guide says [c1].\n\n```claims\n"
                              + json.dumps([{"id": "c1", "claim": "40 km", "snippets": ["S1.2"]}]) + "\n```"}])
    approvals = []
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else next(calls) if role == "worker" else {"content": "done [1.1]"},
                             tool_result=lambda n: approvals.append(n) or (BRAVE, RAIL)[n - 1])
    assert approvals == [1, 2]  # two Electron round trips; read_evidence never asked
    assert set(run.evidence["1.1"]) == {"call_a", "call_b"}
    read = [m for m in fake.of("worker")[-1]["messages"] if m["role"] == "tool"][-1]["content"]
    assert read.startswith("[S1.2] (chars 0–76 of 76)")
    done = [e for e in events(run, "tool_done") if e["callId"] == "call_r"]
    assert done and done[0]["ok"] and events(run, "reflection_result")[0]["passed"]


def replay_prompt_tokens(stub: bool) -> tuple[int, int]:
    """(total estimated worker prompt tokens, unique tool text tokens) over the fixture's 40 worker calls, each call's
    prompt rebuilt as the recorded prefix of its agent's final history, with or without consumed results stubbed."""
    fx = fixture_run.load()
    total, unique = 0, set()
    for agent in fixture_run.worker_agents(fx):
        recs = fx["records"][agent]
        workers = [r for r in recs if r["kind"] == "model" and r["role"] == "worker"]
        history = workers[-1]["request"]["messages"]
        store = fixture_run.store(recs)
        for n, (cid, entry) in enumerate(store.items(), 1):
            entry["snippets"] = s.split_snippets(entry["result"], n) if entry["ok"] else {}
            unique.add(entry["result"])
        for r in workers:
            count = r["request"].get("messageCount", len(r["request"]["messages"]))
            prompt = json.loads(json.dumps(history[:count]))
            if stub:
                s.stub_consumed(prompt, store, set())
            total += s.estimate_tokens(json.dumps(prompt))
    return total, sum(s.estimate_tokens(t) for t in unique)


def test_fixture_worker_prompts_at_most_3x_unique_tool_text():
    before, unique = replay_prompt_tokens(stub=False)
    after, _ = replay_prompt_tokens(stub=True)
    assert before > 6 * unique  # the recorded run: ~7x
    assert after <= 3 * unique, (after, unique, after / unique)
