"""max_tokens is bounded only by the budget allowance and the model's remaining context window.
Regression: a cheap model + $0.50 cap once produced max_tokens=1.56M (> 131k context) → OpenRouter 400.
Part F: no fixed 32,768 / 2,000 caps; unpriced models send no max_tokens."""
import math
from types import SimpleNamespace

import multi_agent_sidecar as s

MESSAGES = [{"role": "user", "content": "x" * 1000}]
PROMPT = s.estimate_tokens(s.json.dumps(MESSAGES))


def plan(pricing, synthesis=False):
    run = SimpleNamespace(
        config=SimpleNamespace(budgetCapUsd=0.5, models={}), total_cost=0.0, reserved=0.0, active_workers=0,
        request=SimpleNamespace(pricing={"m": pricing} if pricing else {}),
    )
    run.price = lambda m: s.Run.price(run, m)
    run.synthesis_reserve = lambda: 0.0
    tokens, _, _, bound = s.Run.plan_request(run, "m", MESSAGES, synthesis=synthesis)
    return tokens, bound


if __name__ == "__main__":
    assert not hasattr(s, "MAX_COMPLETION_TOKENS") and not hasattr(s, "SYNTHESIS_MAX_COMPLETION_TOKENS")
    cheap = dict(prompt=1e-8, completion=3.2e-7)
    room = 131072 - math.ceil(PROMPT * 1.25)
    assert plan(s.Pricing(**cheap, contextLength=131072)) == (room, "context")  # context binds, well above 32,768
    assert plan(s.Pricing(**cheap, contextLength=131072), synthesis=True) == (room, "context")  # no 2,000 synthesis cap
    assert plan(s.Pricing(**cheap, contextLength=8192)) == (8192 - math.ceil(PROMPT * 1.25), "context")
    budget_only = math.floor((0.5 - PROMPT * 1e-8) / 3.2e-7)
    assert plan(s.Pricing(**cheap)) == (budget_only, "budget")  # context unknown → the budget alone
    dear = s.Pricing(prompt=1e-5, completion=1e-4, contextLength=131072)
    assert plan(dear) == (math.floor((0.5 - PROMPT * 1e-5) / 1e-4), "budget")  # budget still binds
    assert plan(None) == (None, None) and plan(None, synthesis=True) == (None, None)  # unpriced: no max_tokens
    print("ok")
