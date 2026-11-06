"""Exa spec 6a: worker web search through Exa (builtin__web_search) returns `[n] title\\nurl\\nbody` blocks whose
body is Exa's highlights (no separate snippet line). The sidecar's ingestion still treats it as a search result:
each page keeps title, url and its first body line (capped at VIEW_HEAD_LINE_CHARS), the rest is windowed, and
the evidence store keeps everything. Built from the recorded Phase 0 response (search-auto-highlights.json)."""
import json
from pathlib import Path

import multi_agent_sidecar as s

FIXTURE = Path(__file__).resolve().parents[2] / "src/main/services/search/__tests__/fixtures/search-auto-highlights.json"
RESULTS = json.loads(FIXTURE.read_text())["results"]
# The same shape ExaProvider.formatForModel gives workers (lite/auto: no synthesis block).
EXA = "\n\n".join(f"[{i + 1}] {r['title']}\n{r['url']}\n{chr(10).join(r['highlights']).strip()}" for i, r in enumerate(RESULTS))


def test_exa_result_is_split_per_page_and_the_store_keeps_full_highlights():
    assert s.is_search_result(EXA)
    snippets, _ = s.ingest_result(EXA, 2, "JWST discoveries 2025", "snippet")
    assert list(snippets) == ["S2.1", "S2.2", "S2.3", "S2.4", "S2.5"]
    for sid, r in zip(snippets, RESULTS):
        assert snippets[sid] == f"{r['title']}\n{r['url']}\n{chr(10).join(r['highlights']).strip()}"


def test_each_page_view_keeps_title_url_and_capped_first_line_and_long_pages_are_windowed():
    _, view = s.ingest_result(EXA, 2, "JWST discoveries 2025", "snippet")
    pages = view.split("\n\n[S2.")
    assert len(pages) == 5
    for i, (page, r) in enumerate(zip(pages, RESULTS)):
        lines = page.split("\n")
        assert lines[0] == f"[S2.{i + 1}] {r['title']}" if i == 0 else lines[0] == f"{i + 1}] {r['title']}"
        assert lines[1] == r["url"]
        first = r["highlights"][0].strip().split("\n")[0]
        assert lines[2] == s.preview(first, s.VIEW_HEAD_LINE_CHARS)
        assert len(lines[2]) <= s.VIEW_HEAD_LINE_CHARS
    longest = max(range(5), key=lambda i: len(RESULTS[i]["highlights"][0]))
    assert len(RESULTS[longest]["highlights"][0]) > 6000
    assert pages[longest].endswith(f'chars trimmed; read_evidence("S2.{longest + 1}") for the rest]')
    body = "\n".join(pages[longest].split("\n")[3:])
    assert len(body) <= s.VIEW_PAGE_CHARS + 80


def test_a_notice_after_the_results_joins_the_last_page_and_the_store_keeps_it():
    # Exa notices follow the results as "Exa notice: …" (never observed in Phase 0). Blocks split only before
    # "[n] ", so the notice becomes the tail of the last page: kept in full in the evidence store, but the
    # worker's windowed view of that page can cut it (documented limit; single chat sees it unchanged).
    with_notice = EXA + "\n\nExa notice: results may be stale"
    assert s.is_search_result(with_notice)
    snippets, _ = s.ingest_result(with_notice, 1, "x", "snippet")
    assert len(snippets) == 5
    assert snippets["S1.5"].endswith("\n\nExa notice: results may be stale")
