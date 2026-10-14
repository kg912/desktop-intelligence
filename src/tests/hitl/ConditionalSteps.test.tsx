// Spec B Phase 3: a skipped conditional step shows dimmed with its reason, unblocks its dependants, and the pre-flight
// estimate counts a conditional step at 50% and says so. The evaluation itself: resources/python/test_conditional_steps.py.
import { describe, it, expect } from 'vitest'
import { reduceRunEvents, runLogLine } from '../../renderer/src/lib/multiAgentRunState'
import { runGraphNodes } from '../../renderer/src/lib/agentGraphNodes'
import { render, screen } from '@testing-library/react'
import { AgentCard, Preflight, stateTag } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { isAgentEvent } from '../../shared/agentEvents'
import { estimateRunCost } from '../../shared/multiAgentModels'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, AgentStep } from '../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const STEPS: AgentStep[] = [
  { id: '1.1', label: 'Leg 2 time', stage: 'worker', role: 'Leg 2', model: 'm/w', phase: 1, dependsOn: [] },
  { id: '2.1', label: 'Overnight bus', stage: 'worker', role: 'Fallback', model: 'm/w', phase: 2, dependsOn: ['1.1'], condition: 'only if 1.2 > 5 h' },
  { id: '3.1', label: 'Day plan', stage: 'worker', role: 'Planner', model: 'm/w', phase: 3, dependsOn: ['2.1'] },
]
const SKIP = ev(5, { type: 'agent_skipped', agentId: '2.1', reason: 'condition not met: only if 1.2 > 5 h', condition: 'only if 1.2 > 5 h', basis: 'condition' })
const EVENTS = [ev(1, { type: 'orchestrator_plan', steps: STEPS }), ev(2, { type: 'hitl_resume', agentId: 'orchestrator', approved: true }),
  ev(3, { type: 'agent_start', agentId: '1.1', role: 'Leg 2', model: 'm/w' }), ev(4, { type: 'agent_complete', agentId: '1.1', output: 'x', tokenCount: 1, costUsd: 0 }), SKIP]

describe('skipped conditional steps', () => {
  it('a skipped step is finished, dimmed with its reason, and does not block its dependant', () => {
    const v = reduceRunEvents('run-1', EVENTS)
    expect(v.agents['2.1']).toMatchObject({ status: 'skipped', skipReason: 'condition not met: only if 1.2 > 5 h', endedAt: 5000 })
    expect(stateTag(v.agents['2.1'], 2, false)).toEqual({ label: 'Skipped', tone: 'idle' })
    render(<AgentCard agent={v.agents['2.1']} open={false} now={0} maxRetries={2} waitingOn={[]} head={null} queued={0} active={false}
      onToggle={() => {}} onRespondPermission={() => {}} />)
    expect(screen.getByTestId('agent-card-2.1').className).toContain('opacity-[0.55]')
    expect(screen.getByTestId('agent-meta-2.1').textContent).toBe('Fallback · condition not met: only if 1.2 > 5 h')
    const nodes = runGraphNodes(v, new Map(), { orchestrator: 'm/o', synthesizer: 'm/s' })
    expect(nodes.find((n) => n.id === '2.1')).toMatchObject({ state: 'skipped', stateText: 'skipped' })
    expect(nodes.find((n) => n.id === '3.1')?.meta).not.toContain('waits on 2.1')
    expect(runLogLine(SKIP)?.text).toBe('2.1 skipped: condition not met: only if 1.2 > 5 h')
    expect(isAgentEvent(SKIP)).toBe(true)
    expect(isAgentEvent({ ...SKIP, reason: 3 })).toBe(false)
  })

  it('the pre-flight estimate counts a conditional step at 50% and labels it', () => {
    const pricing = { 'm/w': { prompt: 1e-6, completion: 2e-6 }, [DEFAULT_MULTI_AGENT_CONFIG.models.reflection]: { prompt: 1e-6, completion: 1e-6 } }
    const config = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, worker: 'm/w', synthesizer: '' } }
    const plain = STEPS.map(({ condition: _c, ...s }) => s)
    const without = estimateRunCost({ task: 't', steps: plain, config, pricing })
    const withCond = estimateRunCost({ task: 't', steps: STEPS, config, pricing })
    const one = estimateRunCost({ task: 't', steps: [plain[1]], config, pricing })
    expect(withCond.conditionalSteps).toBe(1)
    expect(without.conditionalSteps).toBe(0)
    expect(withCond.minUsd).toBeCloseTo(without.minUsd - one.minUsd / 2, 12)
    expect(withCond.maxUsd).toBeCloseTo(without.maxUsd - one.maxUsd / 2, 12)
    render(<Preflight view={reduceRunEvents('run-1', EVENTS.slice(0, 1))} config={config} estimate={withCond} onApprove={() => {}} onCancel={() => {}} />)
    expect(screen.getByTestId('estimate-conditional').textContent).toBe('1 conditional step, counted at 50%: it runs only if the condition holds.')
    expect(screen.getByTestId('preflight-condition-2.1').textContent).toContain('only if 1.2 > 5 h; skipped automatically when the condition fails')
  })
})
