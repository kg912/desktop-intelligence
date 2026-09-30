"""Desktop Intelligence multi-agent sidecar (MULTI_AGENT_SPEC.html §03–§07).

A loopback-only orchestration service. It reasons and emits AgentEvents; it
never executes host commands and has no MCP transport. Every worker tool call
is a hitl_pause round-trip to Electron, which runs it through McpServerManager
→ SandboxService. Electron launches this process inside the srt sandbox (only
the OpenRouter domain reachable, loopback bind allowed), passes a per-launch
auth token, and supplies the OpenRouter key per run.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import math
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import warnings

# LangGraph's checkpoint serializer emits a pending-deprecation notice on import; it is
# third-party noise in the [Sidecar] log (no checkpointer is used here).
warnings.filterwarnings("ignore", message=".*allowed_objects.*")

try:  # LangGraph owns the run's state machine (plan → approve → workers → synthesize).
    from langgraph.graph import END, START, StateGraph  # type: ignore
except ImportError as exc:  # Startup remains explicit and observable.
    raise RuntimeError("Missing multi-agent dependencies. Install resources/python/requirements-multi-agent.txt") from exc


PORT = int(os.environ.get("DI_MULTI_AGENT_PORT", "7823"))
TOKEN = os.environ.get("DI_MULTI_AGENT_TOKEN", "")
# Overridable for the integration tests' local fake; production always uses OpenRouter.
OPENROUTER_BASE_URL = os.environ.get("DI_OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")

# Must match ESTIMATE.toolRoundsMax in src/shared/multiAgentModels.ts.
MAX_TOOL_ROUNDS = 6
REQUEST_TIMEOUT_S = 120
RUN_RETENTION_S = 600
# Budget held back so a partial synthesis can always run within the cap.
SYNTHESIS_RESERVE_PROMPT_TOKENS = 6_000
SYNTHESIS_RESERVE_COMPLETION_TOKENS = 1_500
SYNTHESIS_MAX_COMPLETION_TOKENS = 2_000
# Budget alone can imply millions of tokens on cheap models; providers 400 when
# max_tokens exceeds the context window. Hard ceiling when context is unknown.
MAX_COMPLETION_TOKENS = 32_768


class Pricing(BaseModel):
    prompt: float = Field(ge=0)
    completion: float = Field(ge=0)
    contextLength: int = Field(default=0, ge=0)  # 0 = unknown


class Config(BaseModel):
    maxAgents: int = Field(ge=1, le=8)
    budgetCapUsd: float = Field(ge=0)
    models: dict[str, str]
    reflectionPassThreshold: int = Field(ge=1, le=5)
    maxRetriesPerAgent: int = Field(ge=0, le=5)
    hitlTimeoutMs: int = Field(ge=1_000)
    requirePermissions: bool = True


class RunRequest(BaseModel):
    runId: str = Field(min_length=1)
    chatId: str
    task: str = Field(min_length=1)
    config: Config
    tools: list[dict[str, Any]] = Field(default_factory=list)
    openRouterApiKey: str = Field(min_length=1)
    # USD per token, from Electron's OpenRouter catalogue. Missing = unknown.
    pricing: dict[str, Pricing] = Field(default_factory=dict)


class HitlResponse(BaseModel):
    runId: str
    agentId: str
    approved: bool
    result: str = ""


class BudgetReached(Exception):
    pass


class AgentFailed(Exception):
    pass


def require_token(x_di_token: str = Header(default="")) -> None:
    """Every endpoint requires the per-launch token Electron generated."""
    if not TOKEN or not hmac.compare_digest(x_di_token, TOKEN):
        raise HTTPException(401, "invalid sidecar token")


@dataclass
class Run:
    run_id: str
    request: RunRequest
    seq: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=list)
    cancelled: bool = False
    finished: bool = False
    task: asyncio.Task[None] | None = None
    total_cost: float = 0.0
    total_tokens: int = 0
    budget_reached: bool = False
    # Worst-case cost of requests in flight — parallel workers share the allowance.
    reserved: float = 0.0
    budget_changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    approvals: dict[str, asyncio.Future[tuple[bool, str]]] = field(default_factory=dict)

    @property
    def config(self) -> Config:
        return self.request.config

    def totals(self) -> dict[str, Any]:
        return {"costUsd": round(self.total_cost, 8), "tokens": self.total_tokens, "budgetReached": self.budget_reached}

    async def emit(self, event_type: str, **payload: Any) -> None:
        if self.finished:
            return  # exactly one terminal event, always last
        self.seq += 1
        event = {"runId": self.run_id, "seq": self.seq, "ts": int(time.time() * 1000), "type": event_type, **payload}
        if self.total_tokens or self.total_cost:
            event["runTotals"] = self.totals()
        self.events.append(event)
        if event_type in ("task_complete", "task_failed"):
            self.finished = True
        for subscriber in list(self.subscribers):
            subscriber.put_nowait(event)
        if self.finished:
            for subscriber in list(self.subscribers):
                subscriber.put_nowait(None)

    async def wait_for_approval(self, agent_id: str, role: str, model: str, tool_name: str, server_name: str, args: dict[str, Any]) -> tuple[bool, str]:
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self.approvals[agent_id] = future
        await self.emit("hitl_pause", agentId=agent_id, role=role, model=model, toolName=tool_name, serverName=server_name, args=args)
        try:
            return await asyncio.wait_for(future, timeout=self.config.hitlTimeoutMs / 1000)
        except asyncio.TimeoutError:
            # Spec §07: auto-deny on timeout; the UI must see the pause end.
            await self.emit("hitl_resume", agentId=agent_id, approved=False)
            raise AgentFailed(f"approval for {server_name}:{tool_name} timed out after {self.config.hitlTimeoutMs // 1000}s") from None
        finally:
            self.approvals.pop(agent_id, None)

    # ── Budget ────────────────────────────────────────────────────────────
    def price(self, model: str) -> Pricing | None:
        return self.request.pricing.get(model)

    def synthesis_reserve(self) -> float:
        p = self.price(self.config.models.get("synthesizer", ""))
        if not p:
            return 0.0
        reserve = SYNTHESIS_RESERVE_PROMPT_TOKENS * p.prompt + SYNTHESIS_RESERVE_COMPLETION_TOKENS * p.completion
        return min(reserve, self.config.budgetCapUsd * 0.25)

    def account(self, model: str, usage: dict[str, Any]) -> tuple[int, float]:
        tokens = int(usage.get("total_tokens") or 0)
        cost = usage.get("cost")
        if cost is None:  # OpenRouter usage accounting absent: price from the catalogue, never invent.
            p = self.price(model)
            cost = (int(usage.get("prompt_tokens") or 0) * p.prompt + int(usage.get("completion_tokens") or 0) * p.completion) if p else 0.0
        cost = float(cost or 0.0)
        self.total_tokens += tokens
        self.total_cost += cost
        if self.total_cost + self.synthesis_reserve() >= self.config.budgetCapUsd:
            self.budget_reached = True
        return tokens, cost

    def release(self, worst_case: float) -> None:
        """Drop a request's reservation (caller holds budget_changed) and wake waiters."""
        self.reserved -= worst_case
        if self.reserved < 1e-12:  # float residue from add/subtract must not look like "in flight"
            self.reserved = 0.0
        self.budget_changed.notify_all()

    def plan_request(self, model: str, messages: list[dict[str, Any]], *, synthesis: bool) -> tuple[int | None, float]:
        """(max_tokens, worst-case cost) keeping total spend — including other
        in-flight requests' reservations — within the cap. None = unbounded (unpriced)."""
        p = self.price(model)
        if not p or p.completion == 0:
            return (SYNTHESIS_MAX_COMPLETION_TOKENS if synthesis else None), 0.0
        allowance = self.config.budgetCapUsd - self.total_cost - self.reserved - (0.0 if synthesis else self.synthesis_reserve())
        prompt_tokens = estimate_tokens(json.dumps(messages))
        prompt_cost = prompt_tokens * p.prompt
        tokens = math.floor((allowance - prompt_cost) / p.completion)
        tokens = min(tokens, MAX_COMPLETION_TOKENS)
        if p.contextLength:  # 1.25x: estimate_tokens is len/4, real tokenisers can run denser
            tokens = min(tokens, p.contextLength - math.ceil(prompt_tokens * 1.25))
        if synthesis:
            tokens = min(tokens, SYNTHESIS_MAX_COMPLETION_TOKENS)
        return tokens, prompt_cost + max(tokens, 0) * p.completion


