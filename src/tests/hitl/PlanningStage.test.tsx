/** Goal 5 — orchestrator planning state (designs/05-planning-state.png). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'

vi.mock('@preact/signals-react/runtime', () => {
  const { useState, useEffect, useRef } = require('react')
  return {
    useSignals: () => {},
    useSignal: (init: any) => {
      const ref = useRef<any>(null)
      const [, forceUpdate] = useState(0)
      if (!ref.current) ref.current = { _val: init, get value() { return this._val }, set value(v) { this._val = v; forceUpdate((x: number) => x + 1) }, peek() { return this._val } }
      return ref.current
    },
    useSignalEffect: (cb: any) => { useEffect(() => { cb() }) },
    useComputed: (cb: any) => ({ get value() { return cb() }, peek() { return cb() } }),
  }
})

import { MultiAgentSidebarView } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { SLOW_PLAN_MS } from '../../renderer/src/components/chat/PlanningStage'
import { emptyRunView, reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent } from '../../shared/types'

const T0 = 1_760_000_000_000
let seq = 0
const ev = (e: Record<string, unknown>, ts = T0 + seq * 1000): AgentEvent => ({ runId: 'run-1', seq: ++seq, ts, ...e }) as AgentEvent
const planning = (extra: Array<Record<string, unknown>> = []) => {
  seq = 0
  return reduceRunEvents('run-1', [ev({ type: 'plan_started', maxAgents: 4 }), ev({ type: 'plan_stage_changed', stage: 'reading', attempt: 0 }), ...extra.map((e) => ev(e))])
}
const props = {
  task: 'Turkey in December', config: DEFAULT_MULTI_AGENT_CONFIG, readOnly: false, estimate: null, permissionRequests: [],
  onRespondPermission: vi.fn(), onApprove: vi.fn(), onCancel: vi.fn(), onAbort: vi.fn(), focusAgentId: null, onSelectAgent: vi.fn(), onClose: vi.fn(),
  onQuickPlan: vi.fn(async () => {}),
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0 + 5_000); vi.clearAllMocks() })
afterEach(() => vi.useRealTimers())

describe('reducer', () => {
  it('stages, draft subtasks, reasoning and the streamed-character count', () => {
    const v = planning([
      { type: 'plan_reasoning', token: 'Group by region.' },
      { type: 'plan_stage_changed', stage: 'splitting', attempt: 0 },
      { type: 'plan_subtask_added', attempt: 0, index: 0, step: { id: '1.1', label: 'Core route', role: 'Route', dependsOn: [] } },
    ])
    expect(v.phase).toBe('planning')
    expect(v.planning).toMatchObject({ stage: 'splitting', attempt: 0, reasoning: 'Group by region.', maxAgents: 4, startedAt: T0 })
    expect(v.planning.draft).toEqual([{ id: '1.1', label: 'Core route', role: 'Route', dependsOn: [] }])
    expect(v.planning.stageAt).toEqual({ reading: T0, splitting: T0 + 3000 })
    expect(v.planning.streamedChars).toBe('Group by region.'.length + 'Core route'.length + 40)
  })
  it('a fallback plan keeps its reason', () => {
    const v = planning([{ type: 'orchestrator_plan', steps: [], fallback: true, fallbackReason: 'You chose the quick 3-step plan.' }])
    expect(v.planning.fallbackReason).toBe('You chose the quick 3-step plan.')
  })
})

describe('planning view', () => {
  it('right after send (no plan event yet): stepper, timer and the ghost canvas — never an empty pane', () => {
    render(<MultiAgentSidebarView {...props} view={emptyRunView('pending:1', T0)} />)
    expect(screen.getByTestId('plan-stage-reading').dataset.state).toBe('active')
    expect(screen.getByTestId('planning-clock').textContent).toBe('0:05')
    expect(screen.getByTestId('graph-node-orch')).toBeTruthy()
    expect(screen.getByTestId('graph-node-__next').dataset.state).toBe('ghost')
    expect(screen.getByTestId('graph-node-out').dataset.state).toBe('ghost')
    expect(screen.getByTestId('graph-caption').textContent).toBe('Reading your request…')
  })

  it('subtasks appear as solid nodes while splitting; the stepper counts them; edges stay dashed', () => {
    const v = planning([
      { type: 'plan_stage_changed', stage: 'splitting', attempt: 0 },
      { type: 'plan_subtask_added', attempt: 0, index: 0, step: { id: '1.1', label: 'Core route', role: 'Route', dependsOn: [] } },
      { type: 'plan_subtask_added', attempt: 0, index: 1, step: { id: '1.2', label: 'Safety', role: 'Safety', dependsOn: [] } },
    ])
    render(<MultiAgentSidebarView {...props} view={v} />)
    expect(screen.getByTestId('plan-stage-reading').dataset.state).toBe('done')
    expect(screen.getByTestId('plan-stage-reading').textContent).toContain('done · 2s')
    expect(screen.getByTestId('plan-stage-splitting').textContent).toContain('2 found so far')
    expect(screen.getByTestId('plan-stage-wiring').dataset.state).toBe('waiting')
    expect(screen.getByTestId('graph-node-1.1').dataset.state).toBe('draft')
    expect(screen.getByTestId('graph-node-1.2').textContent).toContain('Safety')
    expect([...screen.getByTestId('graph-edges').querySelectorAll('path')].every((p) => p.getAttribute('data-kind') === 'idle')).toBe(true)
    expect(screen.getByTestId('graph-caption').textContent).toBe('2 subtasks defined · roles and wiring still being assigned')
    expect(screen.getByTestId('planning-tokens').textContent).toMatch(/^~\d+ tok$/)
  })

  it('shows the orchestrator\'s thinking in a collapsible card when it streams', () => {
    render(<MultiAgentSidebarView {...props} view={planning([{ type: 'plan_reasoning', token: 'Antalya is a coast stop.' }])} />)
    const card = screen.getByTestId('planning-thinking')
    expect(card.textContent).toContain('Antalya is a coast stop.')
    fireEvent.click(within(card).getByRole('button'))
    expect(card.textContent).not.toContain('Antalya')
  })

  it('after 45s: Keep waiting hides the banner for another 45s; Use quick 3-step plan calls the hatch; Abort stays available', () => {
    const v = planning()
    render(<MultiAgentSidebarView {...props} view={v} />)
    expect(screen.queryByTestId('slow-plan')).toBeNull()
    act(() => { vi.advanceTimersByTime(SLOW_PLAN_MS) })
    const banner = screen.getByTestId('slow-plan')
    expect(banner.textContent).toContain('Planning is slower than usual on this model.')
    fireEvent.click(within(banner).getByText('Keep waiting'))
    expect(screen.queryByTestId('slow-plan')).toBeNull()
    act(() => { vi.advanceTimersByTime(SLOW_PLAN_MS) })
    fireEvent.click(within(screen.getByTestId('slow-plan')).getByText('Use quick 3-step plan'))
    expect(props.onQuickPlan).toHaveBeenCalledTimes(1)
    expect(within(screen.getByTestId('slow-plan')).getByText('Switching to the quick plan…')).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('slow-plan')).getByText('Abort'))
    expect(props.onAbort).toHaveBeenCalledTimes(1)
  })

  it('a failure during planning is shown inline with the stepper stopped', () => {
    const v = planning([{ type: 'task_failed', reason: 'Budget cap reached before planning finished', partialOutputs: {} }])
    render(<MultiAgentSidebarView {...props} view={v} />)
    expect(screen.getByTestId('planning-failed').textContent).toContain('Budget cap reached before planning finished')
    expect(screen.getByTestId('plan-stage-reading').dataset.state).toBe('fail')
    expect(screen.queryByTestId('slow-plan')).toBeNull()
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('false')
  })

  it('a fallback plan is never silent: plan approval says it is the fallback and why', () => {
    const steps = [{ id: '1.1', label: 'Analyze the task', stage: 'worker', role: 'Analyst', model: 'm', phase: 1, dependsOn: [] }]
    const v = planning([
      { type: 'orchestrator_plan', steps, fallback: true, fallbackReason: 'The orchestrator failed: OpenRouter HTTP 502: upstream error' },
      { type: 'hitl_pause', agentId: 'orchestrator', role: 'Orchestrator', toolName: 'approve_plan', serverName: 'multi-agent', args: {} },
    ])
    render(<MultiAgentSidebarView {...props} view={v} />)
    expect(screen.getByTestId('fallback-plan').textContent).toBe(
      'This is the quick 3-step fallback plan, not one the orchestrator wrote. The orchestrator failed: OpenRouter HTTP 502: upstream error Approve to run it, or cancel.')
    expect(screen.queryByTestId('planning-stage')).toBeNull()
  })

  it('animations run only while planning is live and the window is visible', () => {
    const { unmount } = render(<MultiAgentSidebarView {...props} view={planning()} />)
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('true')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('false')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    unmount()
    render(<MultiAgentSidebarView {...props} readOnly view={planning()} />)
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('false')
  })
})
