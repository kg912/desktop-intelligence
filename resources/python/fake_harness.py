"""A fake OpenRouter for whole multi-step runs (spec B): the real orchestrate(), workers, gate and synthesis run;
replies come from small per-role functions. Not a test file (no test_ prefix)."""
import asyncio
import json
import re

import multi_agent_sidecar as s

TOOLS = [{"name": "web__search", "description": "", "parameters": {"type": "object"}}]
SUBTASK_RE = re.compile(r"Your subtask \(([^)]+)\)")


def role_of(body):
    system = body["messages"][0]["content"]
    for marker, role in (("orchestrator of a team", "planner"), ("strict reviewer", "judge"), ("You assess whether", "assess"),
                         ("answers yes or no", "condition"), ("synthesize", "synthesis")):
        if marker in system:
            return role
    return "worker"


def agent_of(body):
    match = SUBTASK_RE.search(body["messages"][1]["content"])
    return match.group(1) if match else ""


def answer(text, claims):
    return text + "\n\n```claims\n" + json.dumps(claims) + "\n```"


def researcher(facts):
    """Worker: one search, then an answer whose claims cite the search's snippet. facts: agentId → [(claim, req, kind)]
    with kind "verified" (cites the snippet), "unverified" (declared) or "none" (cites nothing). Unknown agents answer []."""
    def reply(agent_id, body):
        if not any(m["role"] == "tool" for m in body["messages"]):
            return {"tool_calls": [{"id": f"call_{agent_id}", "type": "function", "function": {"name": "web__search", "arguments": '{"query": "q"}'}}]}
        sid = next(re.search(r"\[(S\d+\.\d+)\]", m["content"]).group(1) for m in body["messages"] if m["role"] == "tool")
        claims = []
        for n, (claim, req, kind) in enumerate(facts.get(agent_id, []), 1):
            entry = {"id": f"c{n}", "claim": claim, **({"req": req} if req else {})}
            entry.update({"snippets": [sid]} if kind == "verified" else {"unverified": True} if kind == "unverified" else {})
            claims.append(entry)
        return {"content": answer(f"Findings for step {agent_id}: the sources agree on the facts listed in the claims below, each cited [c1].", claims)}
    return reply


class Fake:
    """route: role → fn(agent_id, body) → {"content"} | {"tool_calls"}. Records (role, agent, body) of every call."""

    def __init__(self, routes, cost=None):
        self.routes, self.calls, self.cost = routes, [], cost or {}

    def __call__(self, _key, model, messages, tools, _max_tokens, on_delta, _cancelled, *_a, **_k):
        body = json.loads(json.dumps({"model": model, "messages": messages, "tools": tools}))
        role = role_of(body)
        agent = agent_of(body) if role in ("worker", "judge") else ""
        self.calls.append((role, agent, body))
        reply = self.routes[role](agent, body)
        if reply.get("content"):
            on_delta("content", reply["content"])
        usage = {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": reply.get("cost", self.cost.get(role, 0.001))}
        return {"role": "assistant", "content": reply.get("content", ""), **({"tool_calls": reply["tool_calls"]} if reply.get("tool_calls") else {}),
                "finish_reason": "tool_calls" if reply.get("tool_calls") else "stop"}, usage

    def of(self, role):
        return [(agent, body) for r, agent, body in self.calls if r == role]


def passing_judge(_agent, _body):
    return {"content": '{"score": 5, "reason": "ok", "issues": []}'}


def planner(plan):
    return lambda _agent, _body: {"content": json.dumps(plan)}


def run(plan, worker, *, tool_result="Search result text about the subject.", extra_routes=None, approve=None, cost=None, **config):
    """orchestrate() a whole run. plan: the planner's JSON (object or array). cost: USD per call by role (default 0.001).
    Returns (run, fake)."""
    fake = Fake({"planner": planner(plan), "worker": worker, "judge": passing_judge,
                 "synthesis": lambda _a, _b: {"content": "Final answer."}, **(extra_routes or {})}, cost)
    s._stream_openrouter = fake
    base = dict(maxAgents=4, budgetCapUsd=1, models={"orchestrator": "m/o", "worker": "m/w", "reflection": "m/r", "synthesizer": "m/s"},
                reflectionPassThreshold=3, maxRetriesPerAgent=0, hitlTimeoutMs=60_000)
    base.update(config)
    r = s.Run("run", s.RunRequest(runId="run", chatId="c", task="Plan the trip", config=s.Config(**base), tools=TOOLS,
                                  openRouterApiKey="k", currentDateTime="Current date and time: x."))

    async def default_approve(agent_id, *_a, **_k):
        return (True, "") if agent_id == "orchestrator" else (True, tool_result)

    r.wait_for_approval = approve or default_approve
    asyncio.run(s.orchestrate(r))
    return r, fake


def events(r, kind):
    return [e for e in r.events if e["type"] == kind]
