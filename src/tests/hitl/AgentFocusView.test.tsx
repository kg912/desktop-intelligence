/** Goal 4 — agent focus view (designs/04-agent-focus.png). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { useState } from 'react'

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

import { AgentFocusView, placeInGraph, sourcesOf, toolState, toolStates } from '../../renderer/src/components/chat/AgentFocusView'
import { MultiAgentSidebarView } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { approvalQueues } from '../../renderer/src/lib/approvalQueue'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, McpToolPermissionRequest, McpToolPermissionResponse } from '../../shared/types'

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const steps = [
  { id: '1.1', label: 'Map segments', stage: 'worker', role: 'Business Analyst', model: 'deepseek/deepseek-v4.1-flash', phase: 1 },
  { id: '1.4', label: 'Assess competitive position', stage: 'worker', role: 'Competitive Analyst', model: 'deepseek/deepseek-v4.1-flash', phase: 1 },
  { id: '1.5', label: 'Build valuation', stage: 'worker', role: 'Valuation Analyst', model: 'deepseek/deepseek-v4.1-flash', phase: 2, dependsOn: ['1.1', '1.4'] },
]
const runView = (extra: Array<Record<string, unknown>> = []) => {
  seq = 0
  return reduceRunEvents('run-1', [
    ev({ type: 'orchestrator_plan', steps }),
    ev({ type: 'agent_start', agentId: '1.1', role: 'Business Analyst', model: 'm' }),
    ev({ type: 'agent_start', agentId: '1.4', role: 'Competitive Analyst', model: 'm' }),
    ev({ type: 'tool_start', agentId: '1.4', attempt: 0, callId: 'c1', tool: 'brave_web_search', server: 'builtin', argsPreview: '{"q":"Kratos vs Anduril"}' }),
    ev({ type: 'tool_done', agentId: '1.4', attempt: 0, callId: 'c1', ok: true, durationMs: 900, resultPreview: '10 results https://www.defense-news.example/a https://sec.gov/x', resultChars: 4200 }),
    ev({ type: 'agent_reasoning', agentId: '1.4', attempt: 0, token: 'Compare cost structures first.' }),
    ev({ type: 'agent_token', agentId: '1.4', attempt: 0, token: 'Kratos competes on cost and speed.' }),
    ...extra.map(ev),
  ])
}
const req = (n: number, args: Record<string, unknown> = { code: 'df = pd.DataFrame(peers)\nprint(df.tail(5))' }): McpToolPermissionRequest => ({
  serverName: 'python', toolName: 'python__python_sandbox', args, requestId: `r${n}`, chatId: 'c',
  agent: { runId: 'run-1', agentId: '1.4', role: 'Competitive Analyst', model: 'm' }, timeoutMs: 300_000,
})
const props = {
  agentId: '1.4', task: 'Build a position on Kratos', config: DEFAULT_MULTI_AGENT_CONFIG, readOnly: false,
  onRespond: vi.fn(), onNavigate: vi.fn(), onClose: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe('AgentFocusView', () => {
  it('header: id and title, role · model · phase, state chip, tokens, cost, tool calls, elapsed', () => {
    render(<AgentFocusView {...props} view={runView()} queue={[req(1)]} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByText('1.4 Assess competitive position')).toBeTruthy()
    expect(within(dialog).getByText('Competitive Analyst · deepseek-v4.1-flash · phase 1 of 2')).toBeTruthy()
    expect(screen.getByTestId('focus-chip').textContent).toBe('needs approval')
    expect(screen.getByTestId('focus-stats').textContent).toContain('1 tool call')
    expect(screen.getByTestId('focus-stats').textContent).toContain('tok$0')
  })

  it('Live output (default): brief, tool-call card with its state and result summary, streaming draft with a caret', () => {
    render(<AgentFocusView {...props} view={runView()} queue={[]} />)
    const live = screen.getByTestId('focus-live')
    expect(within(live).getByText('Assess competitive position')).toBeTruthy()
    const card = screen.getByTestId('focus-tool-c1')
    expect(within(card).getByText('brave_web_search')).toBeTruthy()
    expect(within(card).getByText('allowed')).toBeTruthy()
    expect(card.textContent).toContain('4,200 chars · 0.9s')
    expect(screen.getByTestId('focus-draft').textContent).toContain('Kratos competes on cost and speed.')
    expect(screen.getByTestId('focus-caret')).toBeTruthy()
  })

  it('tabs: Reasoning, Tool calls (count), Brief and inputs, Raw', () => {
    render(<AgentFocusView {...props} view={runView()} queue={[]} />)
    expect(screen.getByRole('tab', { name: 'Tool calls1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Reasoning' }))
    expect(screen.getByText('Compare cost structures first.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Tool calls1' }))
    expect(screen.getByText(/10 results https/)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Brief & inputs' }))
    expect(screen.getByTestId('focus-brief').textContent).toContain('Build a position on Kratos')
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }))
    expect(JSON.parse(screen.getByTestId('focus-raw').textContent!).step.id).toBe('1.4')
  })

  it('pins the head permission with its code and "n of m in this agent\'s queue"; answers go to the shared handler', () => {
    render(<AgentFocusView {...props} view={runView()} queue={[req(1), req(2)]} />)
    const card = screen.getByTestId('focus-approval')
    expect(card.textContent).toContain('python_sandbox')
    expect(card.textContent).toContain('wants to run code')
    expect(card.querySelector('pre')!.textContent).toBe('df = pd.DataFrame(peers)\nprint(df.tail(5))')
    expect(screen.getByTestId('focus-queue-pos').textContent).toBe("1 of 2 in this agent's queue")
    fireEvent.click(within(card).getByText('Allow once'))
    expect(props.onRespond).toHaveBeenCalledWith({ requestId: 'r1', approved: true, alwaysAllow: false, userNote: '' })
  })

  it('no approval card for a saved run', () => {
    render(<AgentFocusView {...props} readOnly view={runView()} queue={[req(1)]} />)
    expect(screen.queryByTestId('focus-approval')).toBeNull()
  })

  it('Esc closes (and the dock\'s Escape handler does not also run); J/K and the arrows move between agents', () => {
    const dockEscape = vi.fn((e: KeyboardEvent) => { if (!e.defaultPrevented) throw new Error('dock saw Escape') })
    window.addEventListener('keydown', dockEscape)
    render(<AgentFocusView {...props} view={runView()} queue={[]} />)
    fireEvent.keyDown(window, { key: 'j' })
    expect(props.onNavigate).toHaveBeenLastCalledWith('1.5')
    fireEvent.keyDown(window, { key: 'k' })
    expect(props.onNavigate).toHaveBeenLastCalledWith('1.1')
    fireEvent.click(screen.getByLabelText('Next agent'))
    expect(props.onNavigate).toHaveBeenLastCalledWith('1.5')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', dockEscape)
  })

  it('moves focus into the layer, traps Tab inside it, and returns focus to the opener on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open 1.4</button>
          {open && <AgentFocusView {...props} view={runView()} queue={[]} onClose={() => setOpen(false)} />}
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByText('open 1.4')
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog')
    expect(document.activeElement).toBe(dialog)
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
    buttons.at(-1)!.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons.at(-1))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('streaming auto-scroll follows the end and pauses while the user is scrolled up', () => {
    const { rerender } = render(<AgentFocusView {...props} view={runView()} queue={[]} />)
    const scroller = screen.getByTestId('focus-scroll')
    let height = 1000
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 400 })
    height = 1200
    rerender(<AgentFocusView {...props} view={runView([{ type: 'agent_token', agentId: '1.4', attempt: 0, token: ' more' }])} queue={[]} />)
    expect(scroller.scrollTop).toBe(1200)
    scroller.scrollTop = 100
    fireEvent.scroll(scroller)
    height = 1400
    rerender(<AgentFocusView {...props} view={runView([{ type: 'agent_token', agentId: '1.4', attempt: 0, token: ' more' }, { type: 'agent_token', agentId: '1.4', attempt: 0, token: ' again' }])} queue={[]} />)
    expect(scroller.scrollTop).toBe(100)
  })

  it('right rail: tool timeline with the queued call, place in the graph, pending reflection, sources, budget', () => {
    render(<AgentFocusView {...props} view={runView()} queue={[req(1), req(2)]} />)
    const rows = screen.getAllByTestId('focus-timeline-row').map((r) => r.textContent)
    expect(rows).toEqual(['brave_web_searchallowed', 'python_sandboxqueued'])
    expect(screen.getByTestId('focus-place').textContent).toContain('1.5 is blocked until this agent passes review.')
    expect(screen.getByTestId('focus-reflection').textContent).toContain('pending')
    expect(screen.getByTestId('focus-sources').textContent).toContain('defense-news.example')
    expect(screen.getByTestId('focus-budget').textContent).toContain('of the $0.50 run budget')
  })

  it('reflection result shows the score, failed claims and issues once it exists', () => {
    const v = runView([
      { type: 'agent_complete', agentId: '1.4', attempt: 0, output: 'x', tokenCount: 10, costUsd: 0.01 },
      { type: 'reflection_result', agentId: '1.4', attempt: 0, score: 2, passed: false, reason: 'Unbacked claims', issues: ['c2 quote not found'], claimsChecked: 3, claimsFailed: 1, claimStatuses: { c1: 'verified', c2: 'quote_not_found' } },
    ])
    render(<AgentFocusView {...props} view={v} queue={[]} />)
    const r = screen.getByTestId('focus-reflection').textContent!
    expect(r).toContain('2/5 — Unbacked claims')
    expect(r).toContain('1 of 3 claims failed')
    expect(screen.getByTestId('focus-sources').textContent).toContain('c2 · quote_not_found')
  })

  it('a permission resolved in the focus view disappears from the list too (one source of truth)', () => {
    function Harness() {
      const [requests, setRequests] = useState([req(1), req(2)])
      const respond = (r: McpToolPermissionResponse) => setRequests((rs) => rs.filter((x) => x.requestId !== r.requestId))
      const v = runView()
      return (
        <>
          <MultiAgentSidebarView view={v} task="t" config={DEFAULT_MULTI_AGENT_CONFIG} readOnly={false} estimate={null} permissionRequests={requests}
            onRespondPermission={respond} onApprove={vi.fn()} onCancel={vi.fn()} onAbort={vi.fn()} focusAgentId={null} onSelectAgent={vi.fn()} onClose={vi.fn()} />
          <AgentFocusView {...props} view={v} queue={approvalQueues(requests, 'run-1').get('1.4') ?? []} onRespond={respond} />
        </>
      )
    }
    vi.useFakeTimers()
    try {
      render(<Harness />)
      expect(screen.getByTestId('queued-1.4').textContent).toBe('+1 queued')
      fireEvent.click(within(screen.getByTestId('focus-approval')).getByText('Deny'))
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByTestId('approval-r2')).toBeTruthy()
      expect(screen.queryByTestId('queued-1.4')).toBeNull()
      expect(screen.getByTestId('focus-queue-pos').textContent).toBe("1 of 1 in this agent's queue")
    } finally { vi.useRealTimers() }
  })
})

describe('focus view helpers', () => {
  it('toolState', () => {
    const base = { kind: 'tool' as const, attempt: 0, callId: 'c', tool: 't', server: 's', argsPreview: '', startedAt: 0 }
    expect(toolState(base, true)).toBe('waiting')
    expect(toolState(base, false)).toBe('running')
    expect(toolState({ ...base, done: { ok: true, durationMs: 1, resultPreview: '', resultChars: 0 } }, false)).toBe('allowed')
    expect(toolState({ ...base, done: { ok: false, durationMs: 1, resultPreview: 'Tool request denied', resultChars: 0 } }, false)).toBe('denied')
    expect(toolState({ ...base, done: { ok: false, durationMs: 1, resultPreview: 'HTTP 500', resultChars: 0 } }, false)).toBe('failed')
  })
  it('toolStates: with approvals pending, the first unfinished call waits and later ones are queued', () => {
    const t = (callId: string, done?: boolean) => ({ kind: 'tool' as const, attempt: 0, callId, tool: 't', server: 's', argsPreview: '', startedAt: 0,
      ...(done && { done: { ok: true, durationMs: 1, resultPreview: '', resultChars: 0 } }) })
    expect(toolStates([t('a', true), t('b'), t('c')], 2)).toEqual(['allowed', 'waiting', 'queued'])
    expect(toolStates([t('a', true), t('b')], 0)).toEqual(['allowed', 'running'])
  })
  it('placeInGraph and sourcesOf', () => {
    const v = runView()
    expect(placeInGraph(v, '1.4')).toEqual({ upstream: ['orchestrator'], downstream: ['1.5'], blocked: ['1.5'] })
    expect(placeInGraph(v, '1.5')).toEqual({ upstream: ['1.1', '1.4'], downstream: [], blocked: [] })
    expect(sourcesOf(v.agents['1.4'])).toEqual(['defense-news.example', 'sec.gov'])
  })
})
