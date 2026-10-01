"""Part D helpers: DSML parsing/stripping, the streaming DSML filter, EOS stripping, corrective tool error."""
import asyncio

import multi_agent_sidecar as s

DSML = ('Let me search.<｜DSML｜tool_calls>\n<｜DSML｜invoke name="builtin__brave_web_search">\n'
        '<｜DSML｜parameter name="query" string="true">hotels Füssen</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>')


async def streamed(chunks):
    out = []

    async def emit(text):
        out.append(text)

    f = s.DsmlTokenFilter(emit)
    for chunk in chunks:
        await f(chunk)
    await f.flush()
    return "".join(out)


if __name__ == "__main__":
    calls, rest = s.extract_dsml(DSML)
    assert calls == [{"id": "call_dsml_0", "type": "function",
                      "function": {"name": "builtin__brave_web_search", "arguments": '{"query": "hotels F\\u00fcssen"}'}}], calls
    assert rest == "Let me search.", rest
    assert s.extract_dsml("| a | b |") == ([], "| a | b |")  # no DSML: untouched
    assert s.extract_dsml("| a | b |\n<|DSML|tool_calls> unfinished")[1] == "| a | b |"  # tables keep their pipes
    # The marker split across chunks is held back, then suppressed; ordinary "<" text passes.
    assert asyncio.run(streamed(["Let me ", "check <", "｜DS", "ML｜tool_calls>", "<｜DSML｜invoke"])) == "Let me check "
    assert asyncio.run(streamed(["a < b and <", "i>x"])) == "a < b and <i>x"
    assert s.EOS_RE.sub("", "a<|endoftext|>b<|im_end|>c<|eot_id|>") == "abc"
    try:
        s.split_tool_name("evil__exec", {"builtin__brave_web_search"})
        raise AssertionError("not rejected")
    except ValueError as exc:
        assert str(exc) == ('"evil__exec" is not registered in the tool schema for this session and cannot be called. '
                            "Do not call it again. Registered tools for this session: builtin__brave_web_search.")
    print("ok")
