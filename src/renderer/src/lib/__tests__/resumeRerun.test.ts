// Spec B Phase 5: a resumed run and a step re-run fold back into a live run view.
import { describe, it, expect } from 'vitest'
import { applyAgentEvent, reduceRunEvents, runLogLine } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const STEPS = ['1.1', '1.2', '2.1'].map((id) => ({ id, label: id, stage: 'worker', role: 'R', model: 'm/w', phase: id === '2.1' ? 2 : 1, dependsOn: id === '2.1' ? ['1.2'] : [] }))
const BEFORE = [
  ev(1, { type: 'orchestrator_plan', steps: STEPS }), ev(2, { type: 'hitl_resume', agentId: 'orchestrator', approved: true }),
  ev(3, { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm/w' }), ev(4, { type: 'agent_start', agentId: '1.2', role: 'R', model: 'm/w' }),
  ev(5, { type: 'agent_complete', agentId: '1.1', output: 'leg 1', tokenCount: 1, costUsd: 0.01 }),
  ev(6, { type: 'task_failed', reason: 'Lost connection to the multi-agent sidecar', partialOutputs: {} }),
]

describe('resume and re-run in the run view', () => {
  it('a resumed run is live again: finished steps kept, interrupted ones queued', () => {
    let v = reduceRunEvents('run-1', BEFORE)
    expect(v.phase).toBe('failed')
    const resumed = ev(7, { type: 'run_resumed', finishedSteps: ['1.1'], wave: 1 })
    v = applyAgentEvent(v, resumed)
    expect(v.phase).toBe('running')
    expect(v.failureReason).toBeUndefined()
    expect(v.endedAt).toBeUndefined()
    expect(v.agents['1.1']).toMatchObject({ status: 'done', output: 'leg 1' })
    expect(v.agents['1.2'].status).toBe('queued')
    expect(v.agents['2.1'].status).toBe('queued')
    expect(runLogLine(resumed)?.text).toBe('Run resumed: 1.1 kept; unfinished steps start again')
  })

  it('a re-run resets its steps, marks stale dependents, and awaits a new answer', () => {
    const done = [...BEFORE.slice(0, 5), ev(6, { type: 'agent_complete', agentId: '1.2', output: 'leg 2', tokenCount: 1, costUsd: 0.01 }),
      ev(7, { type: 'agent_complete', agentId: '2.1', output: 'plan', tokenCount: 1, costUsd: 0.01 }),
      ev(8, { type: 'task_complete', finalOutput: 'Answer', totalCostUsd: 0.03, totalTokens: 3 })]
    let v = reduceRunEvents('run-1', done)
    const start = ev(9, { type: 'rerun_start', stepId: '1.2', withDependents: false, steps: ['1.2'], model: 'm/strong', stale: ['2.1'] })
    v = applyAgentEvent(v, start)
    v = applyAgentEvent(v, ev(10, { type: 'agent_stale', agentId: '2.1', reason: 'built on the earlier output of 1.2' }))
    expect(v.phase).toBe('running')
    expect(v.finalOutput).toBeUndefined()
    expect(v.synthesis).toBe('')
    expect(v.agents['1.2']).toMatchObject({ status: 'queued', timeline: [], reflections: [] })
    expect(v.agents['1.2'].output).toBeUndefined()
    expect(v.agents['1.2'].step.model).toBe('m/strong')
    expect(v.agents['1.1']).toMatchObject({ status: 'done', output: 'leg 1' })
    expect(v.agents['2.1']).toMatchObject({ status: 'done', output: 'plan', stale: 'built on the earlier output of 1.2' })
    expect(runLogLine(start)?.text).toBe('Re-running 1.2 on m/strong; 2.1 now stale')
  })
})
