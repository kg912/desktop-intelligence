"""Reads a recorded run fixture (tests/fixtures/runs/<name>/, the run-logger layout) for replay tests."""
import json
from pathlib import Path

RUNS = Path(__file__).parent / "tests" / "fixtures" / "runs"


def load(name: str = "istanbul-3leg") -> dict:
    """{"events": [...], "records": {agentId: [records]}, "meta": {...}}."""
    return load_dir(RUNS / name)


def load_dir(root: Path) -> dict:
    """The same for any run directory the run logger wrote."""
    records: dict[str, list[dict]] = {}
    for path in sorted(root.glob("*.jsonl")):
        if path.name == "events.jsonl":
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                records.setdefault(r.get("agentId") or r["role"], []).append(r)
    events = [json.loads(line) for line in (root / "events.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    return {"events": events, "records": records, "meta": json.loads((root / "run.meta.json").read_text(encoding="utf-8"))}


def store(recs: list[dict], attempt: int | None = None) -> dict[str, dict]:
    """The agent's evidence store as the sidecar built it (Run.evidence), up to and including `attempt`."""
    return {r["callId"]: {"name": r["name"], "args": r["args"], "ok": bool(r["approved"]) and not r["error"], "attempt": r["attempt"], "result": r["result"] or ""}
            for r in recs if r["kind"] == "tool" and (attempt is None or r["attempt"] <= attempt)}


def final_answer(recs: list[dict], attempt: int) -> str:
    """The worker's answer for an attempt: its last model call that requested no tools."""
    return [r for r in recs if r["kind"] == "model" and r["role"] == "worker" and r["attempt"] == attempt
            and not r["response"]["toolCalls"]][-1]["response"]["content"]


def worker_agents(run: dict) -> list[str]:
    return sorted(k for k, v in run["records"].items() if any(r["role"] == "worker" for r in v))