RUNS: dict[str, Run] = {}
app = FastAPI(title="Desktop Intelligence Multi-Agent Sidecar", dependencies=[Depends(require_token)])


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


# ── OpenRouter streaming client (runs in a worker thread) ─────────────────────

def _stream_openrouter(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_tokens: int | None,
    on_delta: Callable[[str], None],
    cancelled: Callable[[], bool],
) -> tuple[dict[str, Any], dict[str, Any]]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "stream": True,
        # OpenRouter usage accounting: final chunk carries tokens AND cost.
        "usage": {"include": True},
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if tools:
        payload["tools"] = [{"type": "function", "function": tool} for tool in tools]
        payload["tool_choice"] = "auto"
    request = Request(
        f"{OPENROUTER_BASE_URL}/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://desktop-intelligence.local",
            "X-Title": "Desktop Intelligence",
        },
    )
    content: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    try:
        with urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:  # nosec B310 — fixed URL
            for raw in response:
                if cancelled():
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue  # SSE comments (": OPENROUTER PROCESSING") and blank lines
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                chunk = json.loads(data)
                if chunk.get("error"):
                    raise RuntimeError(f"OpenRouter error: {chunk['error'].get('message', chunk['error'])}")
                if chunk.get("usage"):
                    usage = chunk["usage"]
                for choice in chunk.get("choices") or []:
                    delta = choice.get("delta") or {}
                    text = delta.get("content")
                    if text:
                        content.append(text)
                        on_delta(text)
                    for call in delta.get("tool_calls") or []:
                        slot = tool_calls.setdefault(int(call.get("index", 0)), {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                        if call.get("id"):
                            slot["id"] = call["id"]
                        fn = call.get("function") or {}
                        slot["function"]["name"] += fn.get("name") or ""
                        slot["function"]["arguments"] += fn.get("arguments") or ""
    except HTTPError as err:
        body = err.read().decode("utf-8", "replace")
        try:
            detail = json.loads(body).get("error", {}).get("message") or body
        except (ValueError, AttributeError):
            detail = body
        raise RuntimeError(f"OpenRouter HTTP {err.code}: {detail[:300]}") from None
    message: dict[str, Any] = {"role": "assistant", "content": "".join(content)}
    if tool_calls:
        message["tool_calls"] = [tool_calls[i] for i in sorted(tool_calls)]
    return message, usage


async def ask(
    run: Run,
    model: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
    synthesis: bool = False,
) -> tuple[dict[str, Any], int, float]:
    """One paid request. Never starts once the budget is reached (spec §06)."""
    if run.cancelled:
        raise asyncio.CancelledError()
    if run.budget_reached and not synthesis:
        raise BudgetReached()
    async with run.budget_changed:
        while True:
            max_tokens, worst_case = run.plan_request(model, messages, synthesis=synthesis)
            if max_tokens is None or max_tokens >= 16:
                run.reserved += worst_case
                break
            if not run.reserved:  # nothing in flight can free budget: the cap is reached
                run.budget_reached = True
                raise BudgetReached()
            await run.budget_changed.wait()  # a parallel request may finish under its reservation
            if run.budget_reached and not synthesis:
                raise BudgetReached()

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue()
    done = object()

    def push(item: Any) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, item)

    def work() -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            return _stream_openrouter(run.request.openRouterApiKey, model, messages, tools, max_tokens, push, lambda: run.cancelled)
        finally:
            push(done)

    try:
        future = loop.run_in_executor(None, work)
        while (item := await queue.get()) is not done:
            if on_token:
                await on_token(item)
        message, usage = await future
    except BaseException:
        async with run.budget_changed:
            run.release(worst_case)
        raise
    async with run.budget_changed:
        tokens, cost = run.account(model, usage)  # charge actual cost before releasing the reservation
        run.release(worst_case)
    return message, tokens, cost


# ── Planning ─────────────────────────────────────────────────────────────────

PLANNER_SYSTEM = (
    "You are the orchestrator of a team of AI agents. Decompose the user's task into independent worker steps. "
    "Return ONLY a JSON array. Each element: {\"id\": \"<phase>.<n>\", \"label\": short imperative subtask, "
    "\"role\": short agent role name, \"phase\": integer >= 1}. Steps in the same phase run in parallel; "
    "later phases receive earlier phases' results. You may spawn a maximum of {max_agents} agents."
)


def parse_plan(text: str, config: Config) -> list[dict[str, Any]]:
    match = re.search(r"\[.*\]", text, re.S)
    if not match:
        raise ValueError("no JSON array in planner output")
    raw = json.loads(match.group(0))
    if not isinstance(raw, list) or not raw:
        raise ValueError("plan is not a non-empty list")
    steps: list[dict[str, Any]] = []
    seen: set[str] = set()
    counters: dict[int, int] = {}
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("label", "")).strip():
            raise ValueError("every step needs a label")
        phase = max(1, int(item.get("phase", 1)))
        counters[phase] = counters.get(phase, 0) + 1
        step_id = str(item.get("id") or f"{phase}.{counters[phase]}")
        if step_id in seen:
            step_id = f"{phase}.{counters[phase]}"
        seen.add(step_id)
        steps.append({
            "id": step_id,
            "label": str(item["label"]).strip()[:200],
            "stage": "worker",
            "role": str(item.get("role") or "Analyst").strip()[:60],
            "model": config.models.get("worker", ""),
            "phase": phase,
        })
    return steps


