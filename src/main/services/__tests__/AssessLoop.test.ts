// Spec B Phase 2: assess_start / assess_decision / wave_start reach the run log and run.md, and are validated.
// The decision logic and stop rules are in the sidecar (resources/python/test_assess.py).
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-assess-loop-test' } }))

import { renderRunMd, summarise, summariseRun } from '../MultiAgentRunLogger'
import type { CallRecord, RunLogMeta } from '../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import { isAgentEvent } from '../../../shared/agentEvents'
import type { AgentEvent } from '../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const RULES = { checklist: { open: 2, total: 3 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.31, capUsd: 1 }, progress: 'first', tools: 'partly' }
const STEP = { id: '2.1', label: 'Settle ASR-ADB days', stage: 'worker', role: 'Follow-up', model: 'w', phase: 2, dependsOn: ['1.1'], covers: ['r1'], wave: 2, task: 'Check the airline pages.' }
export const ASSESS_EVENTS = [
  ev(10, { type: 'assess_start', wave: 1, open: 2 }),
  ev(11, { type: 'assess_decision', wave: 1, decision: 'follow_up', reason: 'One conflict can be settled.', steps: [STEP],
    unclosable: [{ checklistId: 'r2', reason: 'no available tool can close this gap (needs web__fetch)' }], costUsd: 0.004, durationMs: 2100,
    model: 'm/flash-lite', rules: RULES, estimatedUsd: 0.05, autoRun: true }),
  ev(12, { type: 'wave_start', n: 2, steps: [STEP] }),
  ev(20, { type: 'assess_start', wave: 2, open: 1 }),
  ev(21, { type: 'assess_decision', wave: 2, decision: 'done', reason: 'Wave cap reached (2 of 2).', steps: [], unclosable: [], costUsd: 0, durationMs: 1,
    model: '', rules: { ...RULES, waves: { used: 2, max: 2 }, progress: 'improved' }, forced: 'wave_cap' }),
]

describe('assess events', () => {
  it('validates each event and rejects a decision outside done | follow_up | ask_user', () => {
    for (const e of ASSESS_EVENTS) expect(isAgentEvent(e)).toBe(true)
    expect(isAgentEvent({ ...ASSESS_EVENTS[1], decision: 'maybe' })).toBe(false)
    expect(isAgentEvent({ ...ASSESS_EVENTS[2], steps: 'x' })).toBe(false)
  })
})

describe('run.md: assess decisions', () => {
  const meta: RunLogMeta = { schema: 1, runId: 'run-1', chatId: 'c', chatTitle: 'c', task: 't', startedAt: 1, endedAt: 2, status: 'completed', config: DEFAULT_MULTI_AGENT_CONFIG }

  it('lists each decision with its stop rule, steps and unclosable gaps', () => {
    const md = renderRunMd(meta, ASSESS_EVENTS, [], summarise(meta, ASSESS_EVENTS, []))
    expect(md).toContain('## Assess')
    expect(md).toContain('| 1 | follow_up | One conflict can be settled. | 2.1 Settle ASR-ADB days (covers r1) | auto-run, est. $0.050000 | `m/flash-lite`, $0.004000, 2.1 s |')
    expect(md).toContain('| 2 | done (wave_cap) | Wave cap reached (2 of 2). |  |  | no model call |')
    expect(md).toContain('- r2: no available tool can close this gap (needs web__fetch)')
  })

  it('counts assess calls as their own role in the baseline summary', () => {
    const record = { schema: 1, runId: 'run-1', chatId: 'c', seq: 1, kind: 'model', role: 'assess', attempt: 0, model: 'm/a',
      timing: { startedAt: 1, endedAt: 2, ms: 1 }, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.004 }, response: { content: '{}', toolCalls: [], finishReason: 'stop' } } as unknown as CallRecord
    const s = summariseRun({ meta, events: ASSESS_EVENTS, records: [record] })
    expect(s.calls.assess).toBe(1)
    expect(s.costByRole.assess).toBeCloseTo(0.004)
  })
})
