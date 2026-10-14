"""Spec B Phase 4: a dependent step reads its dependencies' evidence by id (read_evidence("1.1/S1.1")), sees their
verified claims as a list, and may cite their snippets; a step cannot read evidence of a step it does not depend on
unless its plan entry says "evidence": "global"."""
import json

import fake_harness as h

RESULT = "Pegasus flies ASR to ADB on Mon, Wed and Fri in December."


def plan(*steps):
    return {"steps": list(steps), "checklist": [{"id": "r1", "text": "Days, leg 2", "scope": "1.1"}]}


LEG = {"id": "1.1", "label": "Leg 2 days", "role": "Leg 2", "dependsOn": [], "covers": ["r1"]}
FACTS = {"1.1": [("Pegasus flies ASR-ADB Mon, Wed, Fri", "r1", "verified")]}


def reader(ref, cite):
    """A worker that reads one evidence ref (no search), then cites `cite`."""
    def reply(_agent, body):
        tool_msgs = [m for m in body["messages"] if m["role"] == "tool"]
        if not tool_msgs:
            return {"tool_calls": [{"id": "call_read", "type": "function", "function": {"name": "read_evidence", "arguments": json.dumps({"ref": ref})}}]}
        return {"content": h.answer("The schedule from the leg step holds for December, as cited below [c1].",
                                    [{"id": "c1", "claim": "Pegasus flies ASR-ADB Mon, Wed, Fri", "snippets": [cite], "req": "r1"}])}
    return reply


def run_with(step, worker_for_step):
    research = h.researcher(FACTS)
    route = lambda agent, body: worker_for_step(agent, body) if agent == step["id"] else research(agent, body)
    return h.run(plan(LEG, step), route, tool_result=RESULT, maxWaves=1)


def statuses(run, agent):
    return [e["claimStatuses"] for e in h.events(run, "reflection_result") if e["agentId"] == agent][-1]


def read_result(fake, agent):
    return next(m["content"] for a, body in fake.of("worker") if a == agent for m in body["messages"] if m["role"] == "tool")


def test_a_dependent_step_reads_and_cites_its_dependency_snippet():
    step = {"id": "2.1", "label": "Check the leg-2 days", "role": "Checker", "dependsOn": ["1.1"]}
    run, fake = run_with(step, reader("1.1/S1.1", "1.1/S1.1"))
    assert RESULT in read_result(fake, "2.1")
    assert statuses(run, "2.1") == {"c1": "verified"}
    task = next(body["messages"][1]["content"] for a, body in fake.of("worker") if a == "2.1")
    assert "Verified claims of the steps you depend on" in task and "- 1.1 c1: Pegasus flies ASR-ADB Mon, Wed, Fri [1.1/S1.1]" in task
    # The judge sees the dependency's excerpt for the cross-agent citation.
    judge = next(body for a, body in fake.of("judge") if a == "2.1")
    assert RESULT in judge["messages"][1]["content"]


def test_no_access_to_a_step_it_does_not_depend_on():
    step = {"id": "1.2", "label": "Leg 3 days", "role": "Leg 3", "dependsOn": []}
    run, fake = run_with(step, reader("1.1/S1.1", "1.1/S1.1"))
    assert read_result(fake, "1.2") == "Evidence of 1.1 is not available to step 1.2: it does not depend on 1.1."
    assert statuses(run, "1.2") == {"c1": "snippet_not_found"}


def test_global_step_reads_any_step_and_others_only_their_dependencies():
    middle = {"id": "2.1", "label": "Leg 3 days", "role": "Leg 3", "dependsOn": ["1.1"]}
    research = h.researcher(FACTS)

    def go(**flag):
        step = {"id": "3.1", "label": "Cross-check", "role": "Checker", "dependsOn": ["2.1"], **flag}
        route = lambda agent, body: reader("1.1/S1.1", "1.1/S1.1")(agent, body) if agent == "3.1" else research(agent, body)
        return h.run(plan(LEG, middle, step), route, tool_result=RESULT, maxWaves=1)
    run, fake = go(evidence="global")
    assert RESULT in read_result(fake, "3.1") and statuses(run, "3.1") == {"c1": "verified"}
    run, fake = go()  # 1.1 is only a transitive dependency of 3.1: not readable
    assert read_result(fake, "3.1") == "Evidence of 1.1 is not available to step 3.1: it does not depend on 1.1."
    assert statuses(run, "3.1") == {"c1": "snippet_not_found"}
