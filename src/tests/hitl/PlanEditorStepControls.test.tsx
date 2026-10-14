// Spec B 7d (design 14): the pre-flight plan editor and the step controls. Edit validation (cycle, missing dependency,
// order, over budget) blocks approval; an edited plan is what approval sends; steer / re-run on… / lock call the run's
// actions. (The sidecar side: resources/python/test_preflight_steer.py and test_resume_rerun.py.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, renderHook } from '@testing-library/react'
import { PlanEditor } from '../../renderer/src/components/chat/PlanEditor'
import { StepControls } from '../../renderer/src/components/chat/StepControls'
import { Preflight } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { RunActionsContext } from '../../renderer/src/components/chat/RunActions'
import type { RunActions } from '../../renderer/src/components/chat/RunActions'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { useMultiAgentRun } from '../../renderer/src/hooks/useMultiAgentRun'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent } from '../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const step = (id: string, deps: string[] = [], extra: Record<string, unknown> = {}) => ({ id, label: `Leg ${id}`, stage: 'worker', role: `Leg ${id}`, model: 'm/flash', phase: 1, dependsOn: deps, ...extra })
const STEPS = [step('1.1'), step('1.2'), step('1.3', ['1.2'], { condition: 'only if 1.2 > 5 h', label: 'Leg 2 fallback: overnight bus' }), step('1.4')]
const PLAN = [ev(1, { type: 'orchestrator_plan', steps: STEPS }), ev(2, { type: 'plan_step_removed', stepId: '2.1', label: 'Merge findings', reason: 'merge' }),
  ev(3, { type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} })]
const config = { ...DEFAULT_MULTI_AGENT_CONFIG, maxAgents: 6, budgetCapUsd: 1, models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, worker: 'm/flash' } }

const actions = (): RunActions => ({
  models: ['m/flash', 'anthropic/claude-sonnet-5-5'],
  estimateFor: vi.fn((steps) => ({ minUsd: 0.05 * steps.length, maxUsd: 0.1 * steps.length, unpricedModels: [] })),
  steer: vi.fn(async () => {}), rerun: vi.fn(async () => true), lock: vi.fn(async () => {}),
})
const withActions = (a: RunActions, ui: React.ReactNode) => render(<RunActionsContext.Provider value={a}>{ui}</RunActionsContext.Provider>)

