"""Spec A Phase 7: search results are trimmed in the worker's view (whitespace collapsed, each page's text cut to a
window around the query terms, title/url/first line always kept); the evidence store keeps them in full."""
import json
import statistics

import fixture_run
import multi_agent_sidecar as s
from test_reflection_evidence import events, run_one_step

FILLER = "".join(f"Menu item {i}\n\n\n" for i in range(200))
PAGE = FILLER + "The IZBAN train   runs every 30 minutes from Izmir airport to Selcuk.\n\n" + FILLER
RESULT = f"[1] IZBAN timetable\nhttps://iz.example\nCommuter rail around Izmir\n{PAGE}\n\n[2] Short page\nhttps://s.example\nJust a line."


def test_view_keeps_head_cuts_around_the_query_and_says_how_much_is_left():
    snippets, view = s.ingest_result(RESULT, 4, "IZBAN train Selcuk", "snippet")
    assert snippets == s.split_snippets(RESULT, 4)  # the store keeps everything
    first, second = view.split("\n\n[S4.2] ")
    assert first.startswith("[S4.1] IZBAN timetable\nhttps://iz.example\nCommuter rail around Izmir\n")
    assert "The IZBAN train runs every 30 minutes from Izmir airport to Selcuk." in first  # the window holds the query terms
    body = first.split("Commuter rail around Izmir\n", 1)[1]
    assert len(body) <= s.VIEW_PAGE_CHARS + 80 and "\n\n" not in body
    assert first.endswith('chars trimmed; read_evidence("S4.1") for the rest]')
    assert second == "Short page\nhttps://s.example\nJust a line."  # short pages are untouched


def test_legacy_view_and_non_search_results():
    _, view = s.ingest_result(RESULT, 4, "IZBAN train", "legacy")
    assert view.startswith("[1] IZBAN timetable\n") and "\n\n[2] Short page" in view and "[S4.1]" not in view.split("read_evidence")[0]
    assert s.ingest_result("AAPL: 231.4 USD", 1, "AAPL", "snippet") == ({"S1.1": "AAPL: 231.4 USD"}, "[S1.1] AAPL: 231.4 USD")
    assert s.ingest_result("AAPL: 231.4 USD", 1, "AAPL", "legacy") == ({"S1.1": "AAPL: 231.4 USD"}, "AAPL: 231.4 USD")


def test_a_quote_outside_the_view_still_verifies_from_the_store():
    far = "Menu item 100\n"  # in the page, ~1,300 chars before the query hit: cut from the worker's view
    answer = {"content": "The menu lists a final entry numbered 199 [c1].\n\n```claims\n"
                         + json.dumps([{"id": "c1", "claim": "item 199", "callId": "call_t", "quote": "Menu item 100 Menu item 101"}]) + "\n```"}
    calls = iter([{"tool_calls": [{"id": "call_t", "type": "function", "function": {"name": "fs__read_file", "arguments": '{"query": "IZBAN"}'}}]}, answer])
    run, fake = run_one_step(lambda role, body: {"content": '{"score": 5, "reason": "ok", "issues": []}'} if role == "judge"
                             else next(calls) if role == "worker" else {"content": "done [1.1]"}, tool_result=lambda n: RESULT)
    tool_msg = next(m for m in fake.of("worker")[-1]["messages"] if m["role"] == "tool")["content"]
    assert far not in tool_msg and run.evidence["1.1"]["call_t"]["result"] == RESULT
    assert events(run, "reflection_result")[0]["claimStatuses"] == {"c1": "verified"}


def fixture_views():
    """Every recorded tool result run through the real ingestion: (agent, callId, view, store entry)."""
    fx = fixture_run.load()
    out = []
    for agent in fixture_run.worker_agents(fx):
        for n, r in enumerate((r for r in fx["records"][agent] if r["kind"] == "tool"), 1):
            result = r["result"] or ""
            query = json.loads(r["args"] or "{}").get("query", "") if r["args"].startswith("{") else ""
            snippets, view = s.ingest_result(result, n, query, "snippet") if r["approved"] else ({}, result)
            out.append((agent, r["callId"], view, result, snippets))
    return fx, out


def test_fixture_median_view_at_most_5kb():
    _, views = fixture_views()
    sizes = [len(v[2]) for v in views]
    assert len(sizes) == 89 and statistics.median(sizes) <= 5_000, statistics.median(sizes)


def test_fixture_golden_every_verified_claim_still_verifies():
    fx, views = fixture_views()
    ingested = {(agent, cid): (result, snippets) for agent, cid, _, result, snippets in views}
    checked = 0
    for agent in fixture_run.worker_agents(fx):
        recs = fx["records"][agent]
        for attempt in sorted({r["attempt"] for r in recs if r["kind"] == "model" and r["role"] == "worker"}):
            _, claims, _ = s.parse_claims(fixture_run.final_answer(recs, attempt))
            before = fixture_run.store(recs, attempt)
            after = {cid: dict(e, result=ingested[(agent, cid)][0], snippets=ingested[(agent, cid)][1]) for cid, e in before.items()}
            for c in claims:
                old = s.verify_claim(dict(c), before)
                if old in s.CLAIM_OK:
                    checked += 1
                    assert s.verify_claim(dict(c), after) == old, (agent, attempt, c["id"])
    assert checked >= 300