def fallback_plan(config: Config) -> list[dict[str, Any]]:
    labels = ["Analyze the task", "Research supporting evidence", "Review risks and recommendations"]
    return [{"id": f"1.{i + 1}", "label": labels[i], "stage": "worker", "role": "Analyst", "model": config.models.get("worker", ""), "phase": 1}
            for i in range(min(config.maxAgents, len(labels)))]


async def plan_node(state: dict[str, Any]) -> dict[str, Any]:
    run: Run = state["run"]
    config = run.config
    model = config.models.get("orchestrator", "")
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM.replace("{max_agents}", str(config.maxAgents))},
        {"role": "user", "content": run.request.task},
    ]
    steps: list[dict[str, Any]] | None = None
    for attempt in range(3):
        reply, _, _ = await ask(run, model, messages)
        text = str(reply.get("content") or "")
        try:
            candidate = parse_plan(text, config)
        except (ValueError, TypeError):
            messages += [{"role": "assistant", "content": text}, {"role": "user", "content": "That was not a valid JSON array of steps. Reply with ONLY the JSON array."}]
            continue
        if len(candidate) <= config.maxAgents:
            steps = candidate
            break
        # Spec §06: the sidecar rejects an over-cap plan and re-plans.
        messages += [{"role": "assistant", "content": text},
                     {"role": "user", "content": f"Your plan has {len(candidate)} steps but the maximum is {config.maxAgents}. Merge steps and reply with at most {config.maxAgents}."}]
        if attempt == 2:
            steps = candidate[: config.maxAgents]
    await run.emit("orchestrator_plan", steps=steps or fallback_plan(config))
    return {**state, "steps": steps or fallback_plan(config)}


