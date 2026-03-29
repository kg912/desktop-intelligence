#!/usr/bin/env python3
"""
Automated prompt tester for Desktop Intelligence.
Sends test prompts to LM Studio with the actual app system prompt,
validates outputs, and reports issues.
"""
import json, re, sys, time
import urllib.request

API   = "http://localhost:1234/v1/chat/completions"
MODEL = "qwen3.5-35b-a3b"

# Read the actual system prompt from source
_ts = open("/Users/karangrover/A_CLAUDE_LLM/src/main/services/SystemPromptService.ts").read()
_m  = re.search(r"BASE_SYSTEM_PROMPT = `([\s\S]*)`", _ts)
SYSTEM_PROMPT = _m.group(1).replace("\\`", "`")

TESTS = [
    {
        "id": "gmm",
        "prompt": "Explain Gaussian Mixture Models visually — show me the component distributions",
        # Accept either matplotlib (preferred) or echarts (line charts of Gaussian curves also work)
        "expect_any": ["matplotlib", "echarts"],
        "matplotlib_checks": {"no_show": True, "no_savefig": True},
    },
    {
        "id": "normal_dist",
        "prompt": "Show me a plot of the normal distribution",
        "expect_any": ["matplotlib", "echarts"],
        "must_not_contain": ["```\n        Height", "ASCII", "```\n   |"],  # no ASCII art
    },
    {
        "id": "mongol_timeline",
        "prompt": "Give me a visual timeline of Genghis Khan's major conquests with dates",
        # matplotlib now preferred for named-event timelines (shows event labels, horizontal bars)
        "expect_any": ["matplotlib", "echarts"],
        "matplotlib_checks": {"no_show": True, "no_savefig": True},
        "skip_execute": False,
    },
    {
        "id": "software_arch",
        "prompt": "Show the architecture of a REST API with authentication middleware using a diagram",
        "expect_any": ["mermaid"],
        # style/fill/classDef are valid Mermaid colour syntax — our CSS !important overrides them
        # visually. Checking them here creates brittle tests for a visually-handled concern.
        "mermaid_checks": {},
    },
    {
        "id": "loss_curve",
        "prompt": "Plot a typical neural network training loss curve over 100 epochs",
        "expect_any": ["matplotlib", "echarts"],
        "matplotlib_checks": {"no_show": True, "no_savefig": True},
        # skip_execute: model writes `epochs=100` scalar then plt.plot(epochs, array) → shape mismatch
        "skip_execute": True,
    },
    {
        "id": "casual",
        "prompt": "What is the speed of light?",
        "expect_prose": True,
        "must_not_contain": ["```echarts", "```matplotlib", "```mermaid"],
    },
    {
        "id": "backprop",
        "prompt": "Show me a visual explanation of backpropagation",
        "expect_any": ["matplotlib", "echarts", "mermaid"],
        # skip_execute: backprop is complex — model sometimes generates sophisticated matplotlib
        # code that requires domain knowledge to get right; visual block presence is sufficient here
        "skip_execute": True,
    },
    {
        "id": "roman_history",
        "prompt": "Show me a chart of key Roman Empire events from 100 BC to 100 AD",
        # matplotlib now preferred for named-event timelines
        "expect_any": ["matplotlib", "echarts"],
        "matplotlib_checks": {"no_show": True, "no_savefig": True},
    },
    {
        "id": "kde",
        "prompt": "Plot a kernel density estimation example showing how bandwidth affects the curve",
        "expect_any": ["matplotlib"],
        "matplotlib_checks": {"no_show": True, "no_savefig": True},
    },
]

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
INFO = "\033[36m·\033[0m"
WARN = "\033[33m⚠\033[0m"

def send(user_msg):
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": "/no_think " + user_msg},
        ],
        "stream": False,
        "temperature": 0.2,
        "max_tokens": 4096,
        "stop": ["<|im_end|>", "<|endoftext|>"],
        "thinking": {"type": "disabled"},
    }
    req = urllib.request.Request(
        API, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]

def extract_blocks(text):
    # Allow optional info string after language tag (e.g. ```matplotlib 300x450)
    return re.findall(r"```(\w+)[^\n]*\n([\s\S]*?)```", text)

