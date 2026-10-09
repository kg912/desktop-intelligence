"""Reflection hardening Phase 3: the claims contract, the deterministic quote check and the gate order."""
import asyncio
import json

import multi_agent_sidecar as s
from test_reflection_evidence import CALL, events, run_one_step

# 20,000 chars of distinct lines, so an excerpt window can be checked exactly.
ROWS = "".join(f"row {i:05d} has value {i * 7}\n" for i in range(800))
LINE = 'Record revenue of "$392.4 million", up 12% — a new high.\n'
RESULT = ROWS[:15_000] + LINE + ROWS[15_000:]
PROSE = "ALAB reported record quarterly revenue [c1]; the 13F trend could not be checked [c2]."


def answer(*claims):
    return {"content": PROSE + "\n\n```claims\n" + json.dumps(list(claims)) + "\n```"}


GOOD = {"id": "c1", "claim": "ALAB Q2 revenue $392.4M", "callId": "call_big", "quote": "record   revenue of “$392.4 million”"}
UNVERIFIED = {"id": "c2", "claim": "2-quarter 13F trend", "unverified": True}


def scripted(worker_answers, verdict=lambda: {"content": '{"score": 5, "reason": "ok", "issues": []}'}):
    """Worker: tool call first, then the next scripted answer each time it is asked after a tool result."""
    answers = iter(worker_answers)

    def route(role, body):
        if role == "judge":
            return verdict()
        if role == "worker":
            return next(answers) if any(m["role"] == "tool" for m in body["messages"]) else CALL
        return {"content": "done [1.1]"}
    return route


