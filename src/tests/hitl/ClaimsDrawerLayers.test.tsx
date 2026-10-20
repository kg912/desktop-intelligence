// Rectification R4: the claims drawer sits above the agent focus view (one layer table, zLayers.ts); Escape closes the
// topmost layer only; opening the drawer from the focus view keeps it open; the reported run's step 1.3 lists its
// claims (real trace fixture, claims recovered from its run log); an agent with no claims says why, without filters.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useState } from 'react'

vi.mock('@preact/signals-react/runtime', () => ({ useSignals: () => {} }))

import { ClaimsDrawer } from '../../renderer/src/components/chat/ClaimsDrawer'
import type { ClaimTarget } from '../../renderer/src/components/chat/ClaimsDrawer'
import { AgentFocusView } from '../../renderer/src/components/chat/AgentFocusView'
import { ClaimLinksContext } from '../../renderer/src/components/chat/ClaimLinks'
import { RunActionsContext } from '../../renderer/src/components/chat/RunActions'
import { Z_LAYERS } from '../../renderer/src/components/chat/zLayers'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import type { RunView } from '../../renderer/src/lib/multiAgentRunState'
import { withRecoveredClaims, evidenceFromLog } from '../../main/services/multiAgentClaimRecovery'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, MultiAgentRunRecord } from '../../shared/types'

const DIR = join(__dirname, '../../../resources/python/tests/fixtures/runs/istanbul-3leg')
const EVENTS = readFileSync(join(DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
const RUN = EVENTS[0].runId
const api = { getMultiAgentEvidence: vi.fn(async (_r: string, agentId: string, callId: string) => evidenceFromLog(DIR, agentId, callId)) }
beforeEach(() => { vi.clearAllMocks(); (window as any).api = new Proxy(api, { get: (t, k) => (k in t ? (t as any)[k] : async () => undefined) }) })

async function reportedRun(): Promise<RunView> {
  const record: MultiAgentRunRecord = { mode: 'multi-agent', runStatus: 'completed', agentGraph: [], executionTrace: EVENTS, runId: RUN, runIds: [RUN] }
  return reduceRunEvents(RUN, (await withRecoveredClaims(record, DIR)).executionTrace)
}

describe('layers (zLayers.ts)', () => {
  it('one table, in order: dock < agent focus < claims drawer < approvals < popovers', () => {
    const { dock, agentFocus, claimsDrawer, approvals, popover } = Z_LAYERS
    expect(claimsDrawer).toBeGreaterThan(agentFocus)
    expect([dock, agentFocus, claimsDrawer, approvals, popover]).toEqual([...[dock, agentFocus, claimsDrawer, approvals, popover]].sort((a, b) => a - b))
    expect(new Set(Object.values(Z_LAYERS)).size).toBe(Object.keys(Z_LAYERS).length)
  })

  it('the drawer and the focus view take their z-index from the table', async () => {
    const view = await reportedRun()
    render(<>
      <AgentFocusView view={view} agentId="1.3" task="t" config={DEFAULT_MULTI_AGENT_CONFIG} queue={[]} readOnly onRespond={vi.fn()} onNavigate={vi.fn()} onClose={vi.fn()} />
      <ClaimsDrawer view={view} target={{ agentId: '1.3' }} onSelect={vi.fn()} onClose={vi.fn()} />
    </>)
    expect(screen.getByTestId('agent-focus-backdrop').style.zIndex).toBe(String(Z_LAYERS.agentFocus))
    expect(screen.getByTestId('claims-drawer').style.zIndex).toBe(String(Z_LAYERS.claimsDrawer))
  })
})

/** The focus view with the run's contexts, opening the drawer the way Layout does. */
function FocusWithDrawer({ view, onCloseFocus }: { view: RunView; onCloseFocus: () => void }) {
  const [target, setTarget] = useState<ClaimTarget | null>(null)
  const [focusOpen, setFocusOpen] = useState(true)
  const actions = { models: [], estimateFor: () => null, steer: async () => {}, rerun: async () => ({ ok: true as const }), rerunUnavailable: null }
  return (
    <RunActionsContext.Provider value={actions}>
      <ClaimLinksContext.Provider value={{ view, open: setTarget, onSelectAgent: vi.fn() }}>
        {target && <ClaimsDrawer view={view} target={target} onSelect={setTarget} onClose={() => setTarget(null)} />}
        {focusOpen && <AgentFocusView view={view} agentId="1.3" task="t" config={DEFAULT_MULTI_AGENT_CONFIG} queue={[]} readOnly={false}
          onRespond={vi.fn()} onNavigate={vi.fn()} onClose={() => { onCloseFocus(); setFocusOpen(false) }} />}
      </ClaimLinksContext.Provider>
    </RunActionsContext.Provider>
  )
}

describe('View claims from the agent focus view', () => {
  it('opens the drawer on top without closing the view; Escape closes the drawer first, then the view', async () => {
    const view = await reportedRun()
    const onCloseFocus = vi.fn()
    render(<FocusWithDrawer view={view} onCloseFocus={onCloseFocus} />)
    fireEvent.click(within(screen.getByTestId('agent-focus')).getByRole('button', { name: 'View claims' }))
    expect(screen.getByTestId('claims-drawer')).toBeTruthy()
    expect(screen.getByTestId('agent-focus')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('claims-drawer')).toBeNull()
    expect(screen.getByTestId('agent-focus')).toBeTruthy()
    expect(onCloseFocus).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCloseFocus).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('agent-focus')).toBeNull()
  })

  it('Escape on the drawer alone is handled (default prevented), so the dock under it stays open', async () => {
    const view = await reportedRun()
    const seen: boolean[] = []
    const dock = (e: KeyboardEvent): void => { if (e.key === 'Escape') seen.push(e.defaultPrevented) }
    window.addEventListener('keydown', dock)
    try {
      const onClose = vi.fn()
      render(<ClaimsDrawer view={view} target={{ agentId: '1.3' }} onSelect={vi.fn()} onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })  // as a real key press arrives: at the focused element
      expect(onClose).toHaveBeenCalledTimes(1)
      // The dock's listener (window, bubble) either never sees it or sees it handled; it never closes the dock.
      expect(seen.every(Boolean)).toBe(true)
    } finally { window.removeEventListener('keydown', dock) }
  })
})

