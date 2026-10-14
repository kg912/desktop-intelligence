"""Replay one stage of a recorded multi-agent run (spec B Phase 6) with the current code, to iterate on the judge or the
synthesizer without re-running the workers.

  python replay.py <run dir | fixture name> --stage judge|synthesize [--model m] [--prompt-file f] [--dry-run]

The run directory is the run logger's (events.jsonl + one .jsonl of call records per agent/role); a bare name is a
fixture under tests/fixtures/runs. judge: every judged attempt is rebuilt from its recorded judge request (task,
subtask, output, earlier agents' outputs), its evidence and its claims; claim statuses are recomputed by the current
verifier (deterministic) and the judge is called again. synthesize: the recorded synthesis input goes to the current
synthesis prompt. Prints the cost (model calls of that stage only) and a diff against the recording. --dry-run makes
no model call. OPENROUTER_API_KEY must be set otherwise."""
from __future__ import annotations

import argparse
import asyncio
import difflib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import fixture_run
import multi_agent_sidecar as s

JUDGE_SECTION = re.compile(r"Overall task: (?P<task>.*?)\nSubtask \((?P<id>[^)]*)\): (?P<label>.*?)\n\n.*?"
                           r"Earlier agents' outputs it depends on:\n(?P<prior>.*?)\n\nOutput to judge:\n(?P<output>.*?)\n\nClaims \(id \|", re.S)
NOT_A_JUDGE = {"claims check", "deterministic precheck"}


def load(target: str) -> dict[str, Any]:
    path = Path(target)
    return fixture_run.load_dir(path) if (path / "events.jsonl").exists() else fixture_run.load(target)


def run_for(fx: dict[str, Any], api_key: str, task: str = "") -> s.Run:
    meta = fx["meta"]
    run = s.Run(meta["runId"], s.RunRequest(runId=meta["runId"], chatId=meta["chatId"], task=task or meta["task"], config=s.Config(**meta["config"]),
                                            openRouterApiKey=api_key or "dry-run", currentDateTime="Current date and time: replay."))
    run.executor = s.ThreadPoolExecutor(max_workers=4)
    return run


def judge_cases(fx: dict[str, Any]) -> list[dict[str, Any]]:
    """Every attempt the recorded run sent to a judge, rebuilt with the current claims check."""
    recorded = {(e["agentId"], e.get("attempt", 0)): e for e in fx["events"] if e["type"] == "reflection_result" and e.get("model") not in NOT_A_JUDGE}
    cases = []
    for agent in fixture_run.worker_agents(fx):
        recs = fx["records"][agent]
        for judge in (r for r in recs if r["kind"] == "model" and r["role"] == "reflection"):
            m = JUDGE_SECTION.search(judge["request"]["messages"][1]["content"])
            attempt = judge["attempt"]
            _, claims, _ = s.parse_claims(fixture_run.final_answer(recs, attempt))
            store = fixture_run.store(recs, attempt)
            statuses = {c["id"]: s.verify_claim(c, store) for c in claims}
            event = recorded.get((agent, attempt), {})
            cases.append({"agent": agent, "attempt": attempt, "task": m["task"], "step": {"id": agent, "label": m["label"]},
                          "output": m["output"], "prior": {} if m["prior"].startswith("(this step") else {"*": m["prior"]},
                          "store": store, "claims": claims, "statuses": statuses,
                          "recorded": {"statuses": event.get("claimStatuses", {}), "score": event.get("score"), "passed": event.get("passed"),
                                       "costUsd": (judge.get("usage") or {}).get("costUsd") or 0.0}})
    return cases


def status_diff(cases: list[dict[str, Any]]) -> list[tuple[str, int, str, str, str]]:
    """(agent, attempt, claim, recorded status, status now) where the current verifier differs from the recording."""
    return [(c["agent"], c["attempt"], cid, c["recorded"]["statuses"].get(cid, "—"), now) for c in cases
            for cid, now in c["statuses"].items() if c["recorded"]["statuses"].get(cid) != now]