async def approve_node(state: dict[str, Any]) -> dict[str, Any]:
    """Pre-flight approval (spec §06): no worker starts before the user approves."""
    run: Run = state["run"]
    try:
        approved, reason = await run.wait_for_approval("orchestrator", "Orchestrator", run.config.models.get("orchestrator", ""),
                                                        "approve_plan", "multi-agent", {"steps": state["steps"]})
    except AgentFailed:
        approved, reason = False, "approval timed out"
    if not approved:
        await run.emit("task_failed", reason=f"Plan not approved{': ' + reason if reason else ''}", partialOutputs={})
    return {**state, "approved": approved}


# ── Workers + reflection ─────────────────────────────────────────────────────

def split_tool_name(name: str, allowed: set[str]) -> tuple[str, str]:
    if name not in allowed:
        raise ValueError(f"tool '{name}' was not offered to this agent")
    server, _, local = name.partition("__")
    if not local:
        raise ValueError(f"tool '{name}' is not an Electron MCP namespaced tool")
    return server, local


async def run_worker(run: Run, step: dict[str, Any], prior: dict[str, str]) -> str:
    config = run.config
    agent_id, role, model = step["id"], step["role"], step["model"]
    allowed_tools = {str(t.get("name")) for t in run.request.tools}
    agent_tokens = 0
    agent_cost = 0.0
    await run.emit("agent_start", agentId=agent_id, role=role, model=model)

    context = ""
    if prior:
        context = "\n\nResults from earlier phases (cite them by marker if you rely on them):\n" + "\n\n".join(f"[{k}] {v}" for k, v in prior.items())
    feedback = ""
    last_reason = ""
    for attempt in range(config.maxRetriesPerAgent + 1):
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": f"You are the {role} agent in a multi-agent team. Work independently on your subtask. "
                                          "Use the supplied tools only when you need evidence. Never claim to have executed anything you did not."},
            {"role": "user", "content": f"Overall task: {run.request.task}\n\nYour subtask ({agent_id}): {step['label']}{context}{feedback}"},
        ]

        async def on_token(text: str) -> None:
            await run.emit("agent_token", agentId=agent_id, token=text)

        output = ""
        try:
            for _round in range(MAX_TOOL_ROUNDS):
                last_round = _round == MAX_TOOL_ROUNDS - 1
                reply, tokens, cost = await ask(run, model, messages, tools=None if last_round else (run.request.tools or None), on_token=on_token)
                agent_tokens += tokens
                agent_cost += cost
                calls = reply.get("tool_calls") or []
                if not calls:
                    output = str(reply.get("content") or "")
                    break
                messages.append({"role": "assistant", "content": reply.get("content") or "", "tool_calls": calls})
                for call in calls:
                    fn = call.get("function") or {}
                    name = str(fn.get("name") or "")
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                        if not isinstance(args, dict):
                            raise ValueError("tool arguments must be a JSON object")
                        server, local = split_tool_name(name, allowed_tools)
                    except (ValueError, TypeError) as exc:
                        content = f"Tool request rejected: {exc}"
                    else:
                        approved, result = await run.wait_for_approval(agent_id, role, model, local, server, args)
                        content = result if approved else f"Tool request denied: {result or 'denied by user'}"
                    messages.append({"role": "tool", "tool_call_id": call.get("id") or name, "content": content})
        except BudgetReached:
            if not output:
                raise AgentFailed("budget cap reached before this agent produced an answer") from None
        if not output:
            raise AgentFailed("no final answer after the maximum number of tool rounds")
        await run.emit("agent_complete", agentId=agent_id, output=output, tokenCount=agent_tokens, costUsd=round(agent_cost, 8))

        if run.budget_reached:
            return output  # no reflection spend once the cap is reached; output kept as-is
        await run.emit("reflection_start", agentId=agent_id)
        try:
            verdict, _, _ = await ask(run, config.models.get("reflection", ""), [
                {"role": "system", "content": "You are a strict reviewer. Score how well the output accomplishes the subtask, 1 (useless) to 5 (excellent). "
                                              "Reply with JSON only: {\"score\": <1-5>, \"reason\": \"<one sentence>\"}"},
                {"role": "user", "content": f"Overall task: {run.request.task}\nSubtask: {step['label']}\n\nOutput:\n{output}"},
            ])
        except BudgetReached:
            return output
        try:
            judgement = json.loads(re.search(r"\{.*\}", str(verdict.get("content") or ""), re.S).group(0))  # type: ignore[union-attr]
            score = max(1, min(5, int(judgement.get("score", 3))))
            reason = str(judgement.get("reason") or "No reason supplied")
        except (AttributeError, ValueError, TypeError):
            score, reason = 3, "Reflection reply was not valid JSON; scored neutral"
        passed = score >= config.reflectionPassThreshold
        await run.emit("reflection_result", agentId=agent_id, score=score, passed=passed, reason=reason)
        if passed:
            return output
        last_reason = f"score {score}/5: {reason}"
        if attempt < config.maxRetriesPerAgent:
            await run.emit("retry", agentId=agent_id, attempt=attempt + 1, reason=reason)
            feedback = f"\n\nYour previous attempt was rejected by the reviewer ({last_reason}). Address that and try again."
    raise AgentFailed(f"reflection retry limit exceeded ({last_reason})")


