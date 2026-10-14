// Spec B 7a acceptance: a chip opens the drawer on its claim; filters work; the quote is highlighted at the right
// original-text offset (after normalise_quote differences); a claim whose evidence was never stored says so, no error.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { ClaimsDrawer } from '../../renderer/src/components/chat/ClaimsDrawer'
import type { ClaimTarget } from '../../renderer/src/components/chat/ClaimsDrawer'
import { FinalSynthesis } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { ClaimLinkedMarkdown, ClaimLinksContext } from '../../renderer/src/components/chat/ClaimLinks'
import { MessageBubble } from '../../renderer/src/components/chat/MessageBubble'
import type { AgentEvent, EvidenceRecord } from '../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...e }) as unknown as AgentEvent
const step = (id: string, role: string) => ({ id, label: `Step ${id}`, stage: 'worker', role, model: 'm', phase: 1, dependsOn: [] })
// The recorded quote differs from the page in case, curly quotes, a dash, emphasis, a thousands separator and spacing.
const PAGE = 'Kayseri (ASR) to İzmir (ADB)\nhttps://example-airline.com/kayseri-izmir\n…schedules change by season. **Flights from Kayseri** operate on “Tuesday, Thursday and Saturday” — 1,400 seats  a week. Check the exact date at booking…'
const QUOTE = 'flights from kayseri operate on "Tuesday, Thursday and Saturday" - 1400 seats a week'
const EVENTS = [
  ev(1, { type: 'orchestrator_plan', steps: [step('1.2', 'Flights'), step('2.1', 'Checker')], checklist: [{ id: 'r1', text: 'Days', scope: '1.2' }] }),
  ev(2, { type: 'reflection_result', agentId: '1.2', attempt: 0, score: 2, passed: false, reason: 'x', claimStatuses: {}, claims: [] }),
  ev(3, { type: 'reflection_result', agentId: '1.2', attempt: 1, score: 3, passed: false, reason: 'x', claimStatuses: {}, claims: [] }),
  ev(4, { type: 'reflection_result', agentId: '1.2', attempt: 2, score: 4, passed: true, reason: 'ok',
    claimStatuses: { c1: 'verified', c3: 'verified', c5: 'unverified_declared' },
    claims: [{ id: 'c1', claim: 'ASR-IST has 8+ daily flights on three carriers.', snippets: ['S2.1'], callId: 'call_2', quote: 'eight daily flights' },
      { id: 'c3', claim: 'Direct Kayseri-İzmir flights operate Tuesdays, Thursdays and Saturdays.', callId: 'call_17', quote: QUOTE },
      { id: 'c5', claim: 'Exact departure times for the chosen date.', unverified: true }] }),
  ev(5, { type: 'reflection_result', agentId: '2.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: { c4: 'verified' },
    claims: [{ id: 'c4', claim: 'No scheduled direct flight between ASR and ADB on the selected week.', snippets: ['S9.1'], callId: 'call_9', quote: 'no direct' }] }),
  ev(6, { type: 'ledger_update', ledger: { r1: { status: 'conflicted', claimIds: ['1.2 c3', '2.1 c4'], conflict: { claimIds: ['1.2 c3', '2.1 c4'], confirmed: true } } },
    counts: { verified: 0, unverified: 0, conflicted: 1, missing: 0, pending: 0 } }),
  ev(7, { type: 'synthesis_start' }),
  ev(8, { type: 'synthesis_token', token: 'Leg 2: direct flights Tue/Thu/Sat [1.2] [1.2 c3], but none that week [2.1]. Times unknown [1.2 c5].' }),
]
const EVIDENCE: Record<string, EvidenceRecord> = {
  call_17: { agentId: '1.2', callId: 'call_17', name: 'builtin__brave_web_search', args: '{}', ok: true, result: `[1] ${PAGE}`, snippets: {} },
}
const api = { getMultiAgentEvidence: vi.fn(async (_r: string, _a: string, callId: string) => EVIDENCE[callId] ?? null) }

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).api = api
})

function Harness() {
  const view = reduceRunEvents('r', EVENTS)
  const [target, setTarget] = useState<ClaimTarget | null>(null)
  return (
    <>
      <FinalSynthesis view={view} onSelectAgent={() => {}} onOpenClaim={setTarget} />
      {target && <ClaimsDrawer view={view} target={target} onSelect={setTarget} onClose={() => setTarget(null)} />}
    </>
  )
}