if __name__ == "__main__":
    # Parsing: the block leaves the prose; each claim shape; a missing or broken block is an issue, not a crash.
    prose, claims, errors = s.parse_claims(answer(GOOD, UNVERIFIED, {"id": "c3", "claim": "From 1.1", "source": "1.1"})["content"])
    assert prose == PROSE and errors == [] and [c["id"] for c in claims] == ["c1", "c2", "c3"], (prose, claims, errors)
    assert s.parse_claims(PROSE) == (PROSE, [], ["No claims block: end the answer with a ```claims JSON array (use [] if it makes no factual claims)."])
    assert s.parse_claims(PROSE + "\n```claims\n[{oops\n```")[2][0].startswith("The claims block is not valid JSON")
    assert s.parse_claims(PROSE + '\n```claims\n[{"id": "c9", "claim": "x"}, 3]\n```')[2] == [
        'Claim c9 needs a callId and a quote, "unverified": true, or a "source".', 'Claim #2 needs an "id" and a "claim".']

    # Normalisation is formatting only: spacing, curly quotes, dashes, &nbsp;, tags, emphasis, separators, case.
    store = {"call_big": {"name": "fs__read_file", "args": "{}", "ok": True, "attempt": 0, "result": RESULT},
             "html": {"name": "web", "args": "{}", "ok": True, "attempt": 0, "result": "<p>Revenue was <b>$1,234,567</b> &mdash; up&nbsp;3%</p>"},
             "denied": {"name": "web", "args": "{}", "ok": False, "attempt": 0, "result": "Tool request denied: no"}}
    check = lambda call_id, quote: s.verify_claim({"id": "x", "claim": "x", "callId": call_id, "quote": quote}, store)
    assert check("call_big", GOOD["quote"]) == "verified"
    assert check("call_big", 'RECORD REVENUE of "$392.4 million", up 12% - a new high') == "verified"
    assert check("html", "revenue was **$1234567** — up 3%") == "verified"
    assert check("call_big", 'record revenue of "$392.5 million"') == "quote_not_found"  # no fuzzy matching
    assert check("nope", GOOD["quote"]) == "call_not_found"
    assert check("denied", "Tool request denied") == "call_failed"
    assert check("call_big", "  row 00001 ") == "quote_too_short"
    assert check("call_big", ROWS[:500]) == "quote_too_long"
    assert s.verify_claim(UNVERIFIED, store) == "unverified_declared"

    # A quote that is not in the cited result is caught with no judge call; the repair names the claim; the fixed answer is judged.
    bad = {**GOOD, "quote": "record revenue of $401.0 million"}
    run, fake = run_one_step(scripted([answer(bad, UNVERIFIED), answer(GOOD, UNVERIFIED)]), tool_result=lambda n: RESULT, retries=1)
    results = events(run, "reflection_result")
    assert [(r["attempt"], r["model"], r["passed"]) for r in results] == [(0, "claims check", False), (1, "m/r", True)], results
    assert results[0]["claimStatuses"] == {"c1": "quote_not_found", "c2": "unverified_declared"}
    assert (results[0]["claimsChecked"], results[0]["claimsFailed"]) == (1, 1)
    assert results[0]["issues"] == ["Claim c1 (callId call_big): the quote is not in the cited tool result."]
    assert len(fake.of("judge")) == 1 and "Claim c1 (callId call_big)" in json.dumps(fake.of("worker")[-1])
    assert results[1]["claimStatuses"] == {"c1": "verified", "c2": "unverified_declared"}
    judge = fake.of("judge")[0]["messages"]
    assert '- c1 | ALAB Q2 revenue $392.4M | verified | quote: "record   revenue of “$392.4 million”" | callId: call_big' in judge[1]["content"]
    assert "- c2 | 2-quarter 13F trend | unverified_declared | declared unverified" in judge[1]["content"]
    assert "unmarked numeric assertion counts as an unbacked claim" in judge[0]["content"]
    assert run.events[-1]["type"] == "task_complete"

    # The worker sees each tool result headed by its callId; the claims block never reaches the card.
    worker_tool = next(m for m in fake.of("worker")[1]["messages"] if m["role"] == "tool")
    assert worker_tool["content"] == "[callId: call_big]\n" + RESULT
    tokens = "".join(e["token"] for e in run.events if e["type"] == "agent_token" and e["attempt"] == 1)
    complete = [e for e in events(run, "agent_complete") if e["attempt"] == 1][0]
    assert tokens == complete["output"] == PROSE, (tokens, complete["output"])

    # An unverified claim is not an issue: judged on the first attempt.
    run, fake = run_one_step(scripted([answer(UNVERIFIED)]), tool_result=lambda n: RESULT)
    assert [r["model"] for r in events(run, "reflection_result")] == ["m/r"] and events(run, "reflection_result")[0]["passed"]

    # Forced excerpts: the judge gets ±800 chars of the cited result around the quote, not the rest.
    run, fake = run_one_step(scripted([answer(GOOD)]), tool_result=lambda n: RESULT, judgeEvidenceMaxTokens=100)
    content = fake.of("judge")[0]["messages"][1]["content"]
    assert events(run, "reflection_result")[0]["evidenceMode"] == "excerpts"
    assert ROWS[14_300:15_000] in content and LINE in content and ROWS[15_000:15_700] in content
    assert ROWS[:13_000] not in content and "row 00010 " not in content and "row 00799 " not in content

    # No claims block twice: one repair turn (no judge), then the last attempt is judged and cannot pass.
    run, fake = run_one_step(scripted([{"content": PROSE}, {"content": PROSE}]), tool_result=lambda n: RESULT, retries=1)
    results = events(run, "reflection_result")
    assert [(r["model"], r["passed"]) for r in results] == [("claims check", False), ("m/r", False)], results
    assert results[1]["reason"].startswith("1 claim problem(s); reviewer: ") and len(fake.of("judge")) == 1
    assert "No claims block" in json.dumps(fake.of("worker")[-1])  # the repair turn said what to fix
    # The card stream: the claims block (marker split across chunks) and the whitespace before it never stream; other fences do.
    async def streamed(chunks):
        out = []

        async def emit(text):
            out.append(text)
        f = s.DsmlTokenFilter(emit)
        for chunk in chunks:
            await f(chunk)
        await f.flush()
        return "".join(out)
    assert asyncio.run(streamed(["Answer [c1].", "\n", "\n``", "`cla", "ims\n[]\n```"])) == "Answer [c1]."
    assert asyncio.run(streamed(["Code:\n``", "`python\nx = 1\n```\n", "done  "])) == "Code:\n```python\nx = 1\n```\ndone  "
    print("ok")