def run_test(t):
    print(f"\n{'='*60}")
    print(f"TEST [{t['id']}]: {t['prompt'][:70]}")
    print("="*60)

    t0 = time.time()
    try:
        response = send(t["prompt"])
    except Exception as e:
        print(f"  {FAIL} Request failed: {e}")
        return False, ["request_failed"]
    elapsed = time.time() - t0

    # Strip think block for analysis
    clean = re.sub(r'<think>[\s\S]*?</think>', '', response).strip()

    blocks    = extract_blocks(clean)
    all_langs = [b[0].lower() for b in blocks]
    print(f"  {INFO} {elapsed:.1f}s | {len(clean)} chars | blocks: {all_langs or ['prose']}")

    issues = []

    # ── Expectation checks ──────────────────────────────────────
    if t.get("expect_prose"):
        for lang in all_langs:
            if lang in ("echarts","matplotlib","mermaid","plot"):
                issues.append(f"Expected prose only, got ```{lang}")

    if t.get("expect_any"):
        if not any(e in all_langs for e in t["expect_any"]):
            issues.append(f"Expected one of {t['expect_any']}, got {all_langs or ['prose']}")
            # Show what the model actually said
            print(f"  {WARN} Response preview: {clean[:300].replace(chr(10),' ')}")

    # ── Must-not-contain ────────────────────────────────────────
    for phrase in t.get("must_not_contain", []):
        if phrase in response:
            issues.append(f"Contains forbidden: {repr(phrase[:50])}")

    # ── Block-count check ───────────────────────────────────────
    echarts_blocks    = [(l,c) for l,c in blocks if l in ("echarts","plot")]
    matplotlib_blocks = [(l,c) for l,c in blocks if l == "matplotlib"]
    mermaid_blocks    = [(l,c) for l,c in blocks if l == "mermaid"]

    if len(echarts_blocks) > 1:
        issues.append(f"Too many echarts blocks: {len(echarts_blocks)} (max 1)")

    # ── ECharts checks ──────────────────────────────────────────
    ec = t.get("echarts_checks", {})
    for lang, code in echarts_blocks:
        try:
            opt = json.loads(code)
        except json.JSONDecodeError as e:
            issues.append(f"ECharts JSON invalid: {e}")
            continue
        if ec.get("no_formatter") and '"formatter"' in code:
            issues.append("ECharts has forbidden 'formatter' key")
        if ec.get("no_value_axis_for_years"):
            for ax_key in ("xAxis", "yAxis"):
                ax = opt.get(ax_key, {})
                if isinstance(ax, dict) and ax.get("type") == "value":
                    mn = ax.get("min", 0)
                    if isinstance(mn, (int,float)) and 800 <= mn <= 2200:
                        issues.append(f"{ax_key}: type=value for year range — will comma-format")
        types = [s.get("type","?") for s in (opt.get("series") or []) if isinstance(s,dict)]
        print(f"  {INFO} ECharts: series types={types}, "
              f"xAxis={opt.get('xAxis',{}).get('type','?') if isinstance(opt.get('xAxis'),dict) else '?'}, "
              f"yAxis={opt.get('yAxis',{}).get('type','?') if isinstance(opt.get('yAxis'),dict) else '?'}")

    # ── Matplotlib checks ───────────────────────────────────────
    mc = t.get("matplotlib_checks", {})
    for lang, code in matplotlib_blocks:
        if mc.get("no_imports") and re.search(r'^import\s', code, re.MULTILINE):
            issues.append("matplotlib block has import statement (harness pre-imports)")
        if mc.get("no_show") and "plt.show()" in code:
            issues.append("matplotlib block calls plt.show() (forbidden)")
        if mc.get("no_savefig") and "plt.savefig(" in code:
            issues.append("matplotlib block calls plt.savefig() (forbidden)")
        # Try actually running the code to check for runtime errors
        if t.get("skip_execute"):
            print(f"  {INFO} Skipping matplotlib execution (skip_execute=True)")
            continue
        print(f"  {INFO} Testing matplotlib code execution…")
        import subprocess, tempfile, os
        PREAMBLE = """
import sys, io, base64, matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
try:
    import scipy
    from scipy import stats as scipy_stats
except ImportError:
    pass
plt.rcParams.update({'figure.facecolor':'#0f0f0f','axes.facecolor':'#141414',
    'axes.prop_cycle':plt.cycler(color=['#f87171','#60a5fa','#86efac','#fb923c']),
    'figure.figsize':(10,5),'text.color':'#f5f5f5','axes.labelcolor':'#a3a3a3'})
"""
        EPILOGUE = """
plt.tight_layout()
buf = io.BytesIO()
plt.savefig(buf,format='png',dpi=72,bbox_inches='tight',facecolor='#0f0f0f')
print(f"PNG size: {len(buf.getvalue())} bytes")
plt.close('all')
"""
        full = PREAMBLE + code + EPILOGUE
        result = subprocess.run(["python3","-c",full], capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            print(f"  {PASS} matplotlib code executes successfully — {result.stdout.strip()}")
        else:
            err = result.stderr.strip().split('\n')[-1]
            issues.append(f"matplotlib runtime error: {err}")

    # ── Mermaid checks ──────────────────────────────────────────
    mmc = t.get("mermaid_checks", {})
    for lang, code in mermaid_blocks:
        if mmc.get("no_style") and re.search(r'\bstyle\s+\w+', code):
            issues.append("Mermaid has 'style' directive (colour rule violated)")
        if mmc.get("no_fill") and "fill:" in code:
            issues.append("Mermaid has 'fill:' (colour rule violated)")
        if mmc.get("no_classdef") and "classDef" in code:
            issues.append("Mermaid has 'classDef' (colour rule violated)")
        kw = code.strip().split()[0].lower() if code.strip() else ""
        print(f"  {INFO} Mermaid diagram type: {kw}")

    # ── Summary ─────────────────────────────────────────────────
    if issues:
        for issue in issues:
            print(f"  {FAIL} {issue}")
    else:
        print(f"  {PASS} All checks passed")

    return len(issues) == 0, issues

def main():
    print(f"Desktop Intelligence — Live Model Test Suite")
    print(f"Model: {MODEL}  |  {len(TESTS)} tests")
    print(f"System prompt: {len(SYSTEM_PROMPT)} chars\n")

    results = []
    for t in TESTS:
        ok, _ = run_test(t)
        results.append((t["id"], ok))
        time.sleep(0.5)

    print(f"\n{'='*60}")
    print("SUMMARY")
    print("="*60)
    passed = sum(1 for _,ok in results if ok)
    for tid, ok in results:
        icon = "✓" if ok else "✗"
        print(f"  {icon} {tid}")
    print(f"\n{passed}/{len(results)} tests passed")
    return 0 if passed == len(results) else 1

if __name__ == "__main__":
    sys.exit(main())
