import { describe, it, expect } from 'vitest'
import { columnLabels, planningNodes, runGraphNodes } from '../agentGraphNodes'
import { layoutDag } from '../dagLayout'
import { reduceRunEvents } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'r', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const plan = [
  { id: '1.1', label: 'Route', stage: 'worker', role: 'Router', model: 'm', phase: 1, dependsOn: [] },
  { id: '1.2', label: 'Safety', stage: 'worker', role: 'Safety', model: 'm', phase: 1, dependsOn: [] },
  { id: '2.1', label: 'Itinerary', stage: 'worker', role: 'Planner', model: 'm', phase: 2, dependsOn: ['1.1', '1.2'] },
]

describe('planningNodes', () => {
  it('orchestrator, draft subtasks, one ghost while writing, and a ghost final synthesis fed by the leaves', () => {
    seq = 0
    const v = reduceRunEvents('r', [
      ev({ type: 'plan_started', maxAgents: 4 }),
      ev({ type: 'plan_stage_changed', stage: 'splitting', attempt: 0 }),
      ev({ type: 'plan_subtask_added', attempt: 0, index: 0, step: { id: '1.1', label: 'Route', role: 'Router', dependsOn: [] } }),
      ev({ type: 'plan_subtask_added', attempt: 0, index: 1, step: { id: '1.2', label: 'Safety', role: '', dependsOn: ['nope'] } }),
    ])
    const nodes = planningNodes(v.planning, 'qwen/qwen3.8-27b')
    expect(nodes.map((n) => [n.id, n.state, n.dependsOn])).toEqual([
      ['orch', 'run', []], ['1.1', 'draft', ['orch']], ['1.2', 'draft', ['orch']], ['__next', 'ghost', ['orch']], ['out', 'ghost', ['1.1', '1.2']],
    ])
    expect(nodes[0].meta).toBe('qwen3.8-27b')
    expect(nodes[2].meta).toBe('role pending')
  })

  it('a re-plan restarts the draft; no ghost once the plan is being wired', () => {
    seq = 0
    const v = reduceRunEvents('r', [
      ev({ type: 'plan_subtask_added', attempt: 0, index: 0, step: { id: 'x', label: 'Old', role: 'R', dependsOn: [] } }),
      ev({ type: 'plan_stage_changed', stage: 'splitting', attempt: 1 }),
      ev({ type: 'plan_subtask_added', attempt: 1, index: 0, step: { id: '1.1', label: 'New', role: 'R', dependsOn: [] } }),
      ev({ type: 'plan_stage_changed', stage: 'wiring', attempt: 0 }),
    ])
    expect(planningNodes(v.planning, 'm').map((n) => n.id)).toEqual(['orch', '1.1', 'out'])
  })
})

describe('runGraphNodes', () => {
  it('states, approval badges, waits-on meta, and the same positions as the planning draft', () => {
    seq = 0
    const v = reduceRunEvents('r', [
      ev({ type: 'orchestrator_plan', steps: plan }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'Router', model: 'm' }),
      ev({ type: 'agent_start', agentId: '1.2', role: 'Safety', model: 'm' }),
      ev({ type: 'agent_complete', agentId: '1.2', output: 'ok', tokenCount: 1500, costUsd: 0 }),
      ev({ type: 'reflection_result', agentId: '1.2', score: 5, passed: true, reason: 'ok' }),
    ])
    const nodes = runGraphNodes(v, new Map([['1.1', 2]]), { orchestrator: 'a/orch', synthesizer: 'b/syn' })
    expect(nodes.map((n) => [n.id, n.state, n.stateText, n.badge, n.meta])).toEqual([
      ['orch', 'done', 'done', undefined, 'orch'],
      ['1.1', 'approval', 'approval', 2, 'Router'],
      ['1.2', 'done', 'done', undefined, 'Safety · 1.5k'],
      ['2.1', 'wait', 'waiting', undefined, 'waits on 1.1'],
      ['out', 'wait', 'waiting', undefined, 'syn'],
    ])
    const draft = planningNodes({ ...v.planning, stage: 'wiring', draft: plan.map((s) => ({ id: s.id, label: s.label, role: s.role, dependsOn: s.dependsOn })) }, 'm')
    const a = layoutDag(draft).positions
    const b = layoutDag(nodes).positions
    for (const id of ['orch', '1.1', '1.2', '2.1', 'out']) expect(b.get(id)).toEqual(a.get(id))
  })

  it('column labels come from the plan\'s phases', () => {
    seq = 0
    const v = reduceRunEvents('r', [ev({ type: 'orchestrator_plan', steps: plan })])
    const l = layoutDag(runGraphNodes(v, new Map(), { orchestrator: 'o', synthesizer: 's' }))
    expect(columnLabels(l.columns)).toEqual(['PLAN', 'PHASE 1 · PARALLEL WORKERS', 'PHASE 2', 'OUTPUT'])
  })
})

describe('edgeKind', () => {
  it('green solid out of finished nodes, red flow out of running ones, yellow held on approval, grey otherwise', async () => {
    const { edgeKind } = await import('../agentGraphNodes')
    expect(edgeKind('done', 'wait')).toBe('done')
    expect(edgeKind('run', 'wait')).toBe('live')
    expect(edgeKind('run', 'done')).toBe('idle')
    expect(edgeKind('approval', 'wait')).toBe('hold')
    expect(edgeKind('wait', 'wait')).toBe('idle')
    expect(edgeKind('draft', 'draft')).toBe('idle') // not wired yet: dashed
    expect(edgeKind('done', 'ghost')).toBe('idle')
  })
})
