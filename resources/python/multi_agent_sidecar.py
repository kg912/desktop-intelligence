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
import html
import json
import math
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal
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

# Sent as the last message of a finite run's forced wrap-up round (tools disabled).
TOOL_BUDGET_USED = "Tool budget used. Write your findings from the results above. No more tool calls."
NO_ANSWER_NUDGE = "Your last reply contained no answer. Write your findings as plain text, not as a tool call."
# A reply that is only tool-call-shaped text (the model "calling" a tool in prose) is no answer.
# ponytail: covers the common text formats (<tool_call>, <function=…>, [TOOL_CALLS], bare {"name": …} JSON); add a format when a model leaks a new one.
TOOL_TEXT_RE = re.compile(r"<tool_call>.*?(?:</tool_call>|$)|<function[=\s].*?(?:</function>|$)|\[TOOL_CALLS\].*"
                          r"|```(?:json)?\s*\{\s*\"(?:name|tool|function)\".*?```|\{\s*\"(?:name|tool|function)\"\s*:.*\}", re.S | re.I)


def is_no_answer(text: str) -> bool:
    return not TOOL_TEXT_RE.sub("", text).strip()

# urllib's timeout is per socket operation (connect, each read), not per request: a long
# generation keeps streaming chunks (and OpenRouter sends ": PROCESSING" keep-alives while
# the model thinks), so this only ends a stream that has gone silent for 120 s.
REQUEST_TIMEOUT_S = 120
RUN_RETENTION_S = 600
# Budget held back so a partial synthesis can always run within the cap.
SYNTHESIS_RESERVE_PROMPT_TOKENS = 6_000
SYNTHESIS_RESERVE_COMPLETION_TOKENS = 1_500
# No fixed output caps: max_tokens is bounded only by the budget allowance (which keeps the
# per-run cap honest) and the model's remaining context window; unpriced models get none.
# Below this a request is not worth sending; it waits for budget or the cap is reached.
MIN_REQUEST_TOKENS = 16
# Trace previews (spec refinement Phase 2); full tool results stay in message history.
ARGS_PREVIEW_CHARS = 400
RESULT_PREVIEW_CHARS = 1_200
# Call records (observability spec §3.1): any longer string field is cut, and the record says so.
RECORD_FIELD_CAP_CHARS = 2_000_000
# Literal end-of-sequence tokens some models leak (same set ChatService strips): never in output.
EOS_RE = re.compile(r"<\|(?:endoftext|im_end|eot_id|end)\|>", re.I)
# DeepSeek may emit tool calls as DSML text in delta.content instead of delta.tool_calls.
DSML_MARK = "<|DSML|"
_BAR = r"\s*[|\uff5c]\s*"
# Matched on the raw text, so the rest of the answer keeps its own pipes and spacing.
DSML_BLOCK_RE = re.compile(rf"<{_BAR}DSML{_BAR}tool_calls>.*?(?:</{_BAR}DSML{_BAR}tool_calls>|$)", re.S | re.I)
DSML_INVOKE_RE = re.compile(r'<\|DSML\|invoke\s+name="([^"]+)">(.*?)</\|DSML\|invoke>', re.S | re.I)
DSML_PARAM_RE = re.compile(r'<\|DSML\|parameter\s+name="([^"]+)"[^>]*>(.*?)</\|DSML\|parameter>', re.S | re.I)
REFLECTION_RUBRIC = [
    "Answers the subtask it was given",
    "Every factual claim carries a quote from a tool result that supports it, or is explicitly marked unverified; a claim marked unverified is not an issue",
    "No invented bookings, prices or timetables",
    "Consistent with the outputs of the earlier agents it depends on",
]


class Pricing(BaseModel):
    prompt: float = Field(ge=0)
    completion: float = Field(ge=0)
    contextLength: int = Field(default=0, ge=0)  # 0 = unknown


class Config(BaseModel):
    maxAgents: int = Field(ge=1, le=8)
    # None = unlimited: no forced wrap-up round; the budget cap, repetition guard and context window still stop a worker.
    maxToolRounds: int | None = Field(default=12, ge=1, le=50)
    budgetCapUsd: float = Field(ge=0)
    models: dict[str, str]
    reflectionPassThreshold: int = Field(ge=1, le=5)
    maxRetriesPerAgent: int = Field(ge=0, le=5)
    hitlTimeoutMs: int = Field(ge=1_000)
    requirePermissions: bool = True
    # The workers' reasoning effort (Settings → Worker reasoning); spec A Phase 8 default "low".
    reasoningEffort: Literal["off", "low", "medium", "high"] = "low"
    # The judge gets every tool result in full up to this many (estimated) tokens, else excerpts.
    # Clamped to half the judge model's context window when that is known.
    judgeEvidenceMaxTokens: int = Field(default=100_000, ge=0)
    # Retries exhausted: "degrade" passes the best attempt on with its open issues; "fail" fails the step (the old behaviour).
    onRetryExhausted: Literal["degrade", "fail"] = "degrade"
    # "snippet": claims cite [S<call>.<n>] ids and the sidecar fills the quote; "legacy": claims carry callId + quote (spec A Phase 2).
    claimFormat: Literal["snippet", "legacy"] = "snippet"
    # "excerpts" (default): the judge sees ±EXCERPT_RADIUS_CHARS around each cited quote; "full": every result when it fits (spec A Phase 3).
    judgeEvidenceMode: Literal["excerpts", "full"] = "excerpts"
    # OpenRouter provider routing (spec A Phase 8). "deny": only providers that do not collect prompts (Settings toggle).
    dataCollection: Literal["allow", "deny"] = "allow"
    # Config-file overrides by role (planner | worker | judge | synthesizer) of ROLE_MAX_TOKENS, ROLE_REASONING, provider prefs.
    maxTokensByRole: dict[str, int] = Field(default_factory=dict)
    reasoningByRole: dict[str, Literal["off", "low", "medium", "high"]] = Field(default_factory=dict)
    providerPrefs: dict[str, dict[str, Any]] = Field(default_factory=dict)


class RunRequest(BaseModel):
    runId: str = Field(min_length=1)
    chatId: str
    task: str = Field(min_length=1)
    config: Config
    tools: list[dict[str, Any]] = Field(default_factory=list)
    openRouterApiKey: str = Field(min_length=1)
    # USD per token, from Electron's OpenRouter catalogue. Missing = unknown.
    pricing: dict[str, Pricing] = Field(default_factory=dict)
    # Catalogue says these models take no `reasoning` parameter.
    noReasoning: list[str] = Field(default_factory=list)
    # Where each role's model came from (saved | default | active); echoed in run_config.
    modelSources: dict[str, str] = Field(default_factory=dict)
    catalogueChecked: bool = True
    # Electron's observabilityEnabled. Off: no call records, nothing copied.
    observe: bool = False
    # "Current date and time: …" computed by Electron in the user's timezone; the sandbox clock is not theirs.
    currentDateTime: str = Field(min_length=1)
    # Running MCP servers Electron did not offer to workers ({server, reason}); echoed in run_config.
    excludedServers: list[dict[str, str]] = Field(default_factory=list)


class HitlResponse(BaseModel):
    runId: str
    agentId: str
    approved: bool
    result: str = ""
    # Spec A Phase 9, sent by Electron for worker tool calls: how it was approved, the person's wait, the tool's own time.
    approvalMode: Literal["trusted", "asked", "auto"] | None = None
    waitMs: int | None = Field(default=None, ge=0)
    toolMs: int | None = Field(default=None, ge=0)


class BudgetReached(Exception):
    pass


class AgentFailed(Exception):
    pass


# Provider wording for "the request does not fit the model's context window".
CONTEXT_ERROR_RE = re.compile(r"context(?:[ _-]length| window)|maximum context|too many tokens|prompt is too long|tokens? exceeds?", re.I)


class ContextExceeded(AgentFailed):
    """The model's context window cannot hold the request: a clear agent failure, never a generic error."""


def provider_error(model: str, detail: str, prefix: str) -> Exception:
    if CONTEXT_ERROR_RE.search(detail):
        return ContextExceeded(f"Context window exceeded for {model}: {detail[:300]}")
    return RuntimeError(f"{prefix}: {detail[:300]}")


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
    total_cached: int = 0  # prompt tokens served from the provider's cache, where reported
    budget_reached: bool = False
    # Worst-case cost of requests in flight — parallel workers share the allowance.
    reserved: float = 0.0
    budget_changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    approvals: dict[str, asyncio.Future[tuple[bool, str]]] = field(default_factory=dict)
    # Worker tasks currently running; parallel requests split the free allowance between them.
    active_workers: int = 0
    executor: ThreadPoolExecutor | None = None
    started: float = field(default_factory=time.monotonic)
    # agentId → current 0-based attempt, so events emitted outside run_worker carry it too.
    attempts: dict[str, int] = field(default_factory=dict)
    record_seq: int = 0
    # agentId → callId → {name, args, ok, attempt, result}: every tool call in full (capped at
    # RECORD_FIELD_CAP_CHARS), kept apart from the message history so compacting it loses no evidence.
    evidence: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    # The user chose the quick fallback plan while the orchestrator was still planning (UI Goal 5).
    quick_plan: bool = False
    # agentId → {approvalMode, waitMs, toolMs} of its last answered tool approval (spec A Phase 9).
    approval_meta: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Spec B Phase 1: the planner's acceptance checklist ([] = ledger disabled), each ended step's final claims and
    # statuses ({"claims", "statuses"}; a failed step has none), and the coverage ledger computed from them.
    checklist: list[dict[str, Any]] = field(default_factory=list)
    step_results: dict[str, dict[str, Any]] = field(default_factory=dict)
    ledger: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def config(self) -> Config:
        return self.request.config

    def totals(self) -> dict[str, Any]:
        return {"costUsd": round(self.total_cost, 8), "tokens": self.total_tokens, "budgetReached": self.budget_reached,
                **({"cachedTokens": self.total_cached} if self.total_cached else {})}

    async def emit(self, event_type: str, **payload: Any) -> None:
        if self.finished:
            return  # exactly one terminal event, always last
        self.seq += 1
        event = {"runId": self.run_id, "seq": self.seq, "ts": int(time.time() * 1000),
                 "elapsedMs": int((time.monotonic() - self.started) * 1000), "type": event_type, **payload}
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

    def record(self, record: dict[str, Any]) -> None:
        """Publish one call record (observability spec §3.1) as an `obs_record` stream event.
        Not an AgentEvent: no seq, never shown in the UI. A logger failure never fails the run."""
        if not self.request.observe or self.finished:
            return
        try:
            self.record_seq += 1
            capped: list[dict[str, Any]] = []
            body = cap_fields({"schema": 1, "runId": self.run_id, "chatId": self.request.chatId, "seq": self.record_seq, **record}, "", capped)
            body["capped"] = capped or None
            event = {"runId": self.run_id, "type": "obs_record", "record": body}
            self.events.append(event)
            for subscriber in list(self.subscribers):
                subscriber.put_nowait(event)
        except Exception as exc:  # noqa: BLE001
            print(f"[obs] record dropped: {exc!r}", file=sys.stderr, flush=True)

    def attempt_of(self, agent_id: str) -> dict[str, int]:
        return {"attempt": self.attempts[agent_id]} if agent_id in self.attempts else {}

    async def wait_for_approval(self, agent_id: str, role: str, model: str, tool_name: str, server_name: str, args: dict[str, Any]) -> tuple[bool, str]:
        future: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self.approvals[agent_id] = future
        await self.emit("hitl_pause", agentId=agent_id, role=role, model=model, toolName=tool_name, serverName=server_name, args=args, **self.attempt_of(agent_id))
        try:
            return await asyncio.wait_for(future, timeout=self.config.hitlTimeoutMs / 1000)
        except asyncio.TimeoutError:
            # Spec §07: auto-deny on timeout; the UI must see the pause end.
            await self.emit("hitl_resume", agentId=agent_id, approved=False, **self.attempt_of(agent_id))
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

    def plan_request(self, model: str, messages: list[dict[str, Any]], *, synthesis: bool, cap: int | None = None) -> tuple[int | None, float, float, str | None]:
        """(max_tokens, worst-case cost, shortfall, binding limit) keeping total spend —
        including other in-flight requests' reservations — within the cap. max_tokens is
        the smaller of the budget allowance and the model's remaining context window;
        there is no fixed cap. None = not sent (unpriced: no budget bound, no known
        context). Workers running in parallel each get at most an equal share of the
        uncommitted allowance, so one request cannot reserve the whole cap and serialise
        the others. shortfall > 0 means even MIN_REQUEST_TOKENS do not fit. The binding
        limit ("budget" | "context") explains a finish_reason of "length"."""
        p = self.price(model)
        if not p or p.completion == 0:  # unpriced: only the role's cap bounds it (spec A Phase 8)
            return cap, 0.0, 0.0, "max_tokens" if cap is not None else None
        uncommitted = self.config.budgetCapUsd - self.total_cost - (0.0 if synthesis else self.synthesis_reserve())
        allowance = uncommitted - self.reserved
        if not synthesis:
            allowance = min(allowance, uncommitted / max(1, self.active_workers))
        prompt_tokens = estimate_tokens(json.dumps(messages))
        prompt_cost = prompt_tokens * p.prompt
        tokens = math.floor((allowance - prompt_cost) / p.completion)
        bound = "budget"
        if p.contextLength:  # 1.25x: estimate_tokens is len/4, real tokenisers can run denser
            room = p.contextLength - math.ceil(prompt_tokens * 1.25)
            if room < tokens:
                tokens, bound = room, "context"
        if cap is not None and cap < tokens:  # the role's max_tokens (spec A Phase 8); also shrinks the reservation
            tokens, bound = cap, "max_tokens"
        shortfall = max(0.0, prompt_cost + MIN_REQUEST_TOKENS * p.completion - (uncommitted - self.reserved))
        if not shortfall:  # the equal share may be tiny, but a minimal request still fits
            tokens = max(tokens, MIN_REQUEST_TOKENS)
        return tokens, prompt_cost + max(tokens, 0) * p.completion, shortfall, bound


RUNS: dict[str, Run] = {}
app = FastAPI(title="Desktop Intelligence Multi-Agent Sidecar", dependencies=[Depends(require_token)])


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


def now_ms() -> int:
    return int(time.time() * 1000)


def cap_fields(value: Any, path: str, capped: list[dict[str, Any]]) -> Any:
    """Copy with every string over RECORD_FIELD_CAP_CHARS cut and listed in `capped` (path, original length)."""
    if isinstance(value, str):
        if len(value) <= RECORD_FIELD_CAP_CHARS:
            return value
        capped.append({"field": path, "originalChars": len(value)})
        return value[:RECORD_FIELD_CAP_CHARS] + f"\n[cut at {RECORD_FIELD_CAP_CHARS} of {len(value)} chars]"
    if isinstance(value, dict):
        return {k: cap_fields(v, f"{path}.{k}" if path else k, capped) for k, v in value.items()}
    if isinstance(value, list):
        return [cap_fields(v, f"{path}[{i}]", capped) for i, v in enumerate(value)]
    return value