describe('ClaimsDrawer (spec B 7a)', () => {
  it('a status-coloured chip opens the drawer on its claim, with status chips, judge score and attempt', async () => {
    render(<Harness />)
    const chip = screen.getByText('1.2 c3 · conflict')
    expect(chip.getAttribute('href')).toBe('#claim-bad-1.2~c3')
    expect(screen.getByText('1.2 c5 · unverified').getAttribute('href')).toBe('#claim-warn-1.2~c5')
    fireEvent.click(chip)
    const drawer = await screen.findByTestId('claims-drawer')
    expect(within(drawer).getByTestId('drawer-title').textContent).toBe('Claim c3 · conflicted')
    expect(within(drawer).getByText('Evidence · agent 1.2 · Flights')).toBeTruthy()
    expect(within(drawer).getByTestId('drawer-claim-text').textContent).toBe('"Direct Kayseri-İzmir flights operate Tuesdays, Thursdays and Saturdays."')
    expect(within(drawer).getByTestId('drawer-status-chips').textContent).toBe('quote verifiedcontradicted by 2.1 c4judge 4/5attempt 3 of 3')
    expect(within(drawer).getByTestId('drawer-conflict').textContent).toContain('2.1 c4: "No scheduled direct flight between ASR and ADB on the selected week."')
    expect(within(drawer).getByTestId('drawer-conflict').textContent).toContain('call_9 · [S9.1] · verified')
  })

  it('highlights the quote at its original offset despite normalise_quote differences', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('1.2 c3 · conflict'))
    const source = await screen.findByTestId('drawer-source')
    await waitFor(() => expect(source.querySelector('mark')).not.toBeNull())
    const marks = [...source.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toEqual(['Flights from Kayseri** operate on “Tuesday, Thursday and Saturday” — 1,400 seats  a week'])
    expect(source.textContent).toContain('…schedules change by season. **Flights')
    expect(screen.getByText('Source · call call_17 · builtin__brave_web_search')).toBeTruthy()
    expect(api.getMultiAgentEvidence).toHaveBeenCalledWith('r', '1.2', 'call_17')
  })

  it('filters: all / unverified only / conflicts; a row selects its claim', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('1.2 c3 · conflict'))
    const drawer = await screen.findByTestId('claims-drawer')
    const rows = () => within(drawer).queryAllByTestId(/^drawer-claim-row-/).map((r) => r.getAttribute('data-testid'))
    expect(within(drawer).getByTestId('drawer-filter-all').textContent).toBe('all 3')
    expect(rows()).toEqual(['drawer-claim-row-1.2 c1', 'drawer-claim-row-1.2 c3', 'drawer-claim-row-1.2 c5'])
    fireEvent.click(within(drawer).getByTestId('drawer-filter-unverified'))
    expect(rows()).toEqual(['drawer-claim-row-1.2 c5'])
    fireEvent.click(within(drawer).getByTestId('drawer-filter-conflicts'))
    expect(rows()).toEqual(['drawer-claim-row-1.2 c3'])
    fireEvent.click(within(drawer).getByTestId('drawer-filter-all'))
    fireEvent.click(within(drawer).getByTestId('drawer-claim-row-1.2 c1'))
    expect(within(drawer).getByTestId('drawer-title').textContent).toBe('Claim c1 · verified')
  })

  it('a claim whose evidence was never stored says so, without an error', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('1.2 c3 · conflict'))
    const drawer = await screen.findByTestId('claims-drawer')
    fireEvent.click(within(drawer).getByTestId('drawer-claim-row-1.2 c1'))  // call_2: not stored
    expect(await within(drawer).findByText('Evidence not stored for this run.')).toBeTruthy()
    fireEvent.click(within(drawer).getByTestId('drawer-claim-row-1.2 c5'))  // declared unverified: cites nothing
    expect(within(drawer).getByText('This claim cites no tool result.')).toBeTruthy()
  })

  it('"open raw result" shows the full tool result; Escape and ✕ close', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText('1.2 c3 · conflict'))
    fireEvent.click(await screen.findByRole('button', { name: 'open raw result' }))
    expect((await screen.findByTestId('drawer-raw')).textContent).toBe(`[1] ${PAGE}`)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('claims-drawer')).toBeNull()
  })
})

describe('claim chips outside the final synthesis (spec B 7a)', () => {
  const view = reduceRunEvents('r', [...EVENTS, ev(9, { type: 'task_complete', finalOutput: 'Answer with [1.2 c3].', totalCostUsd: 0, totalTokens: 0 })])

  it('an agent report links its own [c3] and opens the drawer', () => {
    const open = vi.fn()
    render(
      <ClaimLinksContext.Provider value={{ view, open }}>
        <ClaimLinkedMarkdown text="Direct flights run Tue/Thu/Sat [c3]; times unknown [c5]." own="1.2" />
      </ClaimLinksContext.Provider>
    )
    fireEvent.click(screen.getByText('1.2 c3 · conflict'))
    expect(open).toHaveBeenCalledWith({ agentId: '1.2', ref: '1.2 c3' })
    expect(screen.getByText('1.2 c5 · unverified').getAttribute('href')).toBe('#claim-warn-1.2~c5')
  })

  it('the run\'s answer message gets chips; any other message stays as it was', () => {
    const message = (content: string) => ({ id: content, role: 'assistant', content, isThinking: false, isStreaming: false, isSearching: false, stats: null, error: null }) as never
    render(
      <ClaimLinksContext.Provider value={{ view, open: vi.fn() }}>
        <MessageBubble message={message('Answer with [1.2 c3].')} />
        <MessageBubble message={message('An older answer [1.2 c3].')} />
      </ClaimLinksContext.Provider>
    )
    expect(screen.getByText('1.2 c3 · conflict').getAttribute('href')).toBe('#claim-bad-1.2~c3')
    expect(screen.getByText(/An older answer \[1\.2 c3\]/)).toBeTruthy()
  })
})
