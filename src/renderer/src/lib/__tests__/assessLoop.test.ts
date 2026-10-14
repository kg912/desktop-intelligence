// Spec B Phase 2: assess decisions and follow-up waves fold into the run view.
import { describe, it, expect } from 'vitest'
import { applyAgentEvent, reduceRunEvents, runLogLine } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const STEPS = [{ id: '1.1', label: 'Leg 2', stage: 'worker', role: 'Leg 2', model: 'w', phase: 1, dependsOn: [], covers: ['r1'] }]
const FOLLOW = { id: '2.1', label: 'Settle ASR-ADB days', stage: 'worker', role: 'Follow-up', model: 'w', phase: 2, dependsOn: ['1.1'], covers: ['r1'], wave: 2 }
const RULES = { checklist: { open: 1, total: 1 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.3, capUsd: 1 }, progress: 'first', tools: 'all' }
const BASE = [
  ev(1, { type: 'orchestrator_plan', steps: STEPS, checklist: [{ id: 'r1', text: 'Days, leg 2', scope: '1.1' }] }),
  ev(2, { type: 'hitl_resume', agentId: 'orchestrator', approved: true }),
  ev(3, { type: 'agent_start', agentId: '1.1', role: 'Leg 2', model: 'w' }),
  ev(4, { type: 'agent_complete', agentId: '1.1', output: 'x', tokenCount: 1, costUsd: 0.01 }),
  ev(5, { type: 'assess_start', wave: 1, open: 1 }),
]
const DECISION = ev(6, { type: 'assess_decision', wave: 1, decision: 'follow_up', reason: 'Settle it.', steps: [FOLLOW], unclosable: [], costUsd: 0.004,
  durationMs: 2100, model: 'm/a', rules: RULES, estimatedUsd: 0.02, autoRun: true })

describe('assess loop in the run view', () => {
  it('keeps each wave\'s assessment and adds the follow-up steps as agents', () => {
    const v = reduceRunEvents('run-1', [...BASE, DECISION, ev(7, { type: 'wave_start', n: 2, steps: [FOLLOW] }),
      ev(8, { type: 'agent_start', agentId: '2.1', role: 'Follow-up', model: 'w' })])
    expect(v.wave).toBe(2)
    expect(v.assess).toHaveLength(1)
    expect(v.assess[0]).toMatchObject({ wave: 1, decision: 'follow_up', reason: 'Settle it.', costUsd: 0.004, autoRun: true, steps: [FOLLOW] })
    expect(v.steps.map((s) => s.id)).toEqual(['1.1', '2.1'])
    expect(v.agents['2.1'].status).toBe('running')  // a wave-2 agent's events are not dropped
    expect(v.phase).toBe('running')
  })

  it('an assess pause is not the plan pre-flight', () => {
    const pause = ev(7, { type: 'hitl_pause', agentId: 'assess', role: 'Assess', model: 'm/a', toolName: 'approve_followup', serverName: 'multi-agent', args: { steps: [FOLLOW], estimatedUsd: 0.4 } })
    let v = reduceRunEvents('run-1', [...BASE, DECISION, pause])
    expect(v.phase).toBe('running')
    expect(v.planPause).toBeUndefined()
    expect(v.assessPause?.toolName).toBe('approve_followup')
    v = applyAgentEvent(v, ev(8, { type: 'hitl_resume', agentId: 'assess', approved: false }))
    expect(v.assessPause).toBeUndefined()
  })

  it('logs assess decisions and waves', () => {
    expect(runLogLine(BASE[4])?.text).toBe('Assessing wave 1: 1 requirement open')
    expect(runLogLine(DECISION)?.text).toBe('Assess: follow-up, 1 step (auto-run, est. $0.02)')
    expect(runLogLine(ev(9, { type: 'assess_decision', wave: 2, decision: 'done', reason: 'r', steps: [], unclosable: [{ checklistId: 'r2', reason: 'x' }], costUsd: 0,
      durationMs: 0, model: '', rules: RULES, forced: 'wave_cap' }))?.text).toBe('Assess: done (wave cap); 1 gap no tool can close')
    expect(runLogLine(ev(10, { type: 'wave_start', n: 2, steps: [FOLLOW] }))?.text).toBe('Wave 2 started: 2.1')
  })
})