# ── Repetition guard ──────────────────────────────────────────────────────────
# Same idea as ChatService's detector (identical lines in a row), plus a word
# n-gram rule for loops that never emit a newline. Table rows and rules are
# skipped: they repeat by design.

LOOP_LINE_REPEATS = 3        # identical lines in a row (ChatService uses 3)
LOOP_LINE_MAX_CHARS = 200    # longer lines are prose, not a stuck skeleton
LOOP_NGRAM_REPEATS = 4       # the same run of words, back to back
LOOP_NGRAM_SIZES = range(3, 61)
LOOP_TAIL_CHARS = 4_000      # bound the work on a never-ending single line
WORD_RE = re.compile(r"\w+")


def is_structure_line(line: str) -> bool:
    """Markdown table rows and rules/fences — legitimately repetitive."""
    s = line.strip()
    return s.startswith("|") or s.count("|") >= 2 or not re.search(r"\w", s)


class RepetitionDetector:
    """Feed streamed text; feed() returns True once the stream is looping.
    One instance per stream (content or reasoning) per request."""

    def __init__(self) -> None:
        self.partial = ""
        self.last_line = ""
        self.line_repeats = 0
        self.words: list[str] = []  # words of completed non-structure lines (tail only)

    def feed(self, text: str) -> bool:
        *lines, self.partial = (self.partial + text).split("\n")
        for line in lines:
            if self._complete_line(line.strip()):
                return True
        tail = [] if is_structure_line(self.partial) else WORD_RE.findall(self.partial[-LOOP_TAIL_CHARS:])
        return self._ngram_loop(self.words + tail)

    def _complete_line(self, line: str) -> bool:
        if not line or is_structure_line(line):
            return False
        self.words = (self.words + WORD_RE.findall(line))[-LOOP_NGRAM_SIZES[-1] * LOOP_NGRAM_REPEATS:]
        if len(line) <= LOOP_LINE_MAX_CHARS and line == self.last_line:
            self.line_repeats += 1
            return self.line_repeats >= LOOP_LINE_REPEATS
        self.last_line, self.line_repeats = line, 1
        return False

    @staticmethod
    def _ngram_loop(words: list[str]) -> bool:
        end = len(words)
        for n in LOOP_NGRAM_SIZES:
            if n * LOOP_NGRAM_REPEATS > end:
                return False
            unit = words[end - n:]
            if all(words[end - (k + 1) * n:end - k * n] == unit for k in range(1, LOOP_NGRAM_REPEATS)):
                return True
        return False


# ── OpenRouter streaming client (runs in a worker thread) ─────────────────────