async def workers_node(state: dict[str, Any]) -> dict[str, Any]:
    run: Run = state["run"]
    steps: list[dict[str, Any]] = state["steps"]
    outputs: dict[str, str] = {}
    failures: dict[str, str] = {}
    for phase in sorted({s["phase"] for s in steps}):
        phase_steps = [s for s in steps if s["phase"] == phase]
        if run.budget_reached:
            for s in phase_steps:
                failures[s["id"]] = "not started — budget cap reached"
                await run.emit("agent_failed", agentId=s["id"], reason=failures[s["id"]])
            continue
        prior = dict(outputs)
        results = await asyncio.gather(*(run_worker(run, s, prior) for s in phase_steps), return_exceptions=True)
        for step, result in zip(phase_steps, results):
            if isinstance(result, str):
                outputs[step["id"]] = result
            elif isinstance(result, asyncio.CancelledError):
                raise result
            else:
                reason = str(result) or type(result).__name__
                failures[step["id"]] = reason
                await run.emit("agent_failed", agentId=step["id"], reason=reason)
    return {**state, "outputs": outputs, "failures": failures}


# ── Synthesis ────────────────────────────────────────────────────────────────

async def synthesize_node(state: dict[str, Any]) -> dict[str, Any]:
    run: Run = state["run"]
    outputs: dict[str, str] = state["outputs"]
    failures: dict[str, str] = state["failures"]
    steps = {s["id"]: s for s in state["steps"]}
    await run.emit("synthesis_start")
    if not outputs:
        await run.emit("task_failed", reason="No agent produced an output", partialOutputs={})
        return state

    sources = "\n\n".join(f"[{agent_id}] ({steps[agent_id]['role']}: {steps[agent_id]['label']})\n{text}" for agent_id, text in outputs.items())
    missing = "".join(f"\n- [{agent_id}] failed: {reason}" for agent_id, reason in failures.items())
    prompt = [
        {"role": "system", "content": "You synthesize a multi-agent team's work into one final answer for the user. "
                                      "Cite every factual contribution with its source agent marker exactly as given, e.g. [1.1]. "
                                      "Do not invent markers. If some agents failed, say what is missing."},
        {"role": "user", "content": f"Task: {run.request.task}\n\nAgent outputs:\n\n{sources}" + (f"\n\nFailed agents:{missing}" if missing else "")},
    ]

    async def on_token(text: str) -> None:
        await run.emit("synthesis_token", token=text)

    try:
        reply, _, _ = await ask(run, run.config.models.get("synthesizer", ""), prompt, on_token=on_token, synthesis=True)
        final = str(reply.get("content") or "")
    except BudgetReached:
        # Remaining budget cannot cover even a short synthesis: deliver the
        # partial outputs verbatim, provenance intact, with zero extra spend.
        final = "Budget cap reached — partial results from the agents that finished:\n\n" + "\n\n".join(f"[{k}] {v}" for k, v in outputs.items())
        await run.emit("synthesis_token", token=final)
    await run.emit("task_complete", finalOutput=final, totalCostUsd=round(run.total_cost, 8), totalTokens=run.total_tokens)
    return state


