"""Observability spec Phase 1: the per-field cap on call records and the record shape on cancel."""
import asyncio

import multi_agent_sidecar as s

if __name__ == "__main__":
    s.RECORD_FIELD_CAP_CHARS = 10
    capped = []
    out = s.cap_fields({"request": {"messages": [{"content": "x" * 25}, {"content": "short"}]}, "n": 3}, "", capped)
    assert capped == [{"field": "request.messages[0].content", "originalChars": 25}], capped
    assert out["request"]["messages"][0]["content"].startswith("x" * 10 + "\n[cut at 10 of 25 chars]"), out
    assert out["request"]["messages"][1]["content"] == "short" and out["n"] == 3

    rec = s.call_record("m", {"role": "worker", "agentId": "1.1"}, {"content": ["par", "tial"], "startedAt": 1, "endedAt": 5},
                        error=asyncio.CancelledError())
    assert rec["response"]["content"] == "partial" and rec["response"]["finishReason"] == "cancelled", rec
    assert rec["error"]["kind"] == "cancelled" and rec["timing"]["ms"] == 4 and rec["request"] is None
    print("ok")
