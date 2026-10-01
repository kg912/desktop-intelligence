"""Repetition guard: looping streams trip it, legitimate repeated structure (tables) does not,
and the streaming client aborts the request and keeps what was produced."""
import io
import json
from unittest import mock

import multi_agent_sidecar as s

SKELETON = "I hope this helps! Final Answer: Your final answer here"


def trips_at(chunks):
    """Index of the chunk that tripped the detector, or None."""
    d = s.RepetitionDetector()
    for i, chunk in enumerate(chunks):
        if d.feed(chunk):
            return i
    return None


def pieces(text, size=7):
    return [text[i:i + size] for i in range(0, len(text), size)]


def sse(deltas):
    lines = [b": OPENROUTER PROCESSING\n", b"\n"]
    for delta in deltas:
        lines += [f"data: {json.dumps({'choices': [{'index': 0, 'delta': delta}]})}\n".encode(), b"\n"]
    lines += [b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":9,"cost":0.5}}\n',
              b"data: [DONE]\n"]
    return lines


class FakeResponse(io.BytesIO):
    def __init__(self, lines):
        super().__init__(b"".join(lines))
        self.read_lines = 0

    def __iter__(self):
        for line in self.getvalue().splitlines(keepends=True):
            self.read_lines += 1
            yield line


def stream(deltas):
    fake = FakeResponse(sse(deltas))
    seen = []
    with mock.patch.object(s, "urlopen", return_value=fake):
        message, usage = s._stream_openrouter("k", "m", [{"role": "user", "content": "hi"}], None, None,
                                              lambda kind, text: seen.append((kind, text)), lambda: False, None, True)
    return message, usage, seen, fake


if __name__ == "__main__":
    # 1. The same line three times in a row (ChatService's rule): trips on the third, chunked mid-line.
    assert trips_at(pieces("Intro line.\n" + (SKELETON + "\n") * 5)) == len(pieces("Intro line.\n" + (SKELETON + "\n") * 3)) - 1

    # 2. A loop with no newline at all: the same 11-word run back to back, trips on the 4th copy.
    one_line = "Sure. " + (SKELETON + " ") * 10
    i = trips_at(pieces(one_line))
    assert i is not None
    consumed = "".join(pieces(one_line)[:i + 1])
    assert consumed.count("Your final answer here") == 4, consumed

    # 3. Short-unit loops too ("the the the …" is a 3-gram × 4 = 12 words).
    assert trips_at(["word " * 11]) is None
    assert trips_at(["word " * 12]) == 0

    # 4. A long table must not trigger: 200 rows, identical cells, identical whole rows, rules.
    header = "| Day | City | Hotel | Breakfast | Parking | Wi-Fi |\n|---|---|---|---|---|---|\n"
    rows = "".join(f"| {d} | Vienna | Hotel Sacher | Yes | Yes | Yes |\n" for d in range(1, 101))
    same = "| TBD | TBD | TBD | TBD | TBD | TBD |\n" * 100
    table = "Here is the plan:\n\n" + header + rows + same + "\n---\n---\n---\n\nEnjoy the trip.\n"
    assert trips_at(pieces(table)) is None
    assert trips_at(pieces(table, 1)) is None  # one character per delta
    # ...also without leading pipes.
    assert trips_at(["Day | City | Yes\n" * 50]) is None

    # 5. Ordinary prose with a recurring phrase (not back to back) does not trigger.
    prose = "".join(f"On day {d} we visit the old town and then the old town museum.\n" for d in range(1, 30))
    assert trips_at(pieces(prose)) is None

    # 6. Two identical lines, then a different one, then the same again: resets, no trip.
    assert trips_at(["Done.\n", "Done.\n", "Next.\n", "Done.\n", "Done.\n"]) is None

    # 7. Client: a looping content stream is aborted early, keeps what it produced, and flags it.
    loop = [{"content": "Answer: 42.\n"}] + [{"content": SKELETON + "\n"}] * 50
    message, usage, seen, fake = stream(loop)
    assert message["looped"] == "content"
    assert message["content"] == "Answer: 42.\n" + (SKELETON + "\n") * 3, message["content"]
    assert len(seen) == 4
    assert fake.read_lines < 20, fake.read_lines  # stopped reading, never reached [DONE]
    # No usage chunk arrived: estimated from what was sent and produced, never zero.
    prompt = s.estimate_tokens(json.dumps([{"role": "user", "content": "hi"}]))
    completion = s.estimate_tokens(message["content"])
    assert usage == {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}, usage

    # 8. Client: a looping reasoning stream is caught the same way; content is untouched.
    message, usage, seen, _ = stream([{"reasoning": "Let me think. " + "I should check again. " * 3}] * 10)
    assert message["looped"] == "reasoning"
    assert message["content"] == ""
    # The repeating unit is the whole 15-word delta: tripped on its 4th copy, 6 never read.
    assert len(seen) == 4
    assert usage["completion_tokens"] == 4 * len("Let me think. " + "I should check again. " * 3) // 4 == 80

    # 9. Client: a long table streams to the end — no flag, real usage kept.
    message, usage, _, _ = stream([{"content": c} for c in pieces(table, 40)])
    assert "looped" not in message
    assert message["content"] == table
    assert usage == {"total_tokens": 9, "cost": 0.5}

    # 10. Per-request state: two requests each one line short of the threshold never trip together.
    assert "looped" not in stream([{"content": SKELETON + "\n"}] * 2)[0]
    assert "looped" not in stream([{"content": SKELETON + "\n"}] * 2)[0]

    # 11. Guard off (planner, reviewer, synthesis): the loop streams through unflagged.
    fake = FakeResponse(sse(loop))
    with mock.patch.object(s, "urlopen", return_value=fake):
        message, _ = s._stream_openrouter("k", "m", [], None, None, lambda *_: None, lambda: False)
    assert "looped" not in message
    print("ok")