async def replay_judge(fx: dict[str, Any], *, api_key: str = "", model: str | None = None, system: str | None = None,
                       dry_run: bool = False) -> dict[str, Any]:
    cases = judge_cases(fx)
    verdicts, cost = [], 0.0
    for case in cases:
        if dry_run:
            continue
        run = run_for(fx, api_key, case["task"])
        if model:
            run.request.config.models["reflection"] = model
        if system:
            original = s.judge_messages

            def patched(*a, **k):
                msgs = original(*a, **k)
                return [{**msgs[0], "content": system}, *msgs[1:]]
            s.judge_messages = patched
        try:
            score, passed, reason, issues, judge = await s.reflect(run, case["step"], case["output"], case["prior"], case["store"], {}, {},
                                                                  case["claims"], case["statuses"], [])
        finally:
            if system:
                s.judge_messages = original
        cost += run.total_cost
        verdicts.append({"agent": case["agent"], "attempt": case["attempt"], "recorded": (case["recorded"]["score"], case["recorded"]["passed"]),
                         "now": (score, passed), "reason": reason})
    return {"cases": cases, "statusDiff": status_diff(cases), "verdicts": verdicts, "costUsd": cost, "calls": len(verdicts),
            "recordedCostUsd": sum(c["recorded"]["costUsd"] for c in cases)}


async def replay_synthesis(fx: dict[str, Any], *, api_key: str = "", model: str | None = None, system: str | None = None,
                           dry_run: bool = False) -> dict[str, Any]:
    record = next(r for r in fx["records"]["synthesis"] if r["kind"] == "model")
    recorded = next((e["finalOutput"] for e in fx["events"] if e["type"] == "task_complete"), "")
    date_line = record["request"]["messages"][0]["content"].rsplit("\n\n", 1)[-1]
    messages = [{"role": "system", "content": system or f"{s.SYNTHESIS_SYSTEM}\n\n{date_line}"}, record["request"]["messages"][1]]
    if dry_run:
        return {"text": "", "recorded": recorded, "diff": [], "costUsd": 0.0, "calls": 0, "messages": messages}
    run = run_for(fx, api_key)
    reply, _, cost = await s.ask(run, model or fx["meta"]["config"]["models"]["synthesizer"], messages, synthesis=True, obs={"role": "synthesis"})
    text = str(reply.get("content") or "")
    diff = list(difflib.unified_diff(recorded.splitlines(), text.splitlines(), "recorded", "replay", lineterm=""))
    return {"text": text, "recorded": recorded, "diff": diff, "costUsd": cost, "calls": 1, "messages": messages}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("run")
    parser.add_argument("--stage", choices=["judge", "synthesize"], required=True)
    parser.add_argument("--model")
    parser.add_argument("--prompt-file", help="replaces the stage's system prompt")
    parser.add_argument("--dry-run", action="store_true", help="no model calls: claim statuses and inputs only")
    args = parser.parse_args(argv)
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key and not args.dry_run:
        print("OPENROUTER_API_KEY is not set (use --dry-run to replay without model calls)", file=sys.stderr)
        return 2
    fx = load(args.run)
    system = Path(args.prompt_file).read_text(encoding="utf-8") if args.prompt_file else None
    if args.stage == "judge":
        out = asyncio.run(replay_judge(fx, api_key=api_key, model=args.model, system=system, dry_run=args.dry_run))
        print(f"Judged attempts: {len(out['cases'])}")
        for c in out["cases"]:
            failing = sorted(cid for cid, st in c["statuses"].items() if st not in s.CLAIM_OK)
            print(f"  {c['agent']} attempt {c['attempt']}: {len(c['claims'])} claims, failing now: {', '.join(failing) or 'none'}")
        print(f"Claim statuses that differ from the recording: {len(out['statusDiff'])}")
        for agent, attempt, cid, was, now in out["statusDiff"]:
            print(f"  {agent} a{attempt} {cid}: {was} -> {now}")
        for v in out["verdicts"]:
            print(f"  verdict {v['agent']} a{v['attempt']}: recorded {v['recorded'][0]}/5 {'pass' if v['recorded'][1] else 'fail'}"
                  f" -> now {v['now'][0]}/5 {'pass' if v['now'][1] else 'fail'}")
    else:
        out = asyncio.run(replay_synthesis(fx, api_key=api_key, model=args.model, system=system, dry_run=args.dry_run))
        print("\n".join(out["diff"]) or ("(dry run: no synthesis)" if args.dry_run else "(identical to the recording)"))
    print(f"Model calls: {out['calls']}, cost ${out['costUsd']:.6f}" + (f" (recorded judge calls: ${out['recordedCostUsd']:.6f})" if "recordedCostUsd" in out else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