def build_graph() -> Any:
    graph = StateGraph(dict)
    graph.add_node("plan", plan_node)
    graph.add_node("approve", approve_node)
    graph.add_node("workers", workers_node)
    graph.add_node("synthesize", synthesize_node)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "approve")
    graph.add_conditional_edges("approve", lambda s: "workers" if s.get("approved") else END, {"workers": "workers", END: END})
    graph.add_edge("workers", "synthesize")
    graph.add_edge("synthesize", END)
    return graph.compile()


GRAPH = build_graph()


async def orchestrate(run: Run) -> None:
    try:
        await GRAPH.ainvoke({"run": run})
    except asyncio.CancelledError:
        await run.emit("task_failed", reason="Run aborted by user", partialOutputs={})
    except BudgetReached:
        await run.emit("task_failed", reason="Budget cap reached before planning finished", partialOutputs={})
    except Exception as exc:  # noqa: BLE001 — every failure must reach the UI as a terminal event
        await run.emit("task_failed", reason=str(exc) or type(exc).__name__, partialOutputs={})
    finally:
        if not run.finished:
            await run.emit("task_failed", reason="Run ended without a result", partialOutputs={})
        asyncio.get_running_loop().call_later(RUN_RETENTION_S, RUNS.pop, run.run_id, None)