describe('the reported run, step 1.3', () => {
  it('lists its 28 claims with their statuses, and the cited result from the run log with the quote highlighted', async () => {
    const view = await reportedRun()
    render(<ClaimsDrawer view={view} target={{ agentId: '1.3' }} onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('drawer-title').textContent).toBe('Claim c1 · verified')
    expect(screen.getByTestId('drawer-filter-all').textContent).toBe('all 28')
    expect(screen.getAllByTestId(/^drawer-claim-row-/)).toHaveLength(28)
    expect(within(screen.getByTestId('drawer-claim-row-1.3 c23')).getByText('unverified · declared')).toBeTruthy()
    expect(screen.getByTestId('drawer-status-chips').textContent).toContain('judge 5/5')
    await waitFor(() => expect(screen.getByTestId('drawer-source').querySelector('mark')).toBeTruthy())
    expect(api.getMultiAgentEvidence).toHaveBeenCalledWith(RUN, '1.3', 'call_01a130fb277f760b92f0a0b6')
  })
})

describe('honest empty state', () => {
  const e = (seq: number, x: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...x }) as unknown as AgentEvent
  const plan = e(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'Leg 1', stage: 'worker', role: 'Leg', model: 'm', phase: 1, dependsOn: [] }] })
  const start = e(2, { type: 'agent_start', agentId: '1.1', role: 'Leg', model: 'm', attempt: 0 })

  it('budget reached before a claims check: one line, no filter chips, never "all 0"', () => {
    const view = reduceRunEvents('r', [plan, start, e(3, { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'o', tokenCount: 1, costUsd: 1, runTotals: { costUsd: 1, tokens: 1, budgetReached: true } })])
    render(<ClaimsDrawer view={view} target={{ agentId: '1.1' }} onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('drawer-empty').textContent).toBe('This step ended without a claims check (budget reached).')
    expect(screen.queryByTestId(/^drawer-filter-/)).toBeNull()
    expect(screen.getByTestId('claims-drawer').textContent).not.toContain('all 0')
  })

  it('a step whose answer made no claims', () => {
    const view = reduceRunEvents('r', [plan, start, e(3, { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'o', tokenCount: 1, costUsd: 0.1, claims: [], claimStatuses: {} }),
      e(4, { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: {}, claims: [] })])
    render(<ClaimsDrawer view={view} target={{ agentId: '1.1' }} onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByTestId('drawer-empty').textContent).toBe('This step produced no claims.')
    expect(screen.queryByTestId(/^drawer-filter-/)).toBeNull()
  })
})

describe('opening and closing never touch the run', () => {
  it('closing the drawer leaves the focus view focused on its layer', async () => {
    const view = await reportedRun()
    render(<FocusWithDrawer view={view} onCloseFocus={vi.fn()} />)
    await act(async () => { fireEvent.click(within(screen.getByTestId('agent-focus')).getByRole('button', { name: 'View claims' })) })
    fireEvent.click(within(screen.getByTestId('claims-drawer')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('claims-drawer')).toBeNull()
    expect(screen.getByTestId('agent-focus')).toBeTruthy()
  })
})