describe('PlanEditor', () => {
  it('header, rows with model and budget, the conditional marker, the removed merge step, and a running estimate', () => {
    const a = actions()
    withActions(a, <PlanEditor view={reduceRunEvents('r', PLAN)} config={config} onApprove={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByTestId('plan-editor-title').textContent).toBe('4 steps · 2 phases')
    expect(screen.getByTestId('plan-editor-chips').textContent).toBe('est. $0.20 – $0.401 conditional')
    expect(within(screen.getByTestId('edit-step-1.3')).getByText('only if 1.2 > 5 h')).toBeTruthy()
    expect(within(screen.getByTestId('edit-step-1.3')).getByText('Depends on 1.2. Skipped automatically when the condition fails.')).toBeTruthy()
    expect(screen.getByTestId('removed-step-2.1').textContent).toContain('removed · the synthesizer merges')
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    expect(screen.getByTestId('plan-editor-title').textContent).toBe('5 steps · 2 phases')
    expect(screen.getByTestId('plan-editor-chips').textContent).toContain('est. $0.25 – $0.50')
  })

  it('approve sends the edited plan: titles, tasks, model, budget, removals', () => {
    const onApprove = vi.fn()
    withActions(actions(), <PlanEditor view={reduceRunEvents('r', PLAN)} config={config} onApprove={onApprove} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Title of 1.1'), { target: { value: 'Leg 1 · Istanbul → Nevşehir' } })
    fireEvent.click(screen.getByRole('button', { name: 'Details of 1.1' }))  // task and dependencies open under Details
    fireEvent.change(screen.getByLabelText('Task of 1.1'), { target: { value: 'Airlines, days, times, baggage.' } })
    fireEvent.change(screen.getByLabelText('Model of 1.2'), { target: { value: 'anthropic/claude-sonnet-5-5' } })
    fireEvent.change(screen.getByLabelText('Budget of 1.2'), { target: { value: '0.05' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1.4' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run' }))
    const sent = onApprove.mock.calls[0][0]
    expect(sent.map((s: { id: string }) => s.id)).toEqual(['1.1', '1.2', '1.3'])
    expect(sent[0]).toMatchObject({ label: 'Leg 1 · Istanbul → Nevşehir', task: 'Airlines, days, times, baggage.' })
    expect(sent[1]).toMatchObject({ model: 'anthropic/claude-sonnet-5-5', budgetUsd: 0.05 })
  })

  it('a cycle, a missing dependency or an over-budget plan blocks approval with the reason', () => {
    withActions(actions(), <PlanEditor view={reduceRunEvents('r', PLAN)} config={config} onApprove={vi.fn()} onCancel={vi.fn()} />)
    const approve = screen.getByRole('button', { name: 'Approve and run' }) as HTMLButtonElement
    expect(screen.queryByLabelText('Dependencies of 1.2')).toBeNull()  // collapsed: one line per step
    fireEvent.click(screen.getByRole('button', { name: 'Details of 1.2' }))
    fireEvent.change(screen.getByLabelText('Dependencies of 1.2'), { target: { value: '1.3' } })
    expect(screen.getByTestId('plan-editor-errors').textContent).toContain('Dependency cycle: 1.2 → 1.3 → 1.2.')
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Dependencies of 1.2'), { target: { value: '9.9' } })
    expect(screen.getByTestId('plan-editor-errors').textContent).toBe('1.2 depends on 9.9, which is not in the plan.')
    fireEvent.change(screen.getByLabelText('Dependencies of 1.2'), { target: { value: '' } })
    for (const id of ['1.1', '1.2', '1.3']) fireEvent.change(screen.getByLabelText(`Budget of ${id}`), { target: { value: '0.4' } })
    expect(screen.getByTestId('plan-editor-errors').textContent).toBe('Step budgets add up to $1.20, over the $1.00 budget cap.')
    expect(approve.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Budget of 1.3'), { target: { value: '0.1' } })
    expect(screen.queryByTestId('plan-editor-errors')).toBeNull()
    expect(approve.disabled).toBe(false)
  })

  it('a move that would run a step before what it needs is undone and explained', () => {
    withActions(actions(), <PlanEditor view={reduceRunEvents('r', PLAN)} config={config} onApprove={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Move 1.3 up' }))
    expect(screen.getByTestId('plan-editor-errors').textContent).toBe('1.3 is listed before 1.2, which it depends on. The move was undone.')
    expect(screen.getAllByTestId(/^edit-step-/).map((r) => r.getAttribute('data-testid'))).toEqual(['edit-step-1.1', 'edit-step-1.2', 'edit-step-1.3', 'edit-step-1.4'])
    fireEvent.click(screen.getByRole('button', { name: 'Move 1.4 up' }))
    expect(screen.getAllByTestId(/^edit-step-/).map((r) => r.getAttribute('data-testid'))).toEqual(['edit-step-1.1', 'edit-step-1.2', 'edit-step-1.4', 'edit-step-1.3'])
  })

  it('Preflight offers "Edit plan" only with the run\'s actions; the edited plan reaches respondMultiAgentPlan', async () => {
    const view = reduceRunEvents('r', PLAN)
    const { unmount } = render(<Preflight view={view} config={config} estimate={null} onApprove={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Edit plan' })).toBeNull()
    unmount()
    const respond = vi.fn(async () => {})
    ;(window as any).api = { onMultiAgentEvent: vi.fn(() => () => {}), respondMultiAgentPlan: respond, getMultiAgentRun: vi.fn(async () => ({ mode: 'multi-agent', runStatus: 'paused_hitl', agentGraph: STEPS, executionTrace: PLAN, runIds: ['r'] })),
      getMultiAgentConfig: vi.fn(async () => config), resumeMultiAgentRun: vi.fn(async () => ({ ok: true, runId: 'r' })) }
    const { result } = renderHook(() => useMultiAgentRun(vi.fn()))
    await act(async () => { await result.current.continueRun('chat', 'r') })
    withActions(actions(), <Preflight view={view} config={config} estimate={null} onApprove={(steps) => result.current.approvePlan(true, steps)} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit plan' }))
    fireEvent.change(screen.getByLabelText('Title of 1.1'), { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and run' }))
    expect(respond).toHaveBeenCalledWith('r', true, expect.arrayContaining([expect.objectContaining({ id: '1.1', label: 'Edited' })]))
  })
})

describe('StepControls', () => {
  const live = [...PLAN, ev(4, { type: 'hitl_resume', agentId: 'orchestrator', approved: true }), ev(5, { type: 'agent_start', agentId: '1.2', role: 'Leg 1.2', model: 'm/flash' }),
    ev(6, { type: 'tool_start', agentId: '1.2', attempt: 0, callId: 'c', tool: 'brave_search', server: 'builtin', argsPreview: '' })]

  it('a running step: steer it; the message shows queued, then delivered at its round', () => {
    const a = actions()
    const { rerender } = withActions(a, <StepControls view={reduceRunEvents('r', live)} agentId="1.2" />)
    expect(screen.getByText('round 2 · searching')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Steer 1.2'), { target: { value: 'Only use airline schedule pages, ignore aggregators.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(a.steer).toHaveBeenCalledWith('1.2', 'Only use airline schedule pages, ignore aggregators.')
    const steered = reduceRunEvents('r', [...live, ev(7, { type: 'steer', agentId: '1.2', message: 'Only use airline schedule pages, ignore aggregators.', status: 'queued' }),
      ev(8, { type: 'steer', agentId: '1.2', message: 'Only use airline schedule pages, ignore aggregators.', status: 'delivered', round: 1 })])
    rerender(<RunActionsContext.Provider value={a}><StepControls view={steered} agentId="1.2" /></RunActionsContext.Provider>)
    expect(screen.getByTestId('steer-sent').textContent).toBe('“Only use airline schedule pages, ignore aggregators.” · delivered at round 2')
  })

  it('a finished run\'s step: re-run on another model with the estimate, or with dependents; lock output', () => {
    const a = actions()
    const done = reduceRunEvents('r', [...live, ev(7, { type: 'agent_complete', agentId: '1.2', output: 'x', tokenCount: 1, costUsd: 0.04 }),
      ev(8, { type: 'reflection_result', agentId: '1.2', score: 4, passed: true, reason: 'ok' }), ev(9, { type: 'task_complete', finalOutput: 'a', totalCostUsd: 0.1, totalTokens: 1 })])
    withActions(a, <StepControls view={done} agentId="1.2" />)
    expect(screen.getByText('Finished step · 1.2 Leg 1.2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Re-run on…' }))
    fireEvent.change(screen.getByLabelText('Re-run 1.2 on'), { target: { value: 'anthropic/claude-sonnet-5-5' } })
    expect(screen.getByTestId('rerun-estimate').textContent).toBe('Re-run on claude-sonnet-5-5: est. $0.05 – $0.10. Downstream steps that used this output will be marked stale, not re-run automatically.')
    fireEvent.click(screen.getByRole('button', { name: 'Re-run this step' }))
    expect(a.rerun).toHaveBeenCalledWith('1.2', { model: 'anthropic/claude-sonnet-5-5', withDependents: false })
    fireEvent.click(screen.getByRole('button', { name: 'Re-run + dependents' }))
    expect(a.rerun).toHaveBeenLastCalledWith('1.2', { model: 'anthropic/claude-sonnet-5-5', withDependents: true })
    fireEvent.click(screen.getByRole('button', { name: 'Lock output' }))
    expect(a.lock).toHaveBeenCalledWith('1.2', true)
  })

  it('a locked step says so, cannot be re-run, and unlocks', () => {
    const a = actions()
    const locked = reduceRunEvents('r', [...live, ev(7, { type: 'agent_complete', agentId: '1.2', output: 'x', tokenCount: 1, costUsd: 0.04 }),
      ev(8, { type: 'task_complete', finalOutput: 'a', totalCostUsd: 0.1, totalTokens: 1 }), ev(9, { type: 'step_locked', agentId: '1.2', locked: true })])
    withActions(a, <StepControls view={locked} agentId="1.2" />)
    expect(screen.getByTestId('locked-note').textContent).toContain('1.2 is locked. Later re-runs and follow-up waves reuse its claims and evidence unchanged.')
    expect((screen.getByRole('button', { name: 'Re-run on…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Unlock output' }))
    expect(a.lock).toHaveBeenCalledWith('1.2', false)
  })
})

beforeEach(() => vi.clearAllMocks())