def _stream_openrouter(
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    max_tokens: int | None,
    on_delta: Callable[[str, str], None],
    cancelled: Callable[[], bool],
    reasoning_effort: str | None = None,
    loop_guard: bool = False,
    capture: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """on_delta(kind, text): kind is "content" or "reasoning". Reasoning is
    returned only as reasoning_details (for tool round-trips), never in content.
    loop_guard: abort the request when either stream starts looping; the message
    then carries "looped" (which stream) and keeps what was produced.
    capture: filled in place with what was really sent and received (observability),
    readable even if the request fails or is cancelled midway."""
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
    if reasoning_effort:
        payload["reasoning"] = {"effort": reasoning_effort}
    payload.update(extra or {})  # provider routing, session_id (spec A Phase 8)
    body = json.dumps(payload).encode()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://desktop-intelligence.local",
        "X-Title": "Desktop Intelligence",
    }
    request = Request(f"{OPENROUTER_BASE_URL}/chat/completions", data=body, headers=headers)
    if capture is not None:  # decoded from the exact bytes sent, never rebuilt
        sent = json.loads(body)
        capture.update(request={"messages": sent.pop("messages"), "params": sent,
                                "headers": {k: "[redacted]" if k == "Authorization" else v for k, v in headers.items()}},
                       content=[], reasoning=[], startedAt=now_ms())
    content: list[str] = []
    details: list[dict[str, Any]] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    usage: dict[str, Any] = {}
    finish_reason = ""
    # Fresh per request, so state never carries across tool rounds or attempts.
    guards = {"content": RepetitionDetector(), "reasoning": RepetitionDetector()} if loop_guard else {}
    looped = ""
    reasoning_chars = 0
    served = ""  # the model OpenRouter actually answered with (may differ from `model`)
    if capture is not None:
        capture.update(toolCalls=tool_calls, usage=usage)
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
                    raise provider_error(model, str(chunk["error"].get("message", chunk["error"])), "OpenRouter error")
                if chunk.get("usage"):
                    usage = chunk["usage"]
                served = served or str(chunk.get("model") or "")
                if capture is not None:
                    capture["usage"] = usage
                    capture.setdefault("modelServed", chunk.get("model"))
                    capture.setdefault("generationId", chunk.get("id"))
                for choice in chunk.get("choices") or []:
                    finish_reason = choice.get("finish_reason") or finish_reason
                    delta = choice.get("delta") or {}
                    if capture is not None:
                        capture["finishReason"] = finish_reason
                        if delta.get("content") or delta.get("reasoning") or delta.get("reasoning_details") or delta.get("tool_calls"):
                            capture.setdefault("firstTokenAt", now_ms())
                        capture["content"].append(delta.get("content") or "")  # raw: before EOS stripping
                    text = EOS_RE.sub("", delta.get("content") or "")
                    if text:
                        content.append(text)
                        on_delta("content", text)
                        if guards and guards["content"].feed(text):
                            looped = "content"
                    detail_text = ""
                    for detail in delta.get("reasoning_details") or []:
                        if not isinstance(detail, dict):
                            continue
                        detail_text += str(detail.get("text") or detail.get("summary") or "")
                        merge_reasoning_detail(details, detail)
                    # OpenRouter usually mirrors the same text in both fields: forward it once.
                    thought = delta.get("reasoning") or detail_text
                    if thought:
                        if capture is not None:
                            capture["reasoning"].append(thought)
                        on_delta("reasoning", thought)
                        reasoning_chars += len(thought)
                        if guards and guards["reasoning"].feed(thought):
                            looped = looped or "reasoning"
                    for call in delta.get("tool_calls") or []:
                        slot = tool_calls.setdefault(int(call.get("index", 0)), {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                        if call.get("id"):
                            slot["id"] = call["id"]
                        fn = call.get("function") or {}
                        slot["function"]["name"] += fn.get("name") or ""
                        slot["function"]["arguments"] += fn.get("arguments") or ""
                if looped:
                    break  # leaving the `with` closes the connection: the request is aborted
    except HTTPError as err:
        error_body = err.read().decode("utf-8", "replace")
        try:
            detail = json.loads(error_body).get("error", {}).get("message") or error_body
        except (ValueError, AttributeError):
            detail = error_body
        if capture is not None:
            capture["httpStatus"] = err.code
        raise provider_error(model, str(detail), f"OpenRouter HTTP {err.code}") from None
    finally:
        if capture is not None:
            capture["endedAt"] = now_ms()
    message: dict[str, Any] = {"role": "assistant", "content": EOS_RE.sub("", "".join(content))}
    if tool_calls:
        message["tool_calls"] = [tool_calls[i] for i in sorted(tool_calls)]
    if details:
        message["reasoning_details"] = details
    if finish_reason:
        message["finish_reason"] = finish_reason
    if served:
        message["model_served"] = served
    if looped:
        message["looped"] = looped
        if capture is not None:
            capture["looped"] = looped
        if not usage:  # aborted before the usage chunk: estimate, so the budget still counts it
            prompt = estimate_tokens(json.dumps(messages))
            completion = estimate_tokens(message["content"]) + math.ceil(reasoning_chars / 4)
            usage = {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}
    return message, usage


def merge_reasoning_detail(details: list[dict[str, Any]], chunk: dict[str, Any]) -> None:
    """Streamed reasoning_details arrive as fragments; rebuild whole entries
    (same index → concatenate text fields) so they can be sent back verbatim."""
    last = details[-1] if details else None
    if last is not None and last.get("index") == chunk.get("index") and last.get("type") == chunk.get("type"):
        for key, value in chunk.items():
            if key in ("text", "summary", "data") and isinstance(value, str):
                last[key] = str(last.get(key) or "") + value
            elif value is not None:
                last[key] = value
    else:
        details.append(dict(chunk))


def normalise_dsml(text: str) -> str:
    """Fullwidth bars (U+FF5C) and spaced pipes → the plain `<|DSML|` form ChatService also matches."""
    return re.sub(r"\s*\|\s*", "|", text.replace("\uff5c", "|"))


def extract_dsml(content: str) -> tuple[list[dict[str, Any]], str]:
    """(tool calls parsed from DSML text, content without the DSML block).
    Mirrors ChatService.parseDsmlToolCalls; an unfinished block is stripped too."""
    norm = normalise_dsml(content)
    if DSML_MARK.lower() not in norm.lower():
        return [], content
    calls = []
    for index, (name, inner) in enumerate(DSML_INVOKE_RE.findall(norm)):
        args = {k.strip(): v.strip() for k, v in DSML_PARAM_RE.findall(inner)}
        calls.append({"id": f"call_dsml_{index}", "type": "function", "function": {"name": name.strip(), "arguments": json.dumps(args)}})
    return calls, DSML_BLOCK_RE.sub("", content).strip()


class DsmlTokenFilter:
    """Streams tokens until a DSML block or the claims block starts, so neither reaches the card
    (the claims are reported with the reflection result). Holds back a tail that could start a marker,
    and trailing whitespace, which is dropped before a claims block so the card text equals the prose."""

    def __init__(self, emit: Callable[[str], Awaitable[None]]) -> None:
        self.emit, self.pending, self.suppressed = emit, "", False

    async def _send(self, text: str, keep_space: bool = False) -> str:
        """Emit text minus its trailing whitespace (unless keep_space); return what was held back."""
        body = text if keep_space else text.rstrip()
        if body:
            await self.emit(body)
        return text[len(body):]

    async def __call__(self, text: str) -> None:
        if self.suppressed:
            return
        self.pending += text
        for i, ch in enumerate(self.pending):
            if ch not in "<`":
                continue
            rest, marker = (normalise_dsml(self.pending[i:]), DSML_MARK) if ch == "<" else (self.pending[i:], CLAIMS_MARK)
            if rest.startswith(marker):
                self.suppressed, head, self.pending = True, self.pending[:i], ""
                await self._send(head, keep_space=marker == DSML_MARK)
                return
            if marker.startswith(rest):  # could still become a marker: wait for more text
                held = await self._send(self.pending[:i])
                self.pending = held + self.pending[i:]
                return
        self.pending = await self._send(self.pending)

    async def flush(self) -> None:
        if self.pending and not self.suppressed:
            await self.emit(self.pending)
        self.pending = ""


# ── Per-role request parameters (spec A Phase 8) ──────────────────────────────
ROLE_OF_OBS = {"planner": "planner", "worker": "worker", "reflection": "judge", "synthesis": "synthesizer"}
# Worker and synthesizer above the spec's 8k / 12k: in the Istanbul run 4 of 40 worker calls produced more than 8k
# completion tokens (up to 22.8k, mostly reasoning) and the synthesis 12.9k. These bound reservations, not answers.
ROLE_MAX_TOKENS = {"planner": 4_000, "worker": 12_000, "judge": 600, "synthesizer": 16_000}
ROLE_REASONING = {"planner": "medium", "judge": "low", "synthesizer": "medium"}  # the worker's comes from Settings
# Families that need explicit cache_control breakpoints; the rest (OpenAI, DeepSeek, Z.AI, Moonshot, Gemini 2.5+) cache automatically.
CACHE_EXPLICIT_RE = re.compile(r"^(anthropic/|qwen/|google/gemini-(1|2\.0))")


def role_max_tokens(config: Config, role: str) -> int:
    return config.maxTokensByRole.get(role, ROLE_MAX_TOKENS[role])


def role_effort(config: Config, role: str) -> str:
    return config.reasoningEffort if role == "worker" else config.reasoningByRole.get(role, ROLE_REASONING[role])


def provider_prefs(config: Config, role: str) -> dict[str, Any]:
    return {"require_parameters": True, "data_collection": config.dataCollection, **({"sort": "price"} if role == "judge" else {}),
            **config.providerPrefs.get(role, {})}


def cache_policy(model: str) -> str:
    return "explicit" if CACHE_EXPLICIT_RE.match(model) else "automatic"


def with_cache_breakpoints(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A wire copy with cache_control on the system prompt and on the last message, so the growing prefix is cached."""
    marked = [dict(m) for m in messages]
    for index in {0, len(marked) - 1}:
        if index < len(marked) and isinstance(marked[index].get("content"), str) and marked[index].get("role") in ("system", "user", "tool"):
            marked[index]["content"] = [{"type": "text", "text": marked[index]["content"], "cache_control": {"type": "ephemeral"}}]
    return marked


def fetch_generation(api_key: str, generation_id: str) -> dict[str, Any]:
    """OpenRouter's stats for one generation (cache backfill); {} on any failure."""
    try:
        request = Request(f"{OPENROUTER_BASE_URL}/generation?id={generation_id}", headers={"Authorization": f"Bearer {api_key}"})
        with urlopen(request, timeout=5) as response:  # nosec B310 — fixed URL
            return json.loads(response.read()).get("data") or {}
    except Exception:  # noqa: BLE001 — a missing backfill only leaves the cache fields empty
        return {}


async def ask(
    run: Run,
    model: str,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
    on_reasoning: Callable[[str], Awaitable[None]] | None = None,
    synthesis: bool = False,
    loop_guard: bool = False,
    obs: dict[str, Any] | None = None,
    stop: Callable[[], bool] | None = None,
    effort: str | None = None,
    max_tokens_cap: int | None = None,
) -> tuple[dict[str, Any], int, float]:
    """One paid request. Never starts once the budget is reached (spec §06).
    obs: who is calling (role, agentId, attempt, toolRound, retry), for the call record.
    effort / max_tokens_cap: override the role's reasoning effort and max_tokens bound (ROLE_REASONING, ROLE_MAX_TOKENS)."""
    role = ROLE_OF_OBS.get((obs or {}).get("role", "worker"), "worker")
    if run.cancelled:
        raise asyncio.CancelledError()
    if run.budget_reached and not synthesis:
        raise BudgetReached()
    cap = max_tokens_cap if max_tokens_cap is not None else role_max_tokens(run.config, role)
    async with run.budget_changed:
        while True:
            max_tokens, worst_case, shortfall, bound = run.plan_request(model, messages, synthesis=synthesis, cap=cap)
            if max_tokens is None or max_tokens >= MIN_REQUEST_TOKENS:
                run.reserved += worst_case
                break
            # Wait only if requests in flight hold enough that their release could
            # plausibly cover the gap; otherwise the cap is effectively reached.
            if run.reserved < shortfall / 2:
                run.budget_reached = True
                raise BudgetReached()
            await run.budget_changed.wait()  # a parallel request may finish under its reservation
            if run.budget_reached and not synthesis:
                raise BudgetReached()

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def push(kind: str, text: str = "") -> None:
        loop.call_soon_threadsafe(queue.put_nowait, (kind, text))

    # Each role's effort (spec A Phase 8), never sent to a model the catalogue says does not take the parameter.
    wanted = effort if effort is not None else role_effort(run.config, role)
    reasoning_effort = None if wanted == "off" or model in run.request.noReasoning else wanted
    agent_id = (obs or {}).get("agentId")
    extra: dict[str, Any] = {"provider": provider_prefs(run.config, role),
                             **({"session_id": f"{run.run_id}:{agent_id}"} if role in ("worker", "judge") and agent_id else {})}
    wire = with_cache_breakpoints(messages) if cache_policy(model) == "explicit" else messages

    capture: dict[str, Any] | None = {} if run.request.observe else None

    def work() -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            return _stream_openrouter(run.request.openRouterApiKey, model, wire, tools, max_tokens, push,
                                      lambda: run.cancelled or (stop is not None and stop()),
                                      reasoning_effort, loop_guard, capture, extra=extra)
        finally:
            push("done")

    try:
        future = loop.run_in_executor(run.executor, work)
        while (item := await queue.get())[0] != "done":
            kind, text = item
            if kind == "content" and on_token:
                await on_token(text)
            elif kind == "reasoning" and on_reasoning:
                await on_reasoning(text)
        message, usage = await future
    except BaseException as exc:
        if capture is not None:
            run.record(call_record(model, obs, capture, error=exc))
        async with run.budget_changed:
            run.release(worst_case)
        raise
    async with run.budget_changed:
        tokens, cost = run.account(model, usage)  # charge actual cost before releasing the reservation
        run.release(worst_case)
    if message.get("finish_reason") == "length":
        # Never silent: which limit ended it. Unpriced models had no max_tokens, so the model's own window did.
        message["truncated"] = bound or "context"
    details = usage.get("prompt_tokens_details") or {}
    if capture is not None and details.get("cached_tokens") is None and capture.get("generationId"):
        # The stream had no cache figures: ask OpenRouter's generation endpoint (only when the call is recorded).
        stats = await loop.run_in_executor(run.executor, fetch_generation, run.request.openRouterApiKey, str(capture["generationId"]))
        if stats:
            usage = {**usage, "prompt_tokens_details": {**details, "cached_tokens": stats.get("native_tokens_cached")},
                     **({"cache_discount": stats["cache_discount"]} if stats.get("cache_discount") is not None else {})}
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens")
    if cached:
        message["cached_tokens"] = int(cached)
        run.total_cached += int(cached)
    if capture is not None:
        run.record(call_record(model, obs, {**capture, "usage": usage}, cost=cost, truncated=message.get("truncated")))
    return message, tokens, cost


def call_record(model: str, obs: dict[str, Any] | None, capture: dict[str, Any], *, cost: float | None = None,
                truncated: str | None = None, error: BaseException | None = None) -> dict[str, Any]:
    """One model call as sent and received (observability spec §3.1). `capture` was filled by
    _stream_openrouter; a call that failed before sending has no request."""
    usage = capture.get("usage") or {}
    cancelled = isinstance(error, asyncio.CancelledError)
    started, ended = capture.get("startedAt"), capture.get("endedAt") or now_ms()
    return {
        "kind": "model",
        "role": "worker", "agentId": None, "attempt": 0, "toolRound": 0, **(obs or {}),
        "model": model,
        "modelServed": capture.get("modelServed"),
        "request": capture.get("request"),
        "response": {
            "content": "".join(capture.get("content") or []),
            "reasoning": "".join(capture.get("reasoning") or []),
            "toolCalls": [{"id": c.get("id"), "name": c["function"]["name"], "arguments": c["function"]["arguments"]}
                          for _, c in sorted((capture.get("toolCalls") or {}).items())],
            "finishReason": "cancelled" if cancelled else "error" if error else capture.get("finishReason") or None,
            "looped": capture.get("looped"),
            # Same meaning as agent_complete/task_complete.truncated: which limit ended a "length" finish.
            "truncated": truncated,
        },
        "usage": {
            "promptTokens": usage.get("prompt_tokens"),
            "completionTokens": usage.get("completion_tokens"),
            "reasoningTokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
            "costUsd": cost if cost is not None else usage.get("cost"),
            "generationId": capture.get("generationId"),
            # Prompt caching (spec A Phase 8); None when OpenRouter did not report it.
            "cachedTokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            "cacheWriteTokens": (usage.get("prompt_tokens_details") or {}).get("cache_write_tokens"),
            "cacheDiscountUsd": usage.get("cache_discount"),
        },
        "timing": {"startedAt": started, "firstTokenAt": capture.get("firstTokenAt"), "endedAt": ended,
                   "ms": ended - started if started else None},
        "error": None if error is None else {"kind": "cancelled" if cancelled else type(error).__name__,
                                             "message": str(error), "httpStatus": capture.get("httpStatus")},
    }


# ── Planning ─────────────────────────────────────────────────────────────────

PLANNER_SYSTEM = (
    "You are the orchestrator of a team of AI agents that run in parallel. Split the user's task into the largest set of "
    "steps that can run at the same time. A step may depend on another step only if it needs that step's output, and "
    "then it must list that step's id in dependsOn. Research, comparison, and per-region or per-source work is parallel "
    "by default. Do not add a final step that merges, combines, consolidates or summarises the others: the final synthesis does that "
    "after every step, including applying the task's exclusions and resolving conflicts. If work must happen after other steps "
    "(new research that needs their answers), make it a normal research step that depends only on the steps it needs, e.g. "
    "{\"id\": \"2.1\", \"label\": \"Find rail options from Selcuk to the airport for the flight 1.2 found\", \"role\": \"Rail researcher\", "
    "\"dependsOn\": [\"1.2\"]}. If a step must evaluate many candidates against several criteria, split it by sector, theme or "
    "criterion group into parallel steps; the final synthesis combines them. "
    "Slice research on one axis: by entity (e.g. each leg, city or company) or by topic (e.g. baggage, prices, risks), never both; "
    "a topic that every entity needs is part of each entity step, not a step of its own. "
    "If a step only matters depending on another step's answer (\"if leg 2 takes more than 5 hours…\"), it depends on that step: "
    "list it in dependsOn and state the condition in \"condition\". You may spawn a maximum of {max_agents} agents (steps). "
    "Also write the acceptance checklist: every requirement the answer must meet, each atomic and checkable "
    "(\"baggage allowance, leg 2\", not \"baggage\"), at most 25, and say which steps cover each. "
    "Return ONLY a JSON object {\"steps\": [...], \"checklist\": [...]}. Each step: {\"id\": \"<depth>.<n>\" (depth 1 = no dependencies), "
    "\"label\": short imperative subtask, \"role\": short agent role name, \"dependsOn\": [ids this step needs], "
    "\"axis\": \"entity\" or \"topic\", \"covers\": [checklist ids it answers], and \"condition\" only when the step is conditional}. "
    "Each checklist item: {\"id\": \"r1\", \"text\": the requirement, \"scope\": the id of the step it belongs to, or \"global\"}."
)
CHECKLIST_MAX = 25

SLICING_CORRECTION = "Fix the plan's slicing, then reply with ONLY the JSON array:"
CONDITIONAL_RE = re.compile(r"\b(?:if|unless|in case)\b[^:;.]*", re.I)
STEP_ID_RE = re.compile(r"\b\d+\.\d+\b")


def slicing_problems(steps: list[dict[str, Any]]) -> list[str]:
    """Spec A Phase 10: research sliced on two axes, and conditional steps that wait for nothing."""
    problems = []
    by_axis = {axis: [st["id"] for st in steps if st.get("axis") == axis] for axis in ("entity", "topic")}
    if by_axis["entity"] and by_axis["topic"]:
        problems.append(f"Steps {', '.join(by_axis['entity'])} are sliced by entity and {', '.join(by_axis['topic'])} by topic. "
                        "Slice research on one axis: fold each topic into the entity steps, or split only by topic.")
    for st in steps:
        clause = CONDITIONAL_RE.search(st["label"])
        if clause and not st["dependsOn"]:
            problems.append(f"Step {st['id']} is conditional (\"{clause.group(0).strip()}\") but depends on no step. "
                            "Add the step whose answer decides it to dependsOn and state the condition in \"condition\".")
    return problems


CHAIN_CORRECTION = (
    "In that plan every step waits for the previous one, so no two agents can work at the same time. Either split the "
    "work so independent steps have no dependency on each other, or, if the chain is truly required, reply with the same "
    "JSON array and add a one-line \"chainReason\" field to the first step explaining why. Reply with ONLY the JSON array."
)


def plan_json(text: str) -> tuple[Any, list[Any]]:
    """(steps, checklist) from a planner reply: the {"steps", "checklist"} object, or a bare array of steps (older
    planners, no checklist). The first JSON value that is one of those wins; prose around it is ignored."""
    decoder = json.JSONDecoder()
    for match in re.finditer(r"[\[{]", text):
        try:
            value, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(value, list):
            return value, []
        if isinstance(value, dict) and isinstance(value.get("steps"), list):
            return value["steps"], value["checklist"] if isinstance(value.get("checklist"), list) else []
    raise ValueError("no JSON plan in planner output")


def parse_checklist(text: str, steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The planner's acceptance checklist (spec B Phase 1), [] when it wrote none. Ids are unique, scope is a step id or
    "global", at most CHECKLIST_MAX items; each step's covers keep only known ids."""
    _, raw = plan_json(text)
    step_ids = {st["id"] for st in steps}
    checklist: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not str(item.get("text") or "").strip() or len(checklist) >= CHECKLIST_MAX:
            continue
        item_id = str(item.get("id") or "").strip()[:20] or f"r{index + 1}"
        if any(c["id"] == item_id for c in checklist):
            continue
        scope = str(item.get("scope") or "").strip()
        checklist.append({"id": item_id, "text": str(item["text"]).strip()[:200], "scope": scope if scope in step_ids else "global"})
    known = {c["id"] for c in checklist}
    for st in steps:
        st["covers"] = [c for c in st.get("covers", []) if c in known]
    return checklist


def parse_plan(text: str, config: Config) -> list[dict[str, Any]]:
    """Steps with explicit dependsOn and a derived display phase (dependency depth).
    The legacy phase-only shape is converted: a step depends on every step in an
    earlier phase, which is exactly what the old phase-by-phase loop gave it."""
    raw, _ = plan_json(text)
    if not isinstance(raw, list) or not raw:
        raise ValueError("plan is not a non-empty list")
    legacy = not any(isinstance(item, dict) and "dependsOn" in item for item in raw)
    steps: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict) or not str(item.get("label", "")).strip():
            raise ValueError("every step needs a label")
        step_id = str(item.get("id") or "").strip()[:20] or f"s{index + 1}"
        if step_id in seen:
            step_id = f"{step_id}#{index + 1}"
        seen.add(step_id)
        deps = item.get("dependsOn") if isinstance(item.get("dependsOn"), list) else []
        steps.append({
            "id": step_id,
            "label": str(item["label"]).strip()[:200],
            "stage": "worker",
            "role": str(item.get("role") or "Analyst").strip()[:60],
            "model": config.models.get("worker", ""),
            "dependsOn": [str(d) for d in deps],
            "phase": max(1, int(item.get("phase", 1) or 1)) if legacy else 0,
            "chainReason": str(item.get("chainReason") or "").strip()[:200],
            **({"axis": str(item["axis"]).strip().lower()} if str(item.get("axis") or "").strip().lower() in ("entity", "topic") else {}),
            **({"condition": str(item["condition"]).strip()[:300]} if str(item.get("condition") or "").strip() else {}),
            **({"covers": [str(c)[:20] for c in item["covers"] if isinstance(c, (str, int))][:CHECKLIST_MAX]} if isinstance(item.get("covers"), list) else {}),
        })
    ids = {s["id"] for s in steps}
    if legacy:
        for s in steps:
            s["dependsOn"] = [o["id"] for o in steps if o["phase"] < s["phase"]]
    for s in steps:  # a step id named in a condition is a dependency (spec A Phase 10)
        s["dependsOn"] += STEP_ID_RE.findall(s.get("condition", ""))
    for s in steps:  # unknown ids and self-references cannot be waited on
        s["dependsOn"] = list(dict.fromkeys(d for d in s["dependsOn"] if d in ids and d != s["id"]))
    by_id = {s["id"]: s for s in steps}
    depth: dict[str, int] = {}

    def depth_of(step_id: str, trail: tuple[str, ...] = ()) -> int:
        if step_id in trail:
            raise ValueError(f"dependency cycle through {step_id}")
        if step_id not in depth:
            depth[step_id] = 1 + max((depth_of(d, trail + (step_id,)) for d in by_id[step_id]["dependsOn"]), default=0)
        return depth[step_id]

    for s in steps:
        s["phase"] = depth_of(s["id"])
    return steps


MERGE_LABEL_RE = re.compile(r"\b(merg|combin|consolidat|synthes)", re.I)
MERGE_REMOVED_REASON = "a final merge step: the synthesizer merges every step's output"


def drop_final_merge(steps: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(kept, removed). A step is a final merge when its label merges/combines/consolidates/synthesizes and every
    other step is among its ancestors (direct or transitive). The synthesizer owns merging (spec A Phase 4)."""
    by_id = {st["id"]: st for st in steps}

    def ancestors(step_id: str) -> set[str]:
        seen: set[str] = set()
        todo = list(by_id[step_id]["dependsOn"])
        while todo:
            dep = todo.pop()
            if dep not in seen and dep in by_id:
                seen.add(dep)
                todo += by_id[dep]["dependsOn"]
        return seen

    removed = [st for st in steps if len(steps) > 1 and MERGE_LABEL_RE.search(st["label"]) and ancestors(st["id"]) == set(by_id) - {st["id"]}]
    gone = {st["id"] for st in removed}
    return [st for st in steps if st["id"] not in gone], removed


def is_pure_chain(steps: list[dict[str, Any]]) -> bool:
    """Two or more steps and no two of them can ever run at the same time."""
    return len(steps) >= 2 and len({s["phase"] for s in steps}) == len(steps)


def partial_plan_steps(text: str) -> list[dict[str, Any]]:
    """The complete step objects of a plan array that is still streaming, in order. Objects whose
    closing brace has not arrived yet are left out; strings may contain braces and brackets."""
    key = text.find('"steps"')
    start = text.find("[", key if key >= 0 else 0)
    if start < 0:
        return []
    steps: list[dict[str, Any]] = []
    depth, in_str, escaped, obj_start = 0, False, False, -1
    for i in range(start + 1, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                obj_start = i
            depth += 1
        elif ch == "}" and depth > 0:
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[obj_start:i + 1])
                except ValueError:
                    continue
                if isinstance(obj, dict) and str(obj.get("label", "")).strip():
                    steps.append(obj)
        elif ch == "]" and depth == 0:
            break
    return steps


def draft_step(obj: dict[str, Any], index: int) -> dict[str, Any]:
    """What the UI needs to draw a subtask the planner has written so far."""
    deps = obj.get("dependsOn") if isinstance(obj.get("dependsOn"), list) else []
    return {"id": str(obj.get("id") or "").strip()[:20] or f"s{index + 1}", "label": str(obj["label"]).strip()[:200],
            "role": str(obj.get("role") or "").strip()[:60], "dependsOn": [str(d) for d in deps]}


QUICK_PLAN_REASON = "You chose the quick 3-step plan."


def fallback_plan(config: Config) -> list[dict[str, Any]]:
    labels = ["Analyze the task", "Research supporting evidence", "Review risks and recommendations"]
    return [{"id": f"1.{i + 1}", "label": labels[i], "stage": "worker", "role": "Analyst", "model": config.models.get("worker", ""),
             "dependsOn": [], "phase": 1}
            for i in range(min(config.maxAgents, len(labels)))]


def with_date(run: Run, text: str) -> str:
    """Every role's system message ends with Electron's date line, as in single-model chat."""
    return f"{text}\n\n{run.request.currentDateTime}"


async def plan_node(state: dict[str, Any]) -> dict[str, Any]:
    run: Run = state["run"]
    config = run.config
    model = config.models.get("orchestrator", "")
    messages = [
        {"role": "system", "content": with_date(run, PLANNER_SYSTEM.replace("{max_agents}", str(config.maxAgents)))},
        {"role": "user", "content": run.request.task},
    ]
    steps: list[dict[str, Any]] | None = None
    chain_checked = False
    slicing_checked = False
    served = ""
    fallback_reason = ""
    # The plan streams to the UI as it is written (UI Goal 5): stages, each complete subtask, any reasoning.
    await run.emit("plan_started", maxAgents=config.maxAgents)
    await run.emit("plan_stage_changed", stage="reading", attempt=0)
    for attempt in range(4):
        if run.quick_plan:
            fallback_reason = QUICK_PLAN_REASON
            break
        text_so_far: list[str] = []
        shown = 0

        async def on_token(token: str, attempt: int = attempt) -> None:
            nonlocal shown
            before = "".join(text_so_far)
            text_so_far.append(token)
            text = before + token
            if "[" in text and "[" not in before:
                await run.emit("plan_stage_changed", stage="splitting", attempt=attempt)
            found = partial_plan_steps(text)
            for index in range(shown, len(found)):
                await run.emit("plan_subtask_added", attempt=attempt, index=index, step=draft_step(found[index], index))
            shown = len(found)

        async def on_reasoning(token: str) -> None:
            await run.emit("plan_reasoning", token=token)

        try:
            reply, _, _ = await ask(run, model, messages, on_token=on_token, on_reasoning=on_reasoning,
                                    stop=lambda: run.quick_plan, obs={"role": "planner", "attempt": attempt})
        except (BudgetReached, asyncio.CancelledError):
            raise
        except Exception as exc:  # noqa: BLE001 — a planner error is shown with the fallback the user can approve or cancel
            fallback_reason = f"The orchestrator failed: {exc}"
            break
        if run.quick_plan:
            fallback_reason = QUICK_PLAN_REASON
            break
        served = reply.get("model_served") or served
        text = str(reply.get("content") or "")
        try:
            candidate = parse_plan(text, config)
        except (ValueError, TypeError):
            messages += [{"role": "assistant", "content": text}, {"role": "user", "content": "That was not a valid JSON array of steps with acyclic dependsOn. Reply with ONLY the JSON array."}]
            continue
        if len(candidate) > config.maxAgents:
            # Spec §06: the sidecar rejects an over-cap plan and re-plans.
            messages += [{"role": "assistant", "content": text},
                         {"role": "user", "content": f"Your plan has {len(candidate)} steps but the maximum is {config.maxAgents}. Merge steps and reply with at most {config.maxAgents}."}]
            if attempt == 3:
                steps = candidate[: config.maxAgents]
                kept = {s["id"] for s in steps}
                for s in steps:
                    s["dependsOn"] = [d for d in s["dependsOn"] if d in kept]
            continue
        if is_pure_chain(candidate) and not chain_checked:
            # One correction only; the second answer is accepted either way.
            chain_checked = True
            print(f"[plan] run {run.run_id}: pure chain of {len(candidate)} steps — asking once for a parallel split", file=sys.stderr, flush=True)
            messages += [{"role": "assistant", "content": text}, {"role": "user", "content": CHAIN_CORRECTION}]
            continue
        problems = [] if slicing_checked else slicing_problems(candidate)
        if problems:  # one correction only; the next answer is accepted either way
            slicing_checked = True
            print(f"[plan] run {run.run_id}: slicing correction — {len(problems)} problem(s)", file=sys.stderr, flush=True)
            messages += [{"role": "assistant", "content": text}, {"role": "user", "content": SLICING_CORRECTION + "\n" + "\n".join(f"- {p}" for p in problems)}]
            continue
        if chain_checked:
            reason = next((s["chainReason"] for s in candidate if s.get("chainReason")), "")
            outcome = f"kept the chain ({reason or 'no reason given'})" if is_pure_chain(candidate) else "parallelised"
            print(f"[plan] run {run.run_id}: chain correction → {outcome}", file=sys.stderr, flush=True)
        steps = candidate
        run.checklist = parse_checklist(text, steps)
        break
    if steps is None and not fallback_reason:
        fallback_reason = "The orchestrator did not return a usable plan after 4 attempts."
    await run.emit("plan_stage_changed", stage="assigning", attempt=0)
    await run.emit("plan_stage_changed", stage="wiring", attempt=0)
    fallback = steps is None
    if steps:
        steps, removed = drop_final_merge(steps)
        for st in removed:
            print(f"[plan] run {run.run_id}: dropped final merge step {st['id']} ({st['label']})", file=sys.stderr, flush=True)
            await run.emit("plan_step_removed", stepId=st["id"], label=st["label"], reason=MERGE_REMOVED_REASON)
    steps = steps or fallback_plan(config)
    for s in steps:
        s.pop("chainReason", None)
    if fallback:  # never silent: the reason reaches the plan approval screen and the run log
        print(f"[plan] run {run.run_id}: using the fallback plan — {fallback_reason}", file=sys.stderr, flush=True)
    if fallback:
        run.checklist = []
    await run.emit("orchestrator_plan", steps=steps, **({"fallback": True, "fallbackReason": fallback_reason} if fallback else {}),
                   **({"checklist": run.checklist} if run.checklist else {}),
                   **({"modelServed": served} if served else {}))
    await run.emit("run_config", models=config.models,
                   sources={role: run.request.modelSources.get(role, "saved") for role in config.models},
                   catalogueChecked=run.request.catalogueChecked, maxAgents=config.maxAgents, budgetCapUsd=config.budgetCapUsd,
                   reflectionPassThreshold=config.reflectionPassThreshold, maxRetriesPerAgent=config.maxRetriesPerAgent,
                   maxToolRounds=config.maxToolRounds, reasoningEffort=config.reasoningEffort, tools=[str(t.get("name")) for t in run.request.tools],
                   excludedServers=run.request.excludedServers)
    return {**state, "steps": steps}


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
    if name not in allowed:  # same corrective wording as ChatService.buildUnregisteredToolMessage
        raise ValueError(f'"{name}" is not registered in the tool schema for this session and cannot be called. '
                         f"Do not call it again. Registered tools for this session: {', '.join(sorted(allowed)) or '(none)'}.")
    server, _, local = name.partition("__")
    if not local:
        raise ValueError(f"tool '{name}' is not an Electron MCP namespaced tool")
    return server, local


# ── Claims contract (spec reflection hardening Phase 3) ───────────────────────
# The worker ends its answer with a ```claims JSON array; each claim cites a tool call and a quote
# from its result, is declared unverified, or cites an earlier agent's output as its source.

CLAIMS_MARK = "```claims"
CLAIMS_BLOCK_RE = re.compile(r"```claims(?!_patch)[ \t]*\n?(.*?)(?:```|$)", re.S)
PATCH_BLOCK_RE = re.compile(r"```claims_patch[ \t]*\n?(.*?)(?:```|$)", re.S)
QUOTE_MIN_CHARS, QUOTE_MAX_CHARS = 12, 400
# verified_fragments: a "..."-stitched quote whose fragments appear in order; *_repointed: the quote was not in the
# cited result but in exactly one other result of this agent, so its callId was rewritten (spec A Phase 1).
CLAIM_OK = {"verified", "verified_fragments", "verified_repointed", "verified_fragments_repointed", "unverified_declared", "source"}
CLAIM_PROBLEM = {
    "quote_not_found": "the quote is not in the cited tool result",
    "quote_found_elsewhere": "the quote is not in the cited tool result but is in several others; cite one of: {candidates}",
    "call_not_found": "no tool call with that callId",
    "call_failed": "the cited tool call failed or was denied",
    "quote_too_short": f"the quote is under {QUOTE_MIN_CHARS} characters, which is not evidence",
    "quote_too_long": f"the quote is over {QUOTE_MAX_CHARS} characters; quote only the supporting words",
    "snippet_not_found": "snippet {missing} does not exist; cite only ids shown as [S…] in your tool results",
    "no_citation": "it cites nothing; give its snippets, or mark it \"unverified\": true, or give its \"source\"",
}
CLAIMS_CONTRACT = (
    "End your answer with a fenced claims block listing every factual claim, and mark each claim in the prose with its id, "
    "e.g. [c1]. Each entry is one of: {\"id\", \"claim\", \"callId\", \"quote\"} — callId is the tool call whose result supports it "
    "(shown as [callId: …] at the top of each successful tool result) and quote is copied exactly from that result "
    f"({QUOTE_MIN_CHARS}–{QUOTE_MAX_CHARS} characters); {{\"id\", \"claim\", \"unverified\": true}} when no tool result supports it; "
    "or {\"id\", \"claim\", \"source\": \"1.1\"} for something taken from an earlier agent's output. Example:\n"
    "```claims\n[\n  {\"id\": \"c1\", \"claim\": \"ALAB Q2 2026 revenue $392.4M\", \"callId\": \"call_01a1\", \"quote\": \"record revenue of $392.4 million\"},\n"
    "  {\"id\": \"c2\", \"claim\": \"ALAB 2-quarter 13F trend\", \"unverified\": true}\n]\n```\n"
    "Use [] when the answer makes no factual claims."
)
SNIPPET_CLAIMS_CONTRACT = (
    "End your answer with a fenced claims block listing every factual claim, and mark each claim in the prose with its id, "
    "e.g. [c1]. Each entry is one of: {\"id\", \"claim\", \"snippets\": [\"S3.2\"]} — the ids of the tool-result snippets that support it "
    "(each snippet of a successful tool result starts with its id, e.g. [S3.2]); do not copy quotes, they are filled in from the snippets; "
    "{\"id\", \"claim\", \"unverified\": true} when no tool result supports it; "
    "or {\"id\", \"claim\", \"source\": \"1.1\"} for something taken from an earlier agent's output. Example:\n"
    "```claims\n[\n  {\"id\": \"c1\", \"claim\": \"ALAB Q2 2026 revenue $392.4M\", \"snippets\": [\"S3.2\"]},\n"
    "  {\"id\": \"c2\", \"claim\": \"ALAB 2-quarter 13F trend\", \"unverified\": true}\n]\n```\n"
    "Use [] when the answer makes no factual claims."
)
# One snippet per Brave result block ("[n] title\nurl\nbody", blank-line separated); any other result is one snippet.
BRAVE_BLOCK_RE = re.compile(r"\n\n(?=\[\d+\] )")
BRAVE_LABEL_RE = re.compile(r"^\[(\d+)\] ")
SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")


def is_search_result(result: str) -> bool:
    return all(BRAVE_LABEL_RE.match(b) for b in BRAVE_BLOCK_RE.split(result))


def split_snippets(result: str, call_no: int) -> dict[str, str]:
    """snippet id (S<call_no>.<n>) → text, in order."""
    blocks = BRAVE_BLOCK_RE.split(result)
    if is_search_result(result):
        return {f"S{call_no}.{i + 1}": BRAVE_LABEL_RE.sub("", b, count=1) for i, b in enumerate(blocks)}
    return {f"S{call_no}.1": result}


# The worker's view of a search result (spec A Phase 7): each page keeps its title, url and first body line (Brave's
# own snippet on the worker path); the rest is whitespace-collapsed and cut to a window around the query terms.
# The evidence store keeps the full result, so quotes, the judge and read_evidence see everything.
VIEW_PAGE_CHARS = 850  # ≤ 5 KB median view on the Istanbul fixture (spec A Phase 7)
VIEW_HEAD_LINE_CHARS = 400  # Brave's snippet is shorter; a page's first line can be a whole paragraph


def view_page(text: str, sid: str, query: str) -> str:
    lines = text.split("\n")
    head = lines[:2] + [preview(line, VIEW_HEAD_LINE_CHARS) for line in lines[2:3]]
    rest = re.sub(r"[ \t]+", " ", re.sub(r"\s*\n\s*", "\n", "\n".join(lines[3:]))).strip()
    if len(rest) > VIEW_PAGE_CHARS:
        low = rest.lower()
        hits = sorted(m.start() for term in {w for w in WORD_RE.findall(query.lower()) if len(w) >= 3} for m in re.finditer(re.escape(term), low))
        best, best_start, j = 0, 0, 0
        for i, at in enumerate(hits):  # the window holding the most query-term hits
            while at - hits[j] > VIEW_PAGE_CHARS:
                j += 1
            if i - j + 1 > best:
                best, best_start = i - j + 1, hits[j]
        start = max(0, min(best_start - 100, len(rest) - VIEW_PAGE_CHARS))
        start = rest.rfind("\n", 0, start) + 1 if start else 0
        cut = rest[start:start + VIEW_PAGE_CHARS]
        rest = ("…" if start else "") + cut + f"… [{len(rest) - len(cut):,} chars trimmed; read_evidence(\"{sid}\") for the rest]"
    return "\n".join(head + ([rest] if rest else []))


def ingest_result(result: str, call_no: int, query: str, claim_format: str) -> tuple[dict[str, str], str]:
    """(snippets for the evidence store — the full text, the worker's view of the result)."""
    snippets = split_snippets(result, call_no)
    if not is_search_result(result):
        return snippets, "\n\n".join(f"[{sid}] {text}" for sid, text in snippets.items()) if claim_format == "snippet" else result
    views = [(sid, view_page(text, sid, query)) for sid, text in snippets.items()]
    if claim_format == "snippet":
        return snippets, "\n\n".join(f"[{sid}] {view}" for sid, view in views)
    return snippets, "\n\n".join(f"[{i + 1}] {view}" for i, (_, view) in enumerate(views))


def best_quote(claim: str, texts: list[tuple[str, str]]) -> tuple[str, str]:
    """(callId, quote): the sentence of the cited snippets sharing the most words with the claim (ties: the first),
    cut to QUOTE_MAX_CHARS. Deterministic."""
    words = set(WORD_RE.findall(claim.casefold()))
    best = (-1, "", "")
    for call_id, text in texts:
        for sentence in SENTENCE_RE.split(text):
            score = len(words & set(WORD_RE.findall(sentence.casefold())))
            if sentence.strip() and score > best[0]:
                best = (score, call_id, sentence.strip())
    return best[1], best[2][:QUOTE_MAX_CHARS]


def claims_contract(config: "Config") -> str:
    return SNIPPET_CLAIMS_CONTRACT if config.claimFormat == "snippet" else CLAIMS_CONTRACT
_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'", "\u201c": '"', "\u201d": '"',
                         "\u201e": '"', "\u2033": '"', "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
                         "\u2015": "-", "\u2212": "-"})


def normalise_quote(text: str) -> str:
    """Formatting only, never fuzzy: entities and HTML tags, curly quotes and dashes, markdown
    emphasis, thousands separators inside digit runs, whitespace, case."""
    text = re.sub(r"<[^>]{0,200}>", " ", html.unescape(text)).translate(_QUOTES)
    text = re.sub(r"[*_`~]", "", text)
    text = re.sub(r"(?<=\d),(?=\d)", "", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def parse_claims(output: str) -> tuple[str, list[dict[str, Any]], list[str]]:
    """(prose without the claims block, claims, parse errors). A missing or broken block is an issue to repair, never a crash."""
    blocks = list(CLAIMS_BLOCK_RE.finditer(output))
    if not blocks:
        return output, [], ["No claims block: end the answer with a ```claims JSON array (use [] if it makes no factual claims)."]
    block = blocks[-1]
    prose = (output[:block.start()] + output[block.end():]).strip()
    try:
        raw = json.loads(block.group(1))
    except ValueError as exc:
        return prose, [], [f"The claims block is not valid JSON ({exc})."]
    if not isinstance(raw, list):
        return prose, [], ["The claims block must be a JSON array."]
    claims: list[dict[str, Any]] = []
    errors: list[str] = []
    for index, item in enumerate(raw):
        claim, error = parse_claim_item(item, index)
        if claim:
            claims.append(claim)
        else:
            errors.append(error)
    return prose, claims, errors


def parse_claim_item(item: Any, index: int) -> tuple[dict[str, Any] | None, str]:
    """(claim, "") or (None, error) for one entry of a claims block or a claims_patch replace list."""
    claim_id = str(item.get("id") or f"#{index + 1}")[:20] if isinstance(item, dict) else f"#{index + 1}"
    if not isinstance(item, dict) or not str(item.get("claim") or "").strip():
        return None, f"Claim {claim_id} needs an \"id\" and a \"claim\"."
    text = str(item["claim"])[:400]
    # The requirement(s) it fills (spec B Phase 1): a checklist id, or a list of them for a claim that answers several.
    raw_req = item.get("req")
    req = [str(r)[:20] for r in (raw_req if isinstance(raw_req, list) else [raw_req]) if isinstance(r, str) and r.strip()][:5]
    base = {"id": claim_id, "claim": text, **({"req": req[0] if len(req) == 1 else req} if req else {})}
    if isinstance(item.get("snippets"), list) and item["snippets"]:
        return {**base, "snippets": [str(x)[:20] for x in item["snippets"]][:10]}, ""
    if item.get("callId") and isinstance(item.get("quote"), str):
        return {**base, "callId": str(item["callId"]), "quote": item["quote"]}, ""
    if item.get("unverified") is True:
        return {**base, "unverified": True}, ""
    if item.get("source"):
        return {**base, "source": str(item["source"])[:20]}, ""
    return base, ""  # cites nothing: a claim problem (no_citation), checked and repaired like the others


def parse_patch(output: str) -> tuple[dict[str, Any] | None, str]:
    """(patch, "") from a ```claims_patch block, (None, "") when there is none, (None, error) when it is broken."""
    blocks = list(PATCH_BLOCK_RE.finditer(output))
    if not blocks:
        return None, ""
    try:
        patch = json.loads(blocks[-1].group(1))
    except ValueError as exc:
        return None, f"The claims_patch block is not valid JSON ({exc})."
    return (patch, "") if isinstance(patch, dict) else (None, "The claims_patch block must be a JSON object.")


def apply_claims_patch(claims: list[dict[str, Any]], patch: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """(merged claims, errors). replace: full entries swapped in by id (a new id is appended); drop: ids withdrawn,
    which stay in the report marked unverified, so their [cN] markers remain honest. The input is not mutated."""
    merged = [dict(c) for c in claims]
    errors: list[str] = []
    replace, drop = patch.get("replace", []), patch.get("drop", [])
    if not isinstance(replace, list):
        errors.append('The claims_patch "replace" must be a list of claim entries.')
        replace = []
    for index, item in enumerate(replace):
        claim, error = parse_claim_item(item, index)
        if not claim:
            errors.append(error)
            continue
        at = next((i for i, c in enumerate(merged) if c["id"] == claim["id"]), None)
        if at is None:
            merged.append(claim)
        else:
            merged[at] = claim
    if not isinstance(drop, list):
        errors.append('The claims_patch "drop" must be a list of claim ids.')
        drop = []
    for claim_id in map(str, drop):
        at = next((i for i, c in enumerate(merged) if c["id"] == claim_id), None)
        if at is not None:
            merged[at] = {"id": claim_id, "claim": merged[at]["claim"], "unverified": True, **({"req": merged[at]["req"]} if "req" in merged[at] else {})}
    return merged, errors


ELLIPSIS_RE = re.compile(r"\.\.\.|…")
FAILURE_CLASS = {"call_not_found": "wrong_call", "quote_found_elsewhere": "wrong_call", "snippet_not_found": "wrong_call", "no_citation": "no_citation", "call_failed": "call_failed",
                 "quote_too_short": "too_short", "quote_too_long": "too_long"}


def quote_fragments(quote: str) -> list[str]:
    """Normalised pieces of a quote stitched with "..." or "…"; a leading or trailing ellipsis makes no piece."""
    return [f for f in (normalise_quote(part) for part in ELLIPSIS_RE.split(quote)) if f]


def quote_match(quote: str, result: str) -> str | None:
    """"whole" if the quote is in the result, "fragments" if its pieces are, in order; else None."""
    text, frags = normalise_quote(result), quote_fragments(quote)
    if normalise_quote(quote) in text or (len(frags) == 1 and frags[0] in text):
        return "whole"
    pos = 0
    for frag in frags if len(frags) > 1 else ():
        at = text.find(frag, pos)
        if at < 0:
            return None
        pos = at + len(frag)
    return "fragments" if len(frags) > 1 else None


def verify_claim(claim: dict[str, Any], store: dict[str, dict[str, Any]]) -> str:
    """Deterministic check of one claim against the agent's evidence store; no model call. A quote found only
    in exactly one other successful result re-points the claim (claim["callId"] rewritten, "repointedFrom" kept);
    found in several, the candidates go in claim["candidates"] and nothing is guessed. Lengths apply to the
    fragments' total."""
    if claim.get("unverified"):
        return "unverified_declared"
    if claim.get("source"):
        return "source"
    if claim.get("snippets"):
        texts = []
        for sid in claim["snippets"]:
            hit = next(((cid, c["snippets"][sid]) for cid, c in store.items() if sid in (c.get("snippets") or {})), None)
            if hit is None:
                claim["missing"] = sid
                return "snippet_not_found"
            texts.append(hit)
        claim["callId"], claim["quote"] = best_quote(claim["claim"], texts)
        return "verified"
    if "quote" not in claim:
        return "no_citation"
    size = sum(len(f) for f in quote_fragments(claim["quote"]))
    call = store.get(claim["callId"])
    if QUOTE_MIN_CHARS <= size <= QUOTE_MAX_CHARS:
        found = quote_match(claim["quote"], call["result"]) if call is not None and call["ok"] else None
        if found:
            return "verified" if found == "whole" else "verified_fragments"
        others = {cid: m for cid, c in store.items() if cid != claim["callId"] and c["ok"] and (m := quote_match(claim["quote"], c["result"]))}
        if len(others) == 1:
            [(cid, m)] = others.items()
            claim["repointedFrom"], claim["callId"] = claim["callId"], cid
            return "verified_repointed" if m == "whole" else "verified_fragments_repointed"
        if others:
            claim["candidates"] = list(others)
            return "quote_found_elsewhere"
    if call is None:
        return "call_not_found"
    if not call["ok"]:
        return "call_failed"
    if size < QUOTE_MIN_CHARS:
        return "quote_too_short"
    if size > QUOTE_MAX_CHARS:
        return "quote_too_long"
    return "quote_not_found"


def failure_class(claim: dict[str, Any], status: str) -> str | None:
    """ellipsis_fragment_missing | wrong_call | mismatch | too_short | too_long | call_failed; None for a passing claim."""
    if status in CLAIM_OK:
        return None
    if status == "quote_not_found":
        return "ellipsis_fragment_missing" if len(quote_fragments(claim.get("quote", ""))) > 1 else "mismatch"
    return FAILURE_CLASS[status]


def failure_classes(claims: list[dict[str, Any]], statuses: dict[str, str]) -> dict[str, str]:
    return {c["id"]: cls for c in claims if (cls := failure_class(c, statuses[c["id"]]))}


# ── Coverage ledger (spec B Phase 1): requirement statuses from claim statuses, no model call ──

CLAIM_VERIFIED = CLAIM_OK - {"unverified_declared", "source"}
DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DAY_RE = re.compile(r"\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b|\b(every day|daily)\b", re.I)
DURATION_RE = re.compile(r"(\d+)\s*h\s*(\d+)\s*m(?:in)?\b", re.I)
NUMBER_RE = re.compile(r"\d+(?:\.\d+)?")
CODE_RE = re.compile(r"\b[A-Z]{3}\b")
NOT_CODES = {"EUR", "USD", "TRY", "GBP", "AND", "THE", "VIA", "THY", "PGT", "TKJ"}
STOP_WORDS = {"the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "by", "with", "from", "at", "up", "per", "it", "its", "says", "lists",
              "kg", "cm", "km", "min", "h", "m", "eur", "usd", "try", "tl", "x"}  # units are not the subject


def claim_req(claim: dict[str, Any]) -> list[str]:
    req = claim.get("req")
    return [req] if isinstance(req, str) else [r for r in req if isinstance(r, str)] if isinstance(req, list) else []


def claim_facts(text: str) -> tuple[set[str], set[str], list[float], set[str]]:
    """(subject words, airport codes, numbers with "1h5m" as minutes, weekdays named; "every day"/"daily" = all)."""
    days = set()
    for m in DAY_RE.finditer(text):
        days |= set(DAY_NAMES) if m.group(2) else {m.group(1)[:3].lower()}
    plain = DURATION_RE.sub(lambda m: str(int(m.group(1)) * 60 + int(m.group(2))), DAY_RE.sub(" ", text))
    words = {w.rstrip("s") for w in WORD_RE.findall(normalise_quote(plain)) if not w[0].isdigit() and w not in STOP_WORDS}
    return words, set(CODE_RE.findall(text)) - NOT_CODES, [float(n) for n in NUMBER_RE.findall(plain)], days


def numbers_agree(a: list[float], b: list[float]) -> bool:
    """One claim's numbers are all (within 15%) among the other's: one adds detail, neither contradicts."""
    def within(xs: list[float], ys: list[float]) -> bool:
        return all(any(abs(x - y) <= 0.15 * max(abs(x), abs(y)) for y in ys) for x in xs)
    return within(a, b) or within(b, a)


def possible_conflict(a: str, b: str) -> bool:
    """Cheap heuristic: the same subject (most words shared, and no different airports) with different weekdays or numbers.
    Shown as a possible conflict until the assess call confirms it."""
    wa, ca, na, da = claim_facts(a)
    wb, cb, nb, db = claim_facts(b)
    if ca and cb and ca != cb:
        return False
    if not (wa and wb and len(wa & wb) / min(len(wa), len(wb)) >= 0.75):
        return False
    return (bool(da and db) and da != db) or (bool(na and nb) and not numbers_agree(na, nb))


def compute_ledger(checklist: list[dict[str, Any]], steps: list[dict[str, Any]], finished: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """checklistId → {status, claimIds[, conflict]}. finished: agentId → {"claims", "statuses"} for every step that ended
    (a failed or skipped step has no claims). Status: conflicted (two verified claims of different agents disagree),
    verified, unverified (only declared-unverified claims), pending (a covering step has not ended), missing."""
    covering = {item["id"]: [st["id"] for st in steps if item["id"] in st.get("covers", [])] for item in checklist}
    by_req: dict[str, list[tuple[str, dict[str, Any], str]]] = {item["id"]: [] for item in checklist}
    for agent_id, done in finished.items():
        for claim in done["claims"]:
            for req in claim_req(claim):
                if req in by_req:
                    by_req[req].append((agent_id, claim, done["statuses"].get(claim["id"], "")))
    ledger: dict[str, dict[str, Any]] = {}
    for item in checklist:
        entries = by_req[item["id"]]
        verified = [(a, c) for a, c, st in entries if st in CLAIM_VERIFIED]
        declared = [(a, c) for a, c, st in entries if st == "unverified_declared"]
        conflict = next(([f"{a} {x['id']}", f"{b} {y['id']}"] for i, (a, x) in enumerate(verified) for b, y in verified[i + 1:]
                         if a != b and possible_conflict(x["claim"], y["claim"])), None)
        if conflict:
            status = "conflicted"
        elif verified:
            status = "verified"
        elif declared:
            status = "unverified"
        elif any(sid not in finished for sid in covering[item["id"]]) or (not covering[item["id"]] and len(finished) < len(steps)):
            status = "pending"
        else:
            status = "missing"
        ledger[item["id"]] = {"status": status, "claimIds": [f"{a} {c['id']}" for a, c in verified + declared],
                              **({"conflict": {"claimIds": conflict, "confirmed": False}} if conflict else {})}
    return ledger


def ledger_counts(ledger: dict[str, dict[str, Any]]) -> dict[str, int]:
    return {status: sum(1 for e in ledger.values() if e["status"] == status) for status in ("verified", "unverified", "conflicted", "missing", "pending")}


def claim_problems(claims: list[dict[str, Any]], statuses: dict[str, str]) -> list[str]:
    def ref(c: dict[str, Any]) -> str:
        return f"snippets {', '.join(c['snippets'])}" if c.get("snippets") else f"callId {c.get('callId')}"
    return [f"Claim {c['id']} ({ref(c)}): "
            f"{CLAIM_PROBLEM[statuses[c['id']]].format(candidates=', '.join(c.get('candidates', [])), missing=c.get('missing', ''))}."
            for c in claims if statuses[c["id"]] not in CLAIM_OK]


def excerpt(result: str, quote: str) -> str | None:
    """±EXCERPT_RADIUS_CHARS of the cited result around the quote, or None if it is not there."""
    span = excerpt_span(result, quote)
    return None if span is None else ("…" if span[0] else "") + result[span[0]:span[1]] + "…"


def excerpt_span(result: str, quote: str) -> tuple[int, int] | None:
    """(start, end) of the raw result ±EXCERPT_RADIUS_CHARS around the quote, or None if it is not there."""
    norm_result, norm_quote = normalise_quote(result), normalise_quote(quote)
    if norm_quote not in norm_result:  # a stitched quote: centre on its first piece
        norm_quote = next(iter(quote_fragments(quote)), "")
    at = norm_result.find(norm_quote) if norm_quote else -1
    if at < 0:
        return None
    # Normalising shifts offsets: find the raw position whose normalised prefix reaches `at` (binary search;
    # prefix lengths only grow with the raw prefix). A proportional guess missed quotes in whitespace-heavy pages.
    lo, hi = 0, len(result)
    while lo < hi:
        mid = (lo + hi) // 2
        if len(normalise_quote(result[:mid])) < at:
            lo = mid + 1
        else:
            hi = mid
    centre = lo
    return max(0, centre - EXCERPT_RADIUS_CHARS), min(len(result), centre + len(quote) + EXCERPT_RADIUS_CHARS)


def merged_excerpts(claims: list[dict[str, Any]], store: dict[str, dict[str, Any]]) -> list[str]:
    """One block per run of overlapping windows of the same call, labelled with every claim it covers,
    so claims citing neighbouring text do not repeat it."""
    spans: dict[str, list[tuple[int, int, str]]] = {}
    for c in claims:
        if "callId" in c and c["callId"] in store and (w := excerpt_span(store[c["callId"]]["result"], c["quote"])):
            spans.setdefault(c["callId"], []).append((w[0], w[1], c["id"]))
    blocks = []
    for call_id, windows in spans.items():
        result = store[call_id]["result"]
        merged: list[list[Any]] = []
        for start, end, claim_id in sorted(windows):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
                merged[-1][2].append(claim_id)
            else:
                merged.append([start, end, [claim_id]])
        blocks += [f"[{', '.join(ids)}] from {call_id}:\n" + ("…" if start else "")
                   + re.sub(r"[ \t]+", " ", re.sub(r"\s*\n\s*", "\n", result[start:end])) + ("…" if end < len(result) else "")
                   for start, end, ids in merged]
    return blocks


REFUSAL = re.compile(r"^\W*(i'?m sorry|i am sorry|sorry,|i cannot|i can'?t|i am unable|i'?m unable|as an ai|i do not have access|i don'?t have access)", re.I)


def precheck(output: str) -> str | None:
    """Deterministic gate before any reviewer spend. Returns the failure reason."""
    text = output.strip()
    if not text:
        return "empty output"
    if len(text) < 40:
        return f"output is only {len(text)} characters"
    # ponytail: prefix heuristic for refusals; a longer answer that merely opens with "Sorry," goes on to the model gate.
    if REFUSAL.match(text) and len(text) < 400:
        return "output is only a refusal or disclaimer"
    return None


def preview(value: str, limit: int) -> str:
    return value if len(value) <= limit else value[: limit - 1] + "…"


# The judge is always told how the evidence is shown; it never has to infer truncation.
EVIDENCE_MODE_SENTENCE = {
    "full": "You are given the complete tool results.",
    "excerpts": ("Tool results are shown as excerpts around each cited quote; a figure that is absent from an excerpt is not "
                 "evidence that it is absent from the full result; judge claims by their quote."),
}
# ±250 (was ±800): on the Istanbul fixture ±800 cuts judge input by only 72%; ±250 with whitespace collapsed
# reaches 80% and still leaves two or three sentences around each quote for the support check (spec A Phase 3).
EXCERPT_RADIUS_CHARS = 250
# A verdict is short JSON; below this the full evidence is not affordable and excerpts are used instead.
JUDGE_MIN_COMPLETION_TOKENS = 512


def store_result(result: str) -> str:
    return cap_fields(result, "result", [])


def evidence_full(store: dict[str, dict[str, Any]]) -> str:
    return "\n\n".join(f"### {call_id} · {c['name']}({c['args']}) · {'ok' if c['ok'] else 'failed'} · attempt {c['attempt']}\n{c['result']}"
                        for call_id, c in store.items()) or "(no tool calls were made)"


def evidence_index(store: dict[str, dict[str, Any]]) -> str:
    return "\n".join(f"- {call_id} · {c['name']} · {preview(c['args'], 200)} · {'ok' if c['ok'] else 'failed'} · {len(c['result'])} chars"
                     for call_id, c in store.items()) or "(no tool calls were made)"


def judge_evidence_limit(run: Run, model: str) -> int:
    p = run.price(model)
    limit = run.config.judgeEvidenceMaxTokens
    return min(limit, p.contextLength // 2) if p and p.contextLength else limit


JUDGE_MAX_TOKENS = ROLE_MAX_TOKENS["judge"]  # the verdict is a short JSON object; a truncated one is retried once with twice the room


def judge_messages(run: Run, step: dict[str, Any], output: str, prior: dict[str, str], store: dict[str, dict[str, Any]],
                   claims: list[dict[str, Any]], statuses: dict[str, str], mode: str, history: list[str] | None = None) -> list[dict[str, Any]]:
    """The judge's request in one evidence mode. history: one line per earlier attempt's claim-check failures."""
    rubric = "\n".join(f"{i + 1}. {item}" for i, item in enumerate(REFLECTION_RUBRIC))
    earlier = "\n\n".join(f"[{k}] {v}" for k, v in prior.items()) or "(this step depends on no earlier agent)"
    table = "\n".join(f"- {c['id']} | {c['claim']} | {statuses.get(c['id'], '?')} | "
                      + (f"quote: {json.dumps(c['quote'], ensure_ascii=False)} | callId: {c['callId']}" if "callId" in c else
                         f"source: {c['source']}" if "source" in c else "declared unverified" if c.get("unverified") else
                         f"snippets: {', '.join(c.get('snippets') or [])} (not found)" if c.get("snippets") else "no evidence cited")
                      for c in claims) or "(no claims listed)"
    if mode == "full":
        tools = f"Tool calls the agent made (complete results):\n{evidence_full(store)}"
    else:
        cuts = merged_excerpts(claims, store)
        tools = (f"Tool calls the agent made (index; results are not shown in full):\n{evidence_index(store)}\n\n"
                 f"Excerpts around each cited quote:\n" + ("\n\n".join(cuts) or "(none)"))
    checks = "; ".join(history or []) or "this is the first attempt"
    return [
        {"role": "system", "content": with_date(run, "You are a strict reviewer of one agent's work in a multi-agent team. Judge the output against this rubric:\n"
                                      f"{rubric}\n\n{EVIDENCE_MODE_SENTENCE[mode]}\n\n"
                                      "Each claim's quote was already checked mechanically against the result it cites (status column: verified = "
                                      "the quote is in that result). Do not re-check whether a quote is in its result; judge only whether each quote "
                                      "actually supports its claim, and whether the prose makes "
                                      "significant assertions with no [cN] marker; an unmarked numeric assertion counts as an unbacked claim. "
                                      "Do not infer that something was invented from its absence in an excerpt; report only claims whose quote does "
                                      "not support them, assertions with no marker, and rubric failures. "
                                      + ("" if prior else "This step depends on no earlier agent: skip rubric item 4. ") +
                                      "Score 1 (useless) to 5 (excellent). A claim with no tool evidence that is not marked as unverified is an issue. "
                                      "Reply with JSON only: {\"score\": <1-5>, \"reason\": \"<one sentence>\", \"issues\": [\"<specific problem to fix>\", ...]}")},
        {"role": "user", "content": f"Overall task: {run.request.task}\nSubtask ({step['id']}): {step['label']}\n\n"
                                    f"{tools}\n\nEarlier agents' outputs it depends on:\n{earlier}\n\nOutput to judge:\n{output}\n\n"
                                    f"Claims (id | claim | check status | evidence):\n{table}\n\nClaim check history: {checks}"},
    ]


async def reflect(run: Run, step: dict[str, Any], output: str, prior: dict[str, str], store: dict[str, dict[str, Any]],
                  served: dict[str, str] | None = None, info: dict[str, Any] | None = None,
                  claims: list[dict[str, Any]] | None = None, statuses: dict[str, str] | None = None,
                  history: list[str] | None = None) -> tuple[int, bool, str, list[str], str]:
    """(score, passed, reason, issues, judge model). An unusable verdict is a failure, never a pass.
    store: the agent's evidence store. served: filled with {"model": <id OpenRouter answered with>} when it
    reported one. info: filled with evidenceMode, judgeInputChars and evidenceChars (absent for the precheck).
    claims/statuses: the parsed claims and their mechanical check results, shown to the judge as a table.
    history: the claim-check failures of earlier attempts, one line each."""
    claims, statuses = claims or [], statuses or {}
    config = run.config
    model = config.models.get("reflection", "")
    failure = precheck(output)
    if failure:
        return 1, False, f"Precheck: {failure}", [failure], "deterministic precheck"
    evidence_chars = sum(len(c["result"]) for c in store.values())

    def build(mode: str) -> list[dict[str, Any]]:
        return judge_messages(run, step, output, prior, store, claims, statuses, mode, history)

    # Excerpts by default (spec A Phase 3); "full" only when the user chose it, and then only when it fits.
    full = config.judgeEvidenceMode == "full" and estimate_tokens(evidence_full(store)) <= judge_evidence_limit(run, model)
    mode = "full" if full else "excerpts"
    messages = build(mode)
    if mode == "full":  # never wait for budget to show everything: excerpts instead
        max_tokens, _, shortfall, _ = run.plan_request(model, messages, synthesis=False)
        if shortfall or (max_tokens is not None and max_tokens < JUDGE_MIN_COMPLETION_TOKENS):
            mode, messages = "excerpts", build("excerpts")
    sizes = {"evidenceMode": mode, "judgeInputChars": sum(len(m["content"]) for m in messages), "evidenceChars": evidence_chars}
    if info is not None:
        info.update(sizes)
    cap = role_max_tokens(config, "judge")
    for _try in range(2):  # one retry on an unusable reply
        verdict, _, _ = await ask(run, model, messages, effort=role_effort(config, "judge"), max_tokens_cap=cap,
                                  obs={"role": "reflection", "agentId": step["id"], "attempt": run.attempts.get(step["id"], 0), "retry": _try, **sizes})
        if verdict.get("model_served") and served is not None:
            served["model"] = verdict["model_served"]
        try:
            judgement = json.loads(re.search(r"\{.*\}", str(verdict.get("content") or ""), re.S).group(0))  # type: ignore[union-attr]
            score = max(1, min(5, int(judgement["score"])))
            reason = str(judgement.get("reason") or "No reason supplied")
            issues = [str(i)[:300] for i in judgement.get("issues") or [] if str(i).strip()][:8]
        except (AttributeError, ValueError, TypeError, KeyError):
            if verdict.get("truncated"):
                cap *= 2
            continue
        return score, score >= config.reflectionPassThreshold, reason, issues, model
    return 0, False, "gate unavailable", ["The reviewer did not return a usable verdict twice in a row"], model


CLAIM_LABEL = {"verified": "verified", "unverified_declared": "unverified"}


def downstream_text(agent_id: str, output: str, claims: list[dict[str, Any]], statuses: dict[str, str], header: str = "") -> str:
    """What dependants and synthesis see: the prose, a one-line claim status appendix, and for a step
    accepted with caveats a header line naming them."""
    labels = [f"{c['id']} " + (f"from {c['source']}" if statuses[c["id"]] == "source" else
                               "verified" if statuses[c["id"]].startswith("verified") else CLAIM_LABEL.get(statuses[c["id"]], "failed-check"))
              for c in claims]
    return (f"{header}\n" if header else "") + output + (f"\n\nClaims ({agent_id}): " + "; ".join(labels) if labels else "")


LOOP_NUDGE = ("Your previous reply got stuck repeating the same text and was stopped. "
              "Answer once, concisely, without repeating yourself.")


def repair_turn(score: int, reason: str, issues: list[str]) -> str:
    """The verdict as a new user turn: the worker keeps its tool results and fixes only what is flagged."""
    fixes = "".join(f"\n- {issue}" for issue in issues) or "\n- (no specific issues given)"
    return (f"Reviewer verdict: score {score}/5 — {reason}\nFix these, keeping everything that was fine:{fixes}\n"
            "You already have your tool results above. Re-check only what is flagged; do not repeat research you have already done. "
            "Reply with the full corrected answer and claims block.")


def candidate_refs(claim: dict[str, Any], store: dict[str, dict[str, Any]]) -> list[str]:
    """For a wrong_call claim: the snippet ids (or call ids, for results without snippets) whose text holds its quote."""
    refs: list[str] = []
    for call_id in claim.get("candidates", []):
        snippets = store.get(call_id, {}).get("snippets") or {}
        hits = [sid for sid, text in snippets.items() if quote_match(claim["quote"], text)]
        refs += hits or [call_id]
    return refs


def patch_turn(failing: list[dict[str, Any]], statuses: dict[str, str], store: dict[str, dict[str, Any]]) -> str:
    """Only some claims failed the mechanical check: re-send just those, with their class, and ask for a patch (spec A Phase 5)."""
    lines = []
    for c in failing:
        status = statuses[c["id"]]
        problem = CLAIM_PROBLEM[status].format(candidates="", missing=c.get("missing", ""))
        if status == "quote_found_elsewhere":
            problem = problem.split("; cite one of:")[0] + f"; candidate snippets: {', '.join(candidate_refs(c, store))}"
        lines.append(f"- {c['id']} [{failure_class(c, status)}]: {problem}. Your entry: {json.dumps({k: c[k] for k in ('id', 'claim', 'callId', 'quote', 'snippets') if k in c}, ensure_ascii=False)}")
    return ("Claims check: these claims failed; everything else in your report and its other claims are kept as they are.\n"
            + "\n".join(lines) + "\n"
            "Reply with ONLY a fenced claims_patch block and nothing else; do not rewrite the report:\n"
            "```claims_patch\n{\"replace\": [<full corrected entries for these claims>], \"drop\": [<ids of claims you cannot back>]}\n```\n"
            "A dropped claim stays in the report marked unverified.")


# ── Evidence stubs and evidence tools (spec A Phase 6) ──────────────────────
# A consumed tool result (any before the most recent round) is replaced in the history by a stub; the worker
# re-reads it with read_evidence / grep_evidence, answered here from the evidence store.

EVIDENCE_TOOLS = [
    {"name": "read_evidence", "description": "Re-read one of your earlier tool results, or one snippet of it, in full or a character range. "
                                             "Older results are shown in the conversation only as short stubs.",
     "parameters": {"type": "object", "properties": {"ref": {"type": "string", "description": "A snippet id like S3.2, or a callId"},
                                                     "start": {"type": "integer"}, "length": {"type": "integer"}}, "required": ["ref"]}},
    {"name": "grep_evidence", "description": "Search your earlier tool results for a pattern (regular expression, case-insensitive); "
                                             "returns matching lines with their snippet ids.",
     "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "callId": {"type": "string", "description": "Only this call's result"}},
                    "required": ["pattern"]}},
]
EVIDENCE_TOOL_NAMES = {tool["name"] for tool in EVIDENCE_TOOLS}
READ_EVIDENCE_DEFAULT_CHARS, READ_EVIDENCE_MAX_CHARS, GREP_MAX_LINES = 6_000, 20_000, 40
CALL_HEADER_RE = re.compile(r"^\[callId: ([^\]]+)\]")


def evidence_tool(name: str, raw_args: str, store: dict[str, dict[str, Any]]) -> str:
    try:
        args = json.loads(raw_args or "{}")
        if not isinstance(args, dict):
            raise ValueError
    except ValueError:
        return f"{name}: arguments must be a JSON object."
    snippets = {sid: text for c in store.values() for sid, text in (c.get("snippets") or {}).items()}
    if name == "read_evidence":
        ref = str(args.get("ref") or "")
        text = snippets.get(ref) if ref in snippets else store[ref]["result"] if ref in store else None
        if text is None:
            return f"No snippet or call {ref}. Known: {', '.join(list(snippets)[:60]) or '(none)'}."
        start = max(0, int(args.get("start") or 0))
        end = min(len(text), start + min(READ_EVIDENCE_MAX_CHARS, max(1, int(args.get("length") or READ_EVIDENCE_DEFAULT_CHARS))))
        return f"[{ref}] (chars {start}–{end} of {len(text)})\n{text[start:end]}"
    pattern = str(args.get("pattern") or "")
    try:
        regex = re.compile(pattern, re.I)
    except re.error:
        regex = re.compile(re.escape(pattern), re.I)
    only = str(args.get("callId") or "")
    hits = [f"[{sid}] {line.strip()[:300]}" for cid, c in store.items() if not only or cid == only
            for sid, text in (c.get("snippets") or {}).items() for line in text.splitlines() if line.strip() and regex.search(line)]
    return "\n".join(hits[:GREP_MAX_LINES]) + (f"\n… {len(hits) - GREP_MAX_LINES} more" if len(hits) > GREP_MAX_LINES else "") if hits else f"No match for {pattern}."


def evidence_stub(call_id: str, entry: dict[str, Any]) -> str:
    """What a consumed result shows in the history: enough to cite it and to decide whether to re-read it."""
    ids = list(entry.get("snippets") or {})
    titles = "; ".join(preview(text.split("\n", 1)[0].strip(), 60) for text in list((entry.get("snippets") or {}).values())[:5])
    span = f"{ids[0]}–{ids[-1]}" if len(ids) > 1 else ids[0] if ids else "no snippets"
    return (f"[callId: {call_id}] {entry['name']} {preview(entry['args'], 120)}: {len(ids)} snippets {span}, {len(entry['result']) / 1000:.1f} KB"
            f" — titles: {titles or '(none)'} — an earlier result shown as a stub; use read_evidence(\"{ids[0] if ids else call_id}\") or grep_evidence to see its text]")


def stub_consumed(messages: list[dict[str, Any]], store: dict[str, dict[str, Any]], stubbed: set[int]) -> int:
    """Stub every tool result before the most recent round (the tool messages after the last assistant turn that called
    tools). Returns the characters freed. Indices go into `stubbed` (shared with compact_to_fit, which skips them)."""
    last_call = max((i for i, m in enumerate(messages) if m.get("role") == "assistant" and m.get("tool_calls")), default=-1)
    freed = 0
    for index, message in enumerate(messages[:last_call]):
        if message.get("role") != "tool" or index in stubbed:
            continue
        content = str(message.get("content") or "")
        header = CALL_HEADER_RE.match(content)
        call_id = header.group(1) if header else str(message.get("tool_call_id"))
        entry = store.get(call_id)
        if entry is not None and entry["ok"]:
            stub = evidence_stub(call_id, entry)
        elif len(content) > 600:  # an evidence-tool output or a long failure text
            stub = f"[{preview(content, 200)} — {len(content)} chars, an earlier result shown as a stub; read it again if needed]"
        else:
            continue
        freed += len(content) - len(stub)
        message["content"] = stub
        stubbed.add(index)
    return freed


def compact_to_fit(run: Run, model: str, messages: list[dict[str, Any]], store: dict[str, dict[str, Any]],
                   compacted: set[int]) -> tuple[int, int] | None:
    """Only when the next request would not fit the model's context window (plan_request's test:
    1.25 × estimated prompt tokens plus a minimal reply), stub the oldest tool results one at a time
    until it does. The evidence store keeps every result, so quote checks and the judge lose nothing.
    Returns (results stubbed, tokens freed), or None when nothing was touched. Unknown window: never."""
    p = run.price(model)
    window = p.contextLength if p else 0

    def size() -> int:
        return estimate_tokens(json.dumps(messages))

    def fits() -> bool:
        return math.ceil(size() * 1.25) + MIN_REQUEST_TOKENS <= window

    if not window or fits():
        return None
    before, stubbed = size(), 0
    for index, message in enumerate(messages):
        if message.get("role") != "tool" or index in compacted:
            continue
        call = store.get(str(message.get("tool_call_id")))
        full = call["result"] if call else str(message.get("content") or "")
        label = f"{message.get('tool_call_id')} {call['name']} {preview(call['args'], 200)}" if call else str(message.get("tool_call_id"))
        message["content"] = f"[{label}: result compacted, {len(full)} chars, first 300 chars: {full[:300]}]"
        compacted.add(index)
        stubbed += 1
        if fits():
            return stubbed, before - size()
    raise ContextExceeded(f"Context window exceeded for {model}: the request does not fit even with every tool result compacted")


def covers_text(run: Run, step: dict[str, Any]) -> str:
    """The checklist requirements this step answers, and how to tag claims with them (spec B Phase 1)."""
    items = [c for c in run.checklist if c["id"] in step.get("covers", [])]
    if not items:
        return ""
    return ("\n\nRequirements this step covers. In the claims block, give each claim that answers one a \"req\" with its id "
            "(a list if it answers several), e.g. {\"id\": \"c1\", \"claim\": \"…\", \"snippets\": [\"S1.1\"], \"req\": \"r2\"}:\n"
            + "\n".join(f"- {c['id']}: {c['text']}" for c in items))


async def update_ledger(run: Run, steps: list[dict[str, Any]]) -> None:
    """Recompute the coverage ledger after a step ends and send it (no model call). No checklist, no ledger."""
    if not run.checklist:
        return
    run.ledger = compute_ledger(run.checklist, steps, run.step_results)
    await run.emit("ledger_update", ledger=run.ledger, counts=ledger_counts(run.ledger))


async def run_worker(run: Run, step: dict[str, Any], prior: dict[str, str]) -> str:
    config = run.config
    agent_id, role, model = step["id"], step["role"], step["model"]
    # From the second repair on, a stronger model may take over (spec A Phase 5); default: the worker model.
    escalation = config.models.get("escalation") or model
    allowed_tools = {str(t.get("name")) for t in run.request.tools}
    agent_tokens = 0
    agent_cost = 0.0
    run.attempts[agent_id] = 0
    store = run.evidence.setdefault(agent_id, {})
    await run.emit("agent_start", agentId=agent_id, role=role, model=model, attempt=0)

    context = ""
    if prior:
        context = "\n\nResults from the steps this one depends on (cite them by marker if you rely on them):\n" + "\n\n".join(f"[{k}] {v}" for k, v in prior.items())
    last_reason = ""
    # Say exactly what is available, so the agent never guesses at tools it does not have.
    tools_line = (f"Your tools: {', '.join(sorted(allowed_tools))}. Call them by these exact names, only when you need evidence. "
                  "Earlier tool results are shown as short stubs once you have read them; read_evidence and grep_evidence "
                  "re-read them (free, no approval), and their snippet ids stay citable."
                  if allowed_tools else "You have no tools in this run. Do not attempt tool calls; work from what you know.")
    offered = (run.request.tools + EVIDENCE_TOOLS) if run.request.tools else None
    # One conversation for every attempt: a repair continues it with the verdict as a new turn,
    # so tool results and the last answer are kept (Phase 4).
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": with_date(run, f"You are the {role} agent in a multi-agent team. Work independently on your subtask. "
                                      f"{tools_line} Never claim to have executed anything you did not. "
                                      "Mark any claim you could not verify with a tool as unverified. "
                                      "If a criterion cannot be verified with your tools, report it as unverified with the reason. Never report an "
                                      "unverifiable criterion as met or as failed, and do not eliminate an item only because data is missing; flag it instead."
                                      "\n\n" + claims_contract(config))},
        {"role": "user", "content": f"Overall task: {run.request.task}\n\nYour subtask ({agent_id}): {step['label']}{covers_text(run, step)}{context}"},
    ]
    compacted: set[int] = set()  # indices of tool messages already replaced by a stub
    # Every judged attempt with usable output (precheck passed), for 'degrade' on exhaustion.
    usable: list[dict[str, Any]] = []
    history: list[str] = []  # per attempt: its claim-check failures, shown to the judge
    # Set after a patch-only repair turn: the report and claims the next reply's claims_patch applies to.
    patch_base: dict[str, Any] | None = None

    def finish(output: str, claims: list[dict[str, Any]], statuses: dict[str, str], header: str = "") -> str:
        """The step's final answer: kept for the coverage ledger and handoffs (spec B), returned as the downstream text."""
        run.step_results[agent_id] = {"output": output, "claims": claims, "statuses": statuses}
        return downstream_text(agent_id, output, claims, statuses, header)

    async def exhausted(reason: str) -> str:
        """Retries are used up (or the attempt cannot continue): fail, or pass on the best usable attempt
        (highest score, ties to the latest) with its open issues. No usable attempt always fails."""
        if config.onRetryExhausted != "degrade" or not usable:
            raise AgentFailed(reason)
        best = max(usable, key=lambda a: (a["score"], a["attempt"]))
        await run.emit("agent_degraded", agentId=agent_id, attempt=best["attempt"], score=best["score"], issues=best["issues"],
                       claimStatuses=best["statuses"], claimFailureClasses=failure_classes(best["claims"], best["statuses"]), reason=reason)
        header = f"[{agent_id} DEGRADED: score {best['score']}/5; open issues: {'; '.join(best['issues'][:5]) or 'none listed'}]"
        return finish(best["output"], best["claims"], best["statuses"], header)

    for attempt in range(config.maxRetriesPerAgent + 1):
        run.attempts[agent_id] = attempt
        if attempt >= 2:
            model = escalation

        async def on_token(text: str, attempt: int = attempt) -> None:
            await run.emit("agent_token", agentId=agent_id, attempt=attempt, token=text)

        async def on_reasoning(text: str, attempt: int = attempt) -> None:
            await run.emit("agent_reasoning", agentId=agent_id, attempt=attempt, token=text)

        output = ""
        truncated: str | None = None
        served = ""
        looped = False
        stopped_at_limit = False
        no_answer_retried = False
        limit = config.maxToolRounds
        _round = 0
        try:
            while True:
                last_round = limit is not None and _round >= limit - 1
                if last_round and messages[-1].get("content") not in (TOOL_BUDGET_USED, NO_ANSWER_NUDGE):
                    messages.append({"role": "user", "content": TOOL_BUDGET_USED})
                stub_consumed(messages, store, compacted)
                freed = compact_to_fit(run, model, messages, store, compacted)
                if freed:
                    await run.emit("context_compacted", agentId=agent_id, attempt=attempt, stubbed=freed[0], tokensFreed=freed[1])
                stream = DsmlTokenFilter(on_token)
                reply, tokens, cost = await ask(run, model, messages, tools=None if last_round else offered,
                                                on_token=stream, on_reasoning=on_reasoning, loop_guard=True,
                                                obs={"role": "worker", "agentId": agent_id, "attempt": attempt, "toolRound": _round,
                                                     "retry": int(no_answer_retried)})
                await stream.flush()
                served = reply.get("model_served") or served
                agent_tokens += tokens
                agent_cost += cost
                if reply.get("looped"):
                    # What it produced is already in the trace (streamed tokens); the attempt fails.
                    looped = True
                    break
                calls = reply.get("tool_calls") or []
                text = str(reply.get("content") or "")
                if not calls:
                    # DSML tool calls in content: run them like native ones; never keep raw DSML as text.
                    dsml_calls, text = extract_dsml(text)
                    if dsml_calls and not last_round and run.request.tools:
                        calls = dsml_calls
                if not calls:
                    if is_no_answer(text) and not no_answer_retried and not reply.get("truncated"):
                        no_answer_retried = True  # same round again, once
                        if text.strip():
                            messages.append({"role": "assistant", "content": text})
                        messages.append({"role": "user", "content": NO_ANSWER_NUDGE})
                        continue
                    output = "" if is_no_answer(text) else text
                    truncated = reply.get("truncated")
                    stopped_at_limit = last_round
                    break
                assistant: dict[str, Any] = {"role": "assistant", "content": text, "tool_calls": calls}
                if reply.get("reasoning_details"):  # OpenRouter requires these back for tool-using reasoning models
                    assistant["reasoning_details"] = reply["reasoning_details"]
                messages.append(assistant)
                for index, call in enumerate(calls):
                    fn = call.get("function") or {}
                    name = str(fn.get("name") or "")
                    call_id = str(call.get("id") or f"{name}#{index}")
                    if call_id in store:  # ids repeat (DSML, or none from the provider): keep each call's evidence
                        call_id = call["id"] = f"{call_id}.{len(store)}"
                    raw_args = str(fn.get("arguments") or "{}")
                    server, _, local = name.partition("__")
                    await run.emit("tool_start", agentId=agent_id, attempt=attempt, callId=call_id, tool=local or name,
                                   server=server if local else "", argsPreview=preview(raw_args, ARGS_PREVIEW_CHARS))
                    began = time.monotonic()
                    started_at = now_ms()
                    ok = False
                    if name in EVIDENCE_TOOL_NAMES:  # answered here from the store: no approval, not new evidence
                        content = evidence_tool(name, raw_args, store)
                        run.record({"kind": "tool", "role": "worker", "agentId": agent_id, "attempt": attempt, "toolRound": _round,
                                    "callId": call_id, "name": name, "args": raw_args, "result": content, "approved": True, "denied": False, "error": None,
                                    "timing": {"startedAt": started_at, "endedAt": now_ms(), "ms": int((time.monotonic() - began) * 1000)}})
                        await run.emit("tool_done", agentId=agent_id, attempt=attempt, callId=call_id, ok=True, durationMs=int((time.monotonic() - began) * 1000),
                                       resultPreview=preview(content, RESULT_PREVIEW_CHARS), resultChars=len(content))
                        messages.append({"role": "tool", "tool_call_id": call.get("id") or name, "content": content})
                        continue

                    approval: dict[str, Any] = {}

                    def record_tool(result: str | None, approved: bool, denied: bool, error: str | None) -> None:
                        run.record({"kind": "tool", "role": "worker", "agentId": agent_id, "attempt": attempt, "toolRound": _round,
                                    "callId": call_id, "name": name, "args": raw_args, "result": result,
                                    "approved": approved, "denied": denied, "error": error,
                                    **({"approvalMode": approval["approvalMode"]} if "approvalMode" in approval else {}),
                                    "timing": {"startedAt": started_at, "endedAt": now_ms(), "ms": int((time.monotonic() - began) * 1000),
                                               **{k: approval[k] for k in ("waitMs", "toolMs") if k in approval}}})

                    try:
                        args = json.loads(raw_args)
                        if not isinstance(args, dict):
                            raise ValueError("tool arguments must be a JSON object")
                        server, local = split_tool_name(name, allowed_tools)
                    except (ValueError, TypeError) as exc:
                        content = f"Tool request rejected: {exc}"
                        record_tool(content, False, False, str(exc))
                    else:
                        try:
                            approved, result = await run.wait_for_approval(agent_id, role, model, local, server, args)
                        except AgentFailed as exc:  # approval timed out: auto-denied, the agent fails
                            record_tool(None, False, True, str(exc))
                            store[call_id] = {"name": name, "args": raw_args, "ok": False, "attempt": attempt, "result": f"Tool request denied: {exc}"}
                            raise
                        ok = approved
                        approval = run.approval_meta.pop(agent_id, {})
                        content = result if approved else f"Tool request denied: {result or 'denied by user'}"
                        record_tool(content, approved, not approved, None)
                    await run.emit("tool_done", agentId=agent_id, attempt=attempt, callId=call_id, ok=ok,
                                   durationMs=int((time.monotonic() - began) * 1000),
                                   resultPreview=preview(content, RESULT_PREVIEW_CHARS), resultChars=len(content), **approval)
                    snippets, view = ingest_result(content, len(store) + 1, str(args.get("query") or ""), config.claimFormat) if ok else ({}, content)
                    store[call_id] = {"name": name, "args": raw_args, "ok": ok, "attempt": attempt, "result": store_result(content), "snippets": snippets}
                    # A result that can back a claim carries its id (and, in snippet mode, each snippet its id) in the text;
                    # search results are trimmed in this view only (the store above keeps them in full).
                    content = view
                    messages.append({"role": "tool", "tool_call_id": call.get("id") or name, "content": f"[callId: {call_id}]\n{content}" if ok else content})
                _round += 1
        except BudgetReached:
            if not output:
                return await exhausted("budget cap reached before this agent produced an answer")
        if looped:
            last_reason = "repetition loop"
            if attempt < config.maxRetriesPerAgent and not run.budget_reached:
                await run.emit("retry", agentId=agent_id, attempt=attempt + 1, reason=last_reason)
                # The looped reply is never kept; the nudge is a new turn in the same conversation.
                messages.append({"role": "user", "content": LOOP_NUDGE})
                continue
            return await exhausted(last_reason)
        if not output:
            return await exhausted("no final answer (empty or only tool-call text, after one re-ask)")
        answer = output  # as written, claims block included: the conversation's last assistant turn on a repair
        patch, patch_error = parse_patch(output) if patch_base else (None, "")
        if patch is not None and patch_base:
            # A patch reply: the report is kept as written, the patch merged into its claims.
            output = patch_base["prose"]
            claims, parse_errors = apply_claims_patch(patch_base["claims"], patch)
        elif patch_error:
            output, claims, parse_errors = patch_base["prose"], [dict(c) for c in patch_base["claims"]], [patch_error]
        else:
            output, claims, parse_errors = parse_claims(output)
        parsed = [dict(c) for c in claims]  # before verify_claim fills/re-points them: what a later patch applies to
        await run.emit("agent_complete", agentId=agent_id, attempt=attempt, output=output, tokenCount=agent_tokens, costUsd=round(agent_cost, 8),
                       **({"truncated": truncated} if truncated else {}), **({"stoppedAtToolLimit": True} if stopped_at_limit else {}),
                       **({"modelServed": served} if served else {}))

        statuses = {c["id"]: verify_claim(c, store) for c in claims}
        if run.budget_reached:  # no reflection spend once the cap is reached; output kept as-is
            return finish(output, claims, statuses)
        await run.emit("reflection_start", agentId=agent_id, attempt=attempt)
        # Gate order: (a) precheck, (b) claims parse + mechanical quote check, (c) judge. A mechanical
        # failure goes straight to a repair turn with no judge spend, except on the last allowed attempt.
        mechanical = [] if precheck(output) else parse_errors + claim_problems(claims, statuses)
        judge_served: dict[str, str] = {}
        judge_info: dict[str, Any] = {}
        if mechanical and attempt < config.maxRetriesPerAgent:
            score, passed, reason, issues, judge = 1, False, f"Claims check: {len(mechanical)} problem(s)", mechanical, "claims check"
        else:
            try:
                score, passed, reason, issues, judge = await reflect(run, step, output, prior, store, judge_served, judge_info, claims, statuses, history)
            except BudgetReached:
                return finish(output, claims, statuses)
            if mechanical:  # last attempt: judged for a score, but it cannot pass with failing claims
                passed, reason, issues = False, f"{len(mechanical)} claim problem(s); reviewer: {reason}", (mechanical + issues)[:12]
        await run.emit("reflection_result", agentId=agent_id, attempt=attempt, score=score, passed=passed, reason=reason,
                       issues=issues, model=judge, rubric=REFLECTION_RUBRIC, **({"modelServed": judge_served["model"]} if judge_served else {}),
                       **{k: judge_info[k] for k in ("evidenceMode", "judgeInputChars") if k in judge_info},
                       claimsChecked=sum(1 for c in claims if "callId" in c or c.get("snippets")), claimsFailed=sum(1 for s in statuses.values() if s not in CLAIM_OK),
                       claimStatuses=statuses, claimFailureClasses=failure_classes(claims, statuses))
        classes = failure_classes(claims, statuses)
        history.append(f"attempt {attempt}: " + (", ".join(f"{k} {v}" for k, v in classes.items()) or "no claim failed"))
        if passed:
            return finish(output, claims, statuses)
        if not precheck(output):
            usable.append({"attempt": attempt, "output": output, "claims": claims, "statuses": statuses, "score": score, "issues": issues})
        if reason == "gate unavailable" and not mechanical and config.onRetryExhausted == "degrade":
            # No verdict is not a rejection: accept as unreviewed rather than re-asking the worker.
            await run.emit("agent_degraded", agentId=agent_id, attempt=attempt, score=0, issues=issues, claimStatuses=statuses,
                           claimFailureClasses=failure_classes(claims, statuses), reason="gate unavailable", unreviewed=True)
            return finish(output, claims, statuses, f"[{agent_id} UNREVIEWED: the reviewer was unavailable]")
        last_reason = f"score {score}/5: {reason}" if score else reason
        if attempt < config.maxRetriesPerAgent:
            escalate = attempt + 1 >= 2 and escalation != model
            await run.emit("retry", agentId=agent_id, attempt=attempt + 1, reason=reason, **({"escalated": True, "model": escalation} if escalate else {}))
            failing = [c for c in claims if statuses[c["id"]] not in CLAIM_OK]
            # Only some claims failed the mechanical check, the rest of the answer is fine: patch just those (spec A Phase 5).
            if mechanical and judge == "claims check" and not parse_errors and failing and len(failing) < len(claims):
                patch_base = {"prose": output, "claims": parsed}
                turn = patch_turn(failing, statuses, store)
            else:
                patch_base = None
                turn = repair_turn(score, reason, issues)
            messages += [{"role": "assistant", "content": answer}, {"role": "user", "content": turn}]
    return await exhausted(f"reflection retry limit exceeded ({last_reason})")


async def workers_node(state: dict[str, Any]) -> dict[str, Any]:
    """Ready-queue scheduler: a step starts as soon as every step it depends on
    has passed, up to maxAgents at once — never waiting for a whole phase."""
    run: Run = state["run"]
    steps: list[dict[str, Any]] = state["steps"]
    outputs: dict[str, str] = {}
    failures: dict[str, str] = {}
    pending = {s["id"]: s for s in steps}
    running: dict[asyncio.Task[str], dict[str, Any]] = {}

    async def fail(step_id: str, reason: str) -> None:
        pending.pop(step_id, None)
        failures[step_id] = reason
        run.step_results[step_id] = {"output": "", "claims": [], "statuses": {}}
        await run.emit("agent_failed", agentId=step_id, reason=reason, **run.attempt_of(step_id))
        await update_ledger(run, steps)

    try:
        while pending or running:
            changed = True
            while changed:  # dependency failures cascade down the graph
                changed = False
                for step_id, step in list(pending.items()):
                    failed_dep = next((d for d in step["dependsOn"] if d in failures), None)
                    if failed_dep:
                        await fail(step_id, f"dependency {failed_dep} failed")
                        changed = True
                    elif run.budget_reached:
                        await fail(step_id, "not started — budget cap reached")
                        changed = True
            ready = [s for s in pending.values() if all(d in outputs for d in s["dependsOn"])]
            for step in ready[: max(0, run.config.maxAgents - len(running))]:
                del pending[step["id"]]
                prior = {d: outputs[d] for d in step["dependsOn"]}
                running[asyncio.create_task(run_worker(run, step, prior))] = step
                run.active_workers = len(running)
            if not running:
                for step_id in list(pending):  # unreachable for a validated acyclic plan
                    await fail(step_id, "dependencies can never be satisfied")
                break
            done, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                step = running.pop(task)
                run.active_workers = len(running)
                if task.cancelled():
                    raise asyncio.CancelledError()
                error = task.exception()
                if error is None:
                    outputs[step["id"]] = task.result()
                    await update_ledger(run, steps)
                else:
                    await fail(step["id"], str(error) or type(error).__name__)
    finally:
        for task in running:  # abort: no agent outlives the run
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        run.active_workers = 0
    return {**state, "outputs": outputs, "failures": failures}


# ── Synthesis ────────────────────────────────────────────────────────────────

SYNTHESIS_SYSTEM = ("You synthesize a multi-agent team's work into one final answer for the user. "
                    "Merging is your job (the plan has no merge step): combine the agents' results, resolve conflicts between them, and "
                    "apply any exclusions or criteria the task states. "
                    "Cite every factual contribution with its source agent marker exactly as given, e.g. [1.1]. "
                    "Do not invent markers. If some agents failed, say what is missing. An agent output may end with its "
                    "claim statuses: drop or explicitly caveat any claim marked failed-check, and present unverified claims as "
                    "unverified. If an output is marked DEGRADED or UNREVIEWED, say that step's results were accepted with caveats.")

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
        {"role": "system", "content": with_date(run, SYNTHESIS_SYSTEM)},
        {"role": "user", "content": f"Task: {run.request.task}\n\nAgent outputs:\n\n{sources}" + (f"\n\nFailed agents:{missing}" if missing else "")},
    ]

    async def on_token(text: str) -> None:
        await run.emit("synthesis_token", token=text)

    truncated = None
    served = ""
    try:
        reply, _, _ = await ask(run, run.config.models.get("synthesizer", ""), prompt, on_token=on_token, synthesis=True,
                                obs={"role": "synthesis"})
        final = str(reply.get("content") or "")
        truncated = reply.get("truncated")
        served = reply.get("model_served") or ""
    except BudgetReached:
        # Remaining budget cannot cover even a short synthesis: deliver the
        # partial outputs verbatim, provenance intact, with zero extra spend.
        final = "Budget cap reached — partial results from the agents that finished:\n\n" + "\n\n".join(f"[{k}] {v}" for k, v in outputs.items())
        await run.emit("synthesis_token", token=final)
    await run.emit("task_complete", finalOutput=final, totalCostUsd=round(run.total_cost, 8), totalTokens=run.total_tokens,
                   **({"truncated": truncated} if truncated else {}), **({"modelServed": served} if served else {}))
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
    # One pool per run, sized so workers, reflection and synthesis can all overlap.
    run.executor = ThreadPoolExecutor(max_workers=run.config.maxAgents * 2 + 4, thread_name_prefix=f"run-{run.run_id[:8]}")
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
        run.cancelled = True  # streaming threads stop at their next chunk
        run.executor.shutdown(wait=False, cancel_futures=True)
        asyncio.get_running_loop().call_later(RUN_RETENTION_S, RUNS.pop, run.run_id, None)


# ── HTTP API (spec §03) ──────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "runs": sum(1 for r in RUNS.values() if not r.finished), "threads": threading.active_count()}


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
    meta = {k: v for k, v in {"approvalMode": response.approvalMode, "waitMs": response.waitMs, "toolMs": response.toolMs}.items() if v is not None}
    run.approval_meta[response.agentId] = meta
    future.set_result((response.approved, response.result or ""))
    await run.emit("hitl_resume", agentId=response.agentId, approved=response.approved, **run.attempt_of(response.agentId), **meta)
    return {"ok": True}


@app.post("/run/{run_id}/quick-plan")
async def quick_plan(run_id: str) -> dict[str, bool]:
    """Slow-plan escape hatch: stop the orchestrator and use the fallback plan (which still needs approval)."""
    run = RUNS.get(run_id)
    if not run:
        raise HTTPException(404, "run not found")
    if run.finished or any(e.get("type") == "orchestrator_plan" for e in run.events):
        raise HTTPException(409, "the run is no longer planning")
    run.quick_plan = True
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
