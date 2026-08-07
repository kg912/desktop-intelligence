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


class HitlResponse(BaseModel):
    runId: str
    agentId: str
    approved: bool


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

    async def emit(self, event_type: str, **payload: Any) -> None:
        self.seq += 1
        event = {"runId": self.run_id, "seq": self.seq, "ts": int(time.time() * 1000), "type": event_type, **payload}
        self.events.append(event)
        for subscriber in list(self.subscribers):
            await subscriber.put(event)


RUNS: dict[str, Run] = {}
app = FastAPI(title="Desktop Intelligence Multi-Agent Sidecar")


def _request_openrouter(model: str, messages: list[dict[str, str]]) -> tuple[str, int, float]:
    if not OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is not configured")
    body = json.dumps({"model": model, "messages": messages, "temperature": 0.2}).encode()
    request = Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}", "Content-Type": "application/json", "HTTP-Referer": "https://desktop-intelligence.local"},
    )
    with urlopen(request, timeout=90) as response:  # nosec B310 — fixed allowlisted URL
        data = json.loads(response.read().decode())
    choice = data["choices"][0]["message"].get("content", "")
    usage = data.get("usage", {})
    tokens = int(usage.get("total_tokens", 0))
    # OpenRouter may omit cost. We never invent a price; absent cost is zero.
    cost = float(usage.get("cost", 0) or 0)
    return choice, tokens, cost


async def ask(model: str, system: str, user: str) -> tuple[str, int, float]:
    return await asyncio.to_thread(_request_openrouter, model, [{"role": "system", "content": system}, {"role": "user", "content": user}])


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


async def orchestrate(run: Run) -> None:
    request = run.request
    config = request.config
    try:
        plan_text, tokens, cost = await ask(
            config.models.get("orchestrator", ""),
            f"You are an orchestration planner. Return ONLY a JSON list of at most {config.maxAgents} independent worker steps. Each object has label, role, phase.",
            request.task,
        )
        run.total_tokens += tokens; run.total_cost += cost
        steps = parse_plan(plan_text, config, request.task)
        await run.emit("orchestrator_plan", steps=steps)

        outputs: dict[str, str] = {}
        for phase in sorted({step["phase"] for step in steps}):
            phase_steps = [step for step in steps if step["phase"] == phase]
            results = await asyncio.gather(*(run_worker(run, step, outputs) for step in phase_steps), return_exceptions=True)
            for step, result in zip(phase_steps, results):
                if isinstance(result, str): outputs[step["id"]] = result
                elif isinstance(result, Exception):
                    await run.emit("task_failed", reason=f"{step['id']}: {result}", partialOutputs=outputs)

        if run.cancelled: return
        await run.emit("synthesis_start")
        synthesis_prompt = "Combine these worker outputs into a concise final answer. Cite each factual contribution with its source agent marker like [1.1].\n\n" + "\n\n".join(f"[{agent_id}] {output}" for agent_id, output in outputs.items())
        final, tokens, cost = await ask(config.models.get("synthesizer", ""), "You are a careful synthesizer.", synthesis_prompt)
        run.total_tokens += tokens; run.total_cost += cost
        for token in re.findall(r"\S+\s*", final): await run.emit("synthesis_token", token=token)
        await run.emit("task_complete", finalOutput=final, totalCostUsd=run.total_cost, totalTokens=run.total_tokens)
    except Exception as exc:
        await run.emit("task_failed", reason=str(exc), partialOutputs={})
    finally:
        for subscriber in list(run.subscribers): await subscriber.put(None)


async def run_worker(run: Run, step: dict[str, Any], outputs: dict[str, str]) -> str:
    config = run.request.config
    agent_id = step["id"]
    await run.emit("agent_start", agentId=agent_id, role=step["role"], model=step["model"])
    feedback = ""
    for attempt in range(config.maxRetriesPerAgent + 1):
        if run.cancelled: raise RuntimeError("run aborted")
        output, tokens, cost = await ask(step["model"], f"You are {step['role']}. Work independently. Do not execute tools or shell commands; describe any needed evidence.", f"Task: {run.request.task}\nSubtask: {step['label']}\n{feedback}")
        run.total_tokens += tokens; run.total_cost += cost
        for token in re.findall(r"\S+\s*", output): await run.emit("agent_token", agentId=agent_id, token=token)
        await run.emit("agent_complete", agentId=agent_id, output=output, tokenCount=tokens, costUsd=cost)
        await run.emit("reflection_start", agentId=agent_id)
        reflection, rtokens, rcost = await ask(config.models.get("reflection", ""), "Score the worker output from 1 to 5. Return JSON only: {score:number, reason:string}.", f"Goal: {run.request.task}\nOutput: {output}")
        run.total_tokens += rtokens; run.total_cost += rcost
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
