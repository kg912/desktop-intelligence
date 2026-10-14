// Spec B 7b acceptance (design 12): the coverage matrix and the assess card. Cells open the evidence drawer on their
// claims; the card's buttons dispatch assess:run-followup / assess:finish; an ask_user question is answered from it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act, renderHook } from '@testing-library/react'
import { AssessCard, CoverageMatrixView, RunTimeline } from '../../renderer/src/components/chat/CoveragePanel'
import { ClaimLinksContext } from '../../renderer/src/components/chat/ClaimLinks'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { useMultiAgentRun } from '../../renderer/src/hooks/useMultiAgentRun'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent } from '../../shared/types'
import FIXTURE from '../../renderer/src/lib/__tests__/fixtures/istanbul-ledger.json'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const RULES = { checklist: { open: 6, total: 18 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.63, capUsd: 1 }, progress: 'first', tools: 'partly' }
const STEP = { id: '2.1', label: 'Settle ASR–ADB direct service', task: 'Check the airline schedule pages.', stage: 'worker', role: 'Follow-up', model: 'm', phase: 2,
  dependsOn: ['1.2', '1.5'], covers: ['days-2'], wave: 2 }
const DECISION = ev(4, { type: 'assess_decision', wave: 1, decision: 'follow_up', reason: 'One conflict can be closed with the available tools. Exact-date times cannot.',
  steps: [STEP], unclosable: [{ checklistId: 'times-2', reason: 'no available tool can close this gap (needs fetch)' }], costUsd: 0.004, durationMs: 2100,
  model: 'google/gemini-3.8-flash-lite', rules: RULES, estimatedUsd: 0.4, autoRun: false })
const PAUSE = ev(5, { type: 'hitl_pause', agentId: 'assess', role: 'Assess', model: 'm', toolName: 'approve_followup', serverName: 'multi-agent', args: { steps: [STEP], estimatedUsd: 0.4 } })
const base = [ev(1, { type: 'orchestrator_plan', steps: FIXTURE.steps, checklist: FIXTURE.checklist }), ev(2, { type: 'ledger_update', ledger: FIXTURE.ledger, counts: FIXTURE.counts }),
  ev(3, { type: 'assess_start', wave: 1, open: 6 })]
const config = { ...DEFAULT_MULTI_AGENT_CONFIG, followUpAutoUsd: 0.15 }

const api = { runAssessFollowUp: vi.fn(async () => {}), finishAssess: vi.fn(async () => {}), answerAssess: vi.fn(async () => {}), onMultiAgentEvent: vi.fn(() => () => {}) }
beforeEach(() => { vi.clearAllMocks(); (window as any).api = api })

describe('coverage matrix', () => {
  it('header chips, rows × legs, and a cell opens the drawer on its claims', () => {
    const view = reduceRunEvents('r', base)
    const open = vi.fn()
    render(<ClaimLinksContext.Provider value={{ view, open }}><CoverageMatrixView view={view} /></ClaimLinksContext.Provider>)
    const matrix = screen.getByTestId('coverage-matrix')
    expect(within(matrix).getByText('Coverage ledger · after wave 1')).toBeTruthy()
    expect(within(matrix).getByText('Acceptance checklist: 18 requirements')).toBeTruthy()
    expect(within(matrix).getByTestId('ledger-chips').textContent).toBe('12 verified3 unverified3 conflicted0 missing')
    expect(within(matrix).getAllByRole('row').map((r) => r.textContent)).toHaveLength(7)
    fireEvent.click(within(matrix).getByTestId('cell-days-2'))
    expect(open).toHaveBeenCalledWith({ agentId: '1.2', ref: '1.2 c2', refs: ['1.2 c2', '1.5 c16'] })
    expect(within(matrix).getByTestId('cell-days-2').getAttribute('title')).toBe('Days of operation, leg 2, and whether it runs in December: possible conflict')
    expect(within(matrix).getByText('Click a cell to open the claims in the evidence drawer. The ledger is computed from claim statuses, with no model call.')).toBeTruthy()
  })
})