# ── HTTP API (spec §03) ──────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "runs": sum(1 for r in RUNS.values() if not r.finished)}


@app.post("/run")
async def create_run(request: RunRequest) -> dict[str, str]:
    if request.runId in RUNS:
        raise HTTPException(409, "run id already exists")
    run = Run(request.runId, request)
    RUNS[run.run_id] = run
    run.task = asyncio.create_task(orchestrate(run))
    return {"runId": run.run_id}


@app.get("/run/{run_id}/stream")
async def stream(run_id: str) -> StreamingResponse:
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    for event in run.events:  # replay, then live — atomic (no await between)
        queue.put_nowait(event)
    if run.finished:
        queue.put_nowait(None)
    else:
        run.subscribers.append(queue)

    async def events() -> Any:
        try:
            while (event := await queue.get()) is not None:
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            if queue in run.subscribers:
                run.subscribers.remove(queue)

    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/run/{run_id}/hitl")
async def hitl(run_id: str, response: HitlResponse) -> dict[str, bool]:
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    future = run.approvals.get(response.agentId)
    if not future or future.done():
        raise HTTPException(409, "agent is not waiting for approval")
    future.set_result((response.approved, response.result or ""))
    await run.emit("hitl_resume", agentId=response.agentId, approved=response.approved)
    return {"ok": True}


@app.delete("/run/{run_id}")
async def abort(run_id: str) -> dict[str, bool]:
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    run.cancelled = True
    for future in run.approvals.values():
        if not future.done():
            future.cancel()
    if run.task and not run.task.done():
        run.task.cancel()
    else:
        await run.emit("task_failed", reason="Run aborted by user", partialOutputs={})
    return {"ok": True}


def _exit_when_parent_dies() -> None:
    """Electron holds our stdin; EOF means it quit or crashed — never orphan (DoD D8)."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    finally:
        os._exit(0)


if __name__ == "__main__":
    import uvicorn

    if not TOKEN:
        raise SystemExit("DI_MULTI_AGENT_TOKEN is required")
    threading.Thread(target=_exit_when_parent_dies, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
