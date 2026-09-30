"""Regression: a cheap model + $0.50 cap once produced max_tokens=1.56M (> 131k context) → OpenRouter 400."""
from types import SimpleNamespace

import multi_agent_sidecar as s


def plan(pricing, synthesis=False):
    run = SimpleNamespace(
        config=SimpleNamespace(budgetCapUsd=0.5, models={}), total_cost=0.0, reserved=0.0,
        request=SimpleNamespace(pricing={"m": pricing}),
    )
    run.price = lambda m: s.Run.price(run, m)
    run.synthesis_reserve = lambda: 0.0
    return s.Run.plan_request(run, "m", [{"role": "user", "content": "x" * 1000}], synthesis=synthesis)[0]


if __name__ == "__main__":
    cheap = dict(prompt=1e-8, completion=3.2e-7)
    assert plan(s.Pricing(**cheap, contextLength=131072)) <= s.MAX_COMPLETION_TOKENS
    assert plan(s.Pricing(**cheap, contextLength=8192)) < 8192 - 250
    assert plan(s.Pricing(**cheap)) == s.MAX_COMPLETION_TOKENS  # context unknown → hard ceiling
    assert plan(s.Pricing(prompt=1e-5, completion=1e-4, contextLength=131072)) < 5000  # budget still binds
    print("ok")
