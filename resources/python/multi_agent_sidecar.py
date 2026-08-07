"""Desktop Intelligence multi-agent sidecar.

This is intentionally a localhost-only reasoning service. It cannot execute
host commands or connect to MCP transports: Electron owns tools and HITL.
The process is launched through SandboxService with only openrouter.ai allowed.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

try:  # LangGraph is the durable orchestration primitive when installed.
    from langgraph.graph import StateGraph, START, END  # type: ignore
except ImportError as exc:  # Startup remains explicit and observable.
    raise RuntimeError("Missing multi-agent dependencies. Install resources/python/requirements-multi-agent.txt") from exc


PORT = int(os.environ.get("DI_MULTI_AGENT_PORT", "7823"))
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")


class Config(BaseModel):
    maxAgents: int = Field(ge=1, le=8)
    budgetCapUsd: float = Field(ge=0)
    models: dict[str, str]
    reflectionPassThreshold: int = Field(ge=1, le=5)
    maxRetriesPerAgent: int = Field(ge=0, le=5)
    hitlTimeoutMs: int = Field(ge=1_000)
    requirePermissions: bool = True


class RunRequest(BaseModel):
    runId: str
    chatId: str
    task: str = Field(min_length=1)
    config: Config
    tools: list[dict[str, Any]] = Field(default_factory=list)


class HitlResponse(BaseModel):
    runId: str
    agentId: str
    approved: bool
    result: str = ""


@dataclass
class Run:
    run_id: str
    request: RunRequest
    seq: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    subscribers: list[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=list)
    cancelled: bool = False
    task: asyncio.Task[None] | None = None
    total_cost: float = 0.0
    total_tokens: int = 0
    budget_reached: bool = False
    approvals: dict[str, asyncio.Future[tuple[bool, str]]] = field(default_factory=dict)

    async def emit(self, event_type: str, **payload: Any) -> None:
        self.seq += 1
        event = {"runId": self.run_id, "seq": self.seq, "ts": int(time.time() * 1000), "type": event_type, **payload}
        self.events.append(event)
        for subscriber in list(self.subscribers):
            await subscriber.put(event)

    async def wait_for_approval(self, agent_id: str, role: str, tool_name: str, server_name: str, args: dict[str, Any]) -> tuple[bool, str]:
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self.approvals[agent_id] = future
        await self.emit("hitl_pause", agentId=agent_id, role=role, toolName=tool_name, serverName=server_name, args=args)
        try:
            return await asyncio.wait_for(future, timeout=self.request.config.hitlTimeoutMs / 1000)
        except asyncio.TimeoutError:
            return False, "approval timed out"
        finally:
            self.approvals.pop(agent_id, None)


RUNS: dict[str, Run] = {}
app = FastAPI(title="Desktop Intelligence Multi-Agent Sidecar")


def _request_openrouter(model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], int, float]:
    if not OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is not configured")
    payload: dict[str, Any] = {"model": model, "messages": messages, "temperature": 0.2}
    if tools:
        payload["tools"] = [{"type": "function", "function": tool} for tool in tools]
        payload["tool_choice"] = "auto"
    body = json.dumps(payload).encode()
    request = Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json", "HTTP-Referer": "https://desktop-intelligence.local"},
    )
    with urlopen(request, timeout=90) as response:  # nosec B310 — fixed allowlisted URL
        data = json.loads(response.read().decode())
    message = data["choices"][0]["message"]
    usage = data.get("usage", {})
    tokens = int(usage.get("total_tokens", 0))
    # OpenRouter may omit cost. We never invent a price; absent cost is zero.
    cost = float(usage.get("cost", 0) or 0)
    return message, tokens, cost


async def ask(model: str, system: str, user: str, tools: list[dict[str, Any]] | None = None, messages: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], int, float]:
    prompt = messages or [{"role": "system", "content": system}, {"role": "user", "content": user}]
    return await asyncio.to_thread(_request_openrouter, model, prompt, tools)


def account(run: Run, tokens: int, cost: float) -> None:
    run.total_tokens += tokens
    run.total_cost += cost
    if run.total_cost >= run.request.config.budgetCapUsd:
        run.budget_reached = True


def split_tool_name(name: str) -> tuple[str, str]:
    if "__" not in name:
        raise ValueError(f"Tool '{name}' is not an Electron MCP namespaced tool")
    return tuple(name.split("__", 1))  # type: ignore[return-value]


def fallback_plan(task: str, config: Config) -> list[dict[str, Any]]:
    labels = ["Analyze the task", "Research supporting evidence", "Review risks and recommendations"]
    count = min(config.maxAgents, max(2, min(len(labels), 3)))
    return [{"id": f"1.{index + 1}", "label": labels[index], "stage": "worker", "role": "Analyst", "model": config.models.get("worker", ""), "phase": 1} for index in range(count)]


def parse_plan(text: str, config: Config, task: str) -> list[dict[str, Any]]:
    try:
        raw = json.loads(re.search(r"\[.*\]", text, re.S).group(0))  # type: ignore[union-attr]
        if not isinstance(raw, list): raise ValueError("plan is not a list")
        steps = []
        for index, item in enumerate(raw[:config.maxAgents]):
            steps.append({"id": str(item.get("id", f"1.{index + 1}")), "label": str(item.get("label", "Investigate subtask")), "stage": "worker", "role": str(item.get("role", "Analyst")), "model": config.models.get("worker", ""), "phase": int(item.get("phase", 1))})
        return steps or fallback_plan(task, config)
    except Exception:
        return fallback_plan(task, config)


async def run_graph_body(run: Run) -> None:
    request = run.request
    config = request.config
    try:
        plan_message, tokens, cost = await ask(
            config.models.get("orchestrator", ""),
            f"You are an orchestration planner. Return ONLY a JSON list of at most {config.maxAgents} independent worker steps. Each object has label, role, phase.",
            request.task,
        )
        account(run, tokens, cost)
        steps = parse_plan(str(plan_message.get("content") or ""), config, request.task)
        await run.emit("orchestrator_plan", steps=steps)
        approved, reason = await run.wait_for_approval("orchestrator", "Orchestrator", "approve_plan", "multi-agent", {"steps": steps})
        if not approved:
            await run.emit("task_failed", reason=f"Plan not approved: {reason}", partialOutputs={})
            return

        outputs: dict[str, str] = {}
        for phase in sorted({step["phase"] for step in steps}):
            if run.budget_reached:
                break
            phase_steps = [step for step in steps if step["phase"] == phase]
            results = await asyncio.gather(*(run_worker(run, step, outputs) for step in phase_steps), return_exceptions=True)
            for step, result in zip(phase_steps, results):
                if isinstance(result, str): outputs[step["id"]] = result
                elif isinstance(result, Exception):
                    await run.emit("task_failed", reason=f"{step['id']}: {result}", partialOutputs=outputs)

        if run.cancelled: return
        await run.emit("synthesis_start")
        synthesis_prompt = "Combine these worker outputs into a concise final answer. Cite each factual contribution with its source agent marker like [1.1].\n\n" + "\n\n".join(f"[{agent_id}] {output}" for agent_id, output in outputs.items())
        final_message, tokens, cost = await ask(config.models.get("synthesizer", ""), "You are a careful synthesizer.", synthesis_prompt)
        account(run, tokens, cost)
        final = str(final_message.get("content") or "Partial synthesis unavailable.")
        for token in re.findall(r"\S+\s*", final): await run.emit("synthesis_token", token=token)
        await run.emit("task_complete", finalOutput=final, totalCostUsd=run.total_cost, totalTokens=run.total_tokens)
    except Exception as exc:
        await run.emit("task_failed", reason=str(exc), partialOutputs={})
    finally:
        for subscriber in list(run.subscribers): await subscriber.put(None)


async def orchestrate(run: Run) -> None:
    """Run orchestration through LangGraph, keeping state transitions explicit.

    The graph deliberately owns only trusted orchestration state. Tool execution
    remains a HITL round-trip to Electron and never runs in this process.
    """
    graph = StateGraph(dict)

    async def execute(state: dict[str, Any]) -> dict[str, Any]:
        await run_graph_body(state["run"])
        return state

    graph.add_node("execute", execute)
    graph.add_edge(START, "execute")
    graph.add_edge("execute", END)
    await graph.compile().ainvoke({"run": run})


async def run_worker(run: Run, step: dict[str, Any], outputs: dict[str, str]) -> str:
    config = run.request.config
    agent_id = step["id"]
    await run.emit("agent_start", agentId=agent_id, role=step["role"], model=step["model"])
    feedback = ""
    for attempt in range(config.maxRetriesPerAgent + 1):
        if run.cancelled: raise RuntimeError("run aborted")
        if run.budget_reached:
            raise RuntimeError("budget cap reached before worker start")
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": f"You are {step['role']}. Work independently. Use only supplied MCP tools when evidence is needed. Never execute host commands."},
            {"role": "user", "content": f"Task: {run.request.task}\nSubtask: {step['label']}\n{feedback}"},
        ]
        output = ""
        for _tool_round in range(4):
            message, tokens, cost = await ask(step["model"], "", "", run.request.tools, messages)
            account(run, tokens, cost)
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                output = str(message.get("content") or "")
                break
            messages.append({"role": "assistant", "content": message.get("content") or "", "tool_calls": tool_calls})
            for call in tool_calls:
                function = call.get("function", {})
                tool_name = str(function.get("name") or "")
                try:
                    args = json.loads(function.get("arguments") or "{}")
                    if not isinstance(args, dict): raise ValueError("tool arguments must be an object")
                    server_name, local_name = split_tool_name(tool_name)
                    approved, result = await run.wait_for_approval(agent_id, step["role"], local_name, server_name, args)
                    content = result if approved else f"Tool request denied: {result}"
                except Exception as exc:
                    content = f"Tool request rejected: {exc}"
                messages.append({"role": "tool", "tool_call_id": call.get("id", tool_name), "content": content})
        if not output:
            output = "Worker did not produce a final response after tool calls."
        for token in re.findall(r"\S+\s*", output): await run.emit("agent_token", agentId=agent_id, token=token)
        await run.emit("agent_complete", agentId=agent_id, output=output, tokenCount=tokens, costUsd=cost)
        await run.emit("reflection_start", agentId=agent_id)
        reflection_message, rtokens, rcost = await ask(config.models.get("reflection", ""), "Score the worker output from 1 to 5. Return JSON only: {score:number, reason:string}.", f"Goal: {run.request.task}\nOutput: {output}")
        account(run, rtokens, rcost)
        reflection = str(reflection_message.get("content") or "")
        try: judgement = json.loads(re.search(r"\{.*\}", reflection, re.S).group(0))  # type: ignore[union-attr]
        except Exception: judgement = {"score": 3, "reason": "Reflection response was not structured"}
        score = max(1, min(5, int(judgement.get("score", 3))))
        passed = score >= config.reflectionPassThreshold
        reason = str(judgement.get("reason", "No reason supplied"))
        await run.emit("reflection_result", agentId=agent_id, score=score, passed=passed, reason=reason)
        if passed: return output
        if attempt < config.maxRetriesPerAgent:
            await run.emit("retry", agentId=agent_id, attempt=attempt + 1, reason=reason)
            feedback = f"Prior attempt was rejected: {reason}. Improve it."
    raise RuntimeError("reflection retry limit exceeded")


@app.get("/health")
async def health() -> dict[str, bool]: return {"ok": True}


@app.post("/run")
async def create_run(request: RunRequest) -> dict[str, str]:
    if request.runId in RUNS: raise HTTPException(409, "run id already exists")
    run = Run(request.runId, request)
    RUNS[run.run_id] = run
    run.task = asyncio.create_task(orchestrate(run))
    return {"runId": run.run_id}


@app.get("/run/{run_id}/stream")
async def stream(run_id: str) -> StreamingResponse:
    run = RUNS.get(run_id)
    if not run: raise HTTPException(404, "run not found")
    async def events():
        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        for event in run.events: await queue.put(event)
        run.subscribers.append(queue)
        try:
            while (event := await queue.get()) is not None:
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            if queue in run.subscribers: run.subscribers.remove(queue)
    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/run/{run_id}/hitl")
async def hitl(run_id: str, response: HitlResponse) -> dict[str, bool]:
    run = RUNS.get(run_id)
    if not run: raise HTTPException(404, "run not found")
    future = run.approvals.get(response.agentId)
    if future and not future.done(): future.set_result((response.approved, response.result or ""))
    await run.emit("hitl_resume", agentId=response.agentId, approved=response.approved)
    return {"ok": True}


@app.delete("/run/{run_id}")
async def abort(run_id: str) -> dict[str, bool]:
    run = RUNS.get(run_id)
    if not run: raise HTTPException(404, "run not found")
    run.cancelled = True
    if run.task: run.task.cancel()
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