describe('assess card', () => {
  it('shows the decision, the call\'s cost and time, steps with what they close, stop rules and the unclosable notice', () => {
    const view = reduceRunEvents('r', [...base, DECISION, PAUSE])
    render(<AssessCard view={view} config={config} readOnly={false} onAssess={vi.fn()} />)
    const card = screen.getByTestId('assess-card')
    expect(within(card).getByTestId('assess-call').textContent).toBe('gemini-3.8-flash-lite · 0.004 USD · 2.1 s')
    expect(within(card).getByTestId('assess-decision').textContent).toBe('follow_up · 1 step')
    expect(within(card).getByText('2.1 · after 1.2, 1.5')).toBeTruthy()
    expect(within(card).getByText('resolves 1 conflict')).toBeTruthy()
    expect(within(card).getByTestId('auto-run-note').textContent).toBe('Estimated 0.40 USD: above the 0.15 USD auto-run limit, so it waits for you.')
    const rules = within(screen.getByTestId('stop-rules')).getAllByTestId('stop-rule').map((r) => r.textContent)
    expect(rules).toEqual(['Checklist completeno · 6 open', 'Wave cap1 of 2 used', 'Budget0.63 of 1.00 USD', 'Progress since last waven/a (first)', 'A tool can close the gappartly'])
    expect(screen.getByTestId('unclosable').textContent).toBe('Departure and arrival times on Tue Dec 22, 2026, leg 2: no available tool can close this gap. Reported to you in the answer, no spend.')
  })

  it('Run follow-up / Edit steps / Finish now dispatch the assess IPC through the hook', async () => {
    const { result } = renderHook(() => useMultiAgentRun(vi.fn()))
    // A live run in the hook, at the assess pause.
    ;(window as any).api = { ...api, getMultiAgentRun: vi.fn(async () => ({ mode: 'multi-agent', runStatus: 'running', agentGraph: [], executionTrace: [...base, DECISION, PAUSE], runIds: ['r'] })),
      getMultiAgentConfig: vi.fn(async () => config), resumeMultiAgentRun: vi.fn(async () => ({ ok: true, runId: 'r' })) }
    await act(async () => { await result.current.continueRun('chat', 'r') })
    const view = result.current.run!.view
    render(<AssessCard view={view} config={config} readOnly={false} onAssess={result.current.respondAssess} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run follow-up' }))
    expect(api.runAssessFollowUp).toHaveBeenCalledWith('r', undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Finish now' }))
    expect(api.finishAssess).toHaveBeenCalledWith('r')
    fireEvent.click(screen.getByRole('button', { name: 'Edit steps' }))
    fireEvent.change(screen.getByLabelText('Title of 2.1'), { target: { value: 'Settle it on the Pegasus page' } })
    fireEvent.change(screen.getByLabelText('Task of 2.1'), { target: { value: 'Open the Pegasus timetable.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run follow-up' }))
    expect(api.runAssessFollowUp).toHaveBeenLastCalledWith('r', [{ id: '2.1', label: 'Settle it on the Pegasus page', task: 'Open the Pegasus timetable.' }])
  })

  it('an auto-run follow-up has no buttons and says so; a read-only run has none either', () => {
    const auto = ev(4, { ...DECISION, estimatedUsd: 0.05, autoRun: true })
    render(<AssessCard view={reduceRunEvents('r', [...base, auto])} config={config} readOnly={false} onAssess={vi.fn()} />)
    expect(screen.getByTestId('auto-run-note').textContent).toBe('Auto-runs under 0.15 USD: estimated 0.05 USD.')
    expect(screen.queryByRole('button', { name: 'Run follow-up' })).toBeNull()
  })

  it('ask_user: the question with an answer box; Answer sends it, Skip finishes', () => {
    const ask = ev(4, { type: 'assess_decision', wave: 1, decision: 'ask_user', reason: 'Only you know.', question: 'Kayseri or Nevşehir for leg 2?', steps: [], unclosable: [],
      costUsd: 0.003, durationMs: 900, model: 'm/a', rules: RULES })
    const pause = ev(5, { type: 'hitl_pause', agentId: 'assess', role: 'Assess', model: 'm/a', toolName: 'ask_user', serverName: 'multi-agent', args: { question: 'Kayseri or Nevşehir for leg 2?' } })
    const onAssess = vi.fn()
    render(<AssessCard view={reduceRunEvents('r', [...base, ask, pause])} config={config} readOnly={false} onAssess={onAssess} />)
    expect(screen.getByTestId('assess-question').textContent).toBe('Kayseri or Nevşehir for leg 2?')
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Kayseri' } })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onAssess).toHaveBeenCalledWith({ kind: 'answer', answer: 'Kayseri' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onAssess).toHaveBeenLastCalledWith({ kind: 'finish' })
  })

  it('the run timeline strip', () => {
    render(<RunTimeline view={reduceRunEvents('r', [...base, DECISION, ev(6, { type: 'wave_start', n: 2, steps: [STEP] })])} />)
    expect(screen.getByTestId('run-timeline').textContent).toBe('plan→workers→assess: follow_up→wave 2')
  })
})
