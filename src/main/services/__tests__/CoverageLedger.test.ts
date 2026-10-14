// Spec B Phase 1: the planner's checklist and the sidecar's coverage ledger reach the run view and run.md.
// The ledger itself is computed in the sidecar (resources/python/test_ledger.py).
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-coverage-ledger-test' } }))

import { renderRunMd, summarise } from '../MultiAgentRunLogger'
import type { RunLogMeta } from '../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import { isAgentEvent } from '../../../shared/agentEvents'
import type { AgentEvent } from '../../../shared/types'

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

describe('run.md: coverage section', () => {
  const meta: RunLogMeta = { schema: 1, runId: 'run-1', chatId: 'c', chatTitle: 'c', task: 't', startedAt: 1, endedAt: 2, status: 'completed', config: DEFAULT_MULTI_AGENT_CONFIG }

  it('renders the final ledger', () => {
    const md = renderRunMd(meta, EVENTS, [], summarise(meta, EVENTS, []))
    expect(md).toContain('## Coverage')
    expect(md).toContain('| r1 | Airlines, leg 1 | 1.1 | verified | 1.1 c1 |')
    expect(md).toContain('| r3 | Days, leg 2 | 1.2 | possible conflict (1.2 c1 vs 1.1 c4) | 1.2 c1, 1.1 c4 |')
  })

  it('says so when the planner wrote no checklist', () => {
    const events = [EVENTS[0]].map((e) => ({ ...e, checklist: undefined })) as AgentEvent[]
    expect(renderRunMd(meta, events, [], summarise(meta, events, []))).toContain('No checklist: the planner wrote none, so the ledger and the assess step were off.')
  })
})

describe('ledger_update validation', () => {
  it('accepts the sidecar event and rejects a malformed ledger', () => {
    expect(isAgentEvent(EVENTS[2])).toBe(true)
    expect(isAgentEvent({ ...EVENTS[2], ledger: { r1: { status: 'verified' } } })).toBe(false)
    expect(isAgentEvent({ ...EVENTS[2], ledger: [] })).toBe(false)
  })
})
