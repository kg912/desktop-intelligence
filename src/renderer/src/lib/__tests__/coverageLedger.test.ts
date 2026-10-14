// Spec B Phase 1: the planner's checklist and the sidecar's coverage ledger fold into the run view.
import { describe, it, expect } from 'vitest'
import { applyAgentEvent, emptyRunView, reduceRunEvents, runLogLine } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const STEPS = [
  { id: '1.1', label: 'Leg 1', stage: 'worker', role: 'Leg 1', model: 'w', phase: 1, dependsOn: [], covers: ['r1', 'r2'] },
  { id: '1.2', label: 'Leg 2', stage: 'worker', role: 'Leg 2', model: 'w', phase: 1, dependsOn: [], covers: ['r3'] },
]
const CHECKLIST = [{ id: 'r1', text: 'Airlines, leg 1', scope: '1.1' }, { id: 'r2', text: 'Times, leg 1', scope: '1.1' }, { id: 'r3', text: 'Days, leg 2', scope: '1.2' }]
const LEDGER = {
  r1: { status: 'verified', claimIds: ['1.1 c1'] },
  r2: { status: 'unverified', claimIds: ['1.1 c2'] },
  r3: { status: 'conflicted', claimIds: ['1.2 c1', '1.1 c4'], conflict: { claimIds: ['1.2 c1', '1.1 c4'], confirmed: false } },
}
const COUNTS = { verified: 1, unverified: 1, conflicted: 1, missing: 0, pending: 0 }
const EVENTS = [
  ev(1, { type: 'orchestrator_plan', steps: STEPS, checklist: CHECKLIST }),
  ev(2, { type: 'ledger_update', ledger: { ...LEDGER, r3: { status: 'pending', claimIds: [] } }, counts: { ...COUNTS, conflicted: 0, pending: 1 } }),
  ev(3, { type: 'ledger_update', ledger: LEDGER, counts: COUNTS }),
]

describe('coverage ledger in the run view', () => {
  it('keeps the checklist from the plan and the latest ledger', () => {
    const v = reduceRunEvents('run-1', EVENTS)
    expect(v.checklist).toEqual(CHECKLIST)
    expect(v.ledger).toEqual(LEDGER)
    expect(v.ledgerCounts).toEqual(COUNTS)
    expect(v.steps[0].covers).toEqual(['r1', 'r2'])
  })

  it('an older run has no checklist and no ledger', () => {
    const v = applyAgentEvent(emptyRunView('run-1'), ev(1, { type: 'orchestrator_plan', steps: STEPS }))
    expect(v.checklist).toBeUndefined()
    expect(v.ledger).toBeUndefined()
  })

  it('logs coverage, calling a heuristic conflict "possible"', () => {
    expect(runLogLine(EVENTS[2])?.text).toBe('Coverage: 1 of 3 verified, 1 unverified, 1 possible conflict')
  })
})

