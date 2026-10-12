/** Goal 6 — graph view with the HITL inbox (designs/06-graph-view.png). */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
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

import { GraphView } from '../../renderer/src/components/chat/GraphView'
import { MultiAgentSidebarView } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { approvalQueues } from '../../renderer/src/lib/approvalQueue'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, McpToolPermissionRequest, McpToolPermissionResponse } from '../../shared/types'

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const steps = [
  { id: '1.1', label: 'Map segments', stage: 'worker', role: 'Business', model: 'm/w', phase: 1, dependsOn: [] },
  { id: '1.2', label: 'Compile financials', stage: 'worker', role: 'Financial', model: 'm/w', phase: 1, dependsOn: [] },
  { id: '1.3', label: 'Analyze demand', stage: 'worker', role: 'Demand', model: 'm/w', phase: 1, dependsOn: [] },
  { id: '1.5', label: 'Build valuation', stage: 'worker', role: 'Valuation', model: 'm/w', phase: 2, dependsOn: ['1.1', '1.2', '1.3'] },
]
const running = (extra: Array<Record<string, unknown>> = []) => {
  seq = 0
  return reduceRunEvents('run-1', [
    ev({ type: 'orchestrator_plan', steps }),
    ev({ type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} }),
    ev({ type: 'hitl_resume', agentId: 'orchestrator', approved: true }),
    ...['1.1', '1.2', '1.3'].map((id) => ev({ type: 'agent_start', agentId: id, role: 'R', model: 'm' })),
    ...extra.map(ev),
  ])
}
const req = (agentId: string, n: number, args: Record<string, unknown> = { q: `q${n}` }): McpToolPermissionRequest => ({
  serverName: 'brave', toolName: 'brave__web_search', args, requestId: `r-${agentId}-${n}`, chatId: 'c',
  agent: { runId: 'run-1', agentId, role: `Role ${agentId}`, model: 'm/w' }, timeoutMs: 300_000,
})
const props = {
  config: DEFAULT_MULTI_AGENT_CONFIG, readOnly: false, now: 9_000, estimate: null,
  onRespond: vi.fn(), onApprovePlan: vi.fn(), onCancelPlan: vi.fn(), onAbort: vi.fn(), onOpenAgent: vi.fn(),
}
const graph = (v = running(), requests: McpToolPermissionRequest[] = []) =>
  render(<GraphView {...props} view={v} queues={approvalQueues(requests, 'run-1')} />)

beforeEach(() => vi.clearAllMocks())

describe('GraphView', () => {
  it('draws the runtime plan: orchestrator, phase columns, workers, final synthesis; columns labelled from the phases', () => {
    graph()
    expect([...document.querySelectorAll('[data-graph-node]')].map((n) => (n as HTMLElement).dataset.graphNode)).toEqual(['orch', '1.1', '1.2', '1.3', '1.5', 'out'])
    const text = screen.getByTestId('agent-graph-canvas').textContent!
    for (const label of ['PLAN', 'PHASE 1 · PARALLEL WORKERS', 'PHASE 2', 'OUTPUT']) expect(text).toContain(label)
    expect(screen.getByTestId('graph-node-1.5').textContent).toContain('waits on 1.1 1.2 1.3')
    expect(screen.getByTestId('graph-node-1.1').style.height).toBe('76px')
    expect(screen.getByTestId('graph-legend').textContent).toContain('needs you')
    expect(screen.getByTestId('graph-minimap')).toBeTruthy()
  })

  it('edges: green for completed handoffs, red animated for active flow, yellow for blocked on approval, grey otherwise; only active edges animate', () => {
    const v = running([
      { type: 'agent_complete', agentId: '1.1', output: 'x', tokenCount: 1, costUsd: 0 },
      { type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'ok' },
    ])
    graph(v, [req('1.2', 0)])
    const kind = (e: string) => document.querySelector(`[data-edge="${e}"]`)!.getAttribute('data-kind')
    expect(kind('orch>1.1')).toBe('done')
    expect(kind('1.1>1.5')).toBe('done')
    expect(kind('1.2>1.5')).toBe('hold')
    expect(kind('1.3>1.5')).toBe('live')
    expect(kind('1.5>out')).toBe('idle')
    expect([...document.querySelectorAll('.ma-flow')].map((p) => p.getAttribute('data-edge'))).toEqual(['1.3>1.5'])
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('true')
  })

  it('a saved run never animates', () => {
    render(<GraphView {...props} readOnly view={running()} queues={new Map()} />)
    expect(screen.getByTestId('agent-graph-canvas').dataset.animate).toBe('false')
  })

  it('node card: yellow count badge for pending approvals; select shows the red ring and updates the inspector; double click opens the focus view', () => {
    graph(running(), [req('1.2', 0), req('1.2', 1)])
    expect(screen.getByTestId('graph-badge-1.2').textContent).toBe('2')
    fireEvent.click(screen.getByTestId('graph-node-1.3'))
    expect(screen.getByTestId('graph-node-1.3').dataset.selected).toBe('true')
    expect(screen.getByRole('tab', { name: 'Node 1.3' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('node-panel').textContent).toContain('Analyze demand')
    expect(screen.getByTestId('graph-selection').textContent).toBe('Selected 1.3 · feeds 1.5')
    fireEvent.doubleClick(screen.getByTestId('graph-node-1.3'))
    expect(props.onOpenAgent).toHaveBeenCalledWith('1.3')
    fireEvent.click(screen.getByText('Open full view'))
    expect(props.onOpenAgent).toHaveBeenCalledTimes(2)
  })

  it('Needs you: the focused agent gets the full card (tool, code, Allow / Trust agent / Deny, next in queue); others are one-line rows with Review', () => {
    graph(running(), [req('1.2', 0, { code: 'df.groupby("peer")' }), req('1.2', 1, { code: 'df.to_csv(...)' }), req('1.3', 0), req('1.1', 0), req('1.1', 1)])
    expect(screen.getByTestId('needs-count').textContent).toBe('5')
    const card = screen.getByTestId('needs-focused')
    expect(card.textContent).toContain('1.1')
    expect(card.textContent).toContain('1 of 2')
    expect(screen.getByTestId('needs-next').textContent).toBe('next: web_search · q: "q1"')
    expect(screen.getAllByTestId(/^needs-row-/).map((r) => r.dataset.testid)).toEqual(['needs-row-1.2', 'needs-row-1.3'])
    expect(screen.getByTestId('needs-row-1.2').textContent).toContain('+1 queued')
    fireEvent.click(within(screen.getByTestId('needs-row-1.2')).getByText('Review'))
    const focused = screen.getByTestId('needs-focused')
    expect(focused.querySelector('pre')!.textContent).toBe('df.groupby("peer")')
    expect(screen.getByTestId('graph-node-1.2').dataset.selected).toBe('true')
    fireEvent.click(within(focused).getByText('Trust agent'))
    expect(props.onRespond).toHaveBeenCalledWith({ requestId: 'r-1.2-0', approved: true, alwaysAllow: false, userNote: '', agentTrust: 'trust' })
  })

  it('plan approval lives in Needs you during pre-flight', () => {
    seq = 0
    const v = reduceRunEvents('run-1', [ev({ type: 'orchestrator_plan', steps }), ev({ type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} })])
    render(<GraphView {...props} view={v} queues={new Map()} />)
    expect(screen.getByTestId('needs-count').textContent).toBe('1')
    fireEvent.click(within(screen.getByTestId('preflight')).getByText('Approve & run'))
    expect(props.onApprovePlan).toHaveBeenCalledTimes(1)
  })

  it('Run log and the bottom stats strip', () => {
    const v = running([{ type: 'reflection_result', agentId: '1.1', score: 2, passed: false, reason: 'thin', model: 'judge/x' }])
    graph(v, [req('1.2', 0)])
    fireEvent.click(screen.getByRole('tab', { name: 'Run log' }))
    const log = screen.getByTestId('run-log').textContent!
    expect(log).toContain('Plan: 4 agents')
    expect(log).toContain('1.1 review 2/5: thin')
    const stats = screen.getByTestId('graph-stats').textContent!
    expect(stats).toContain('$0 / $0.50')
    expect(stats).toContain('3 agents in parallel')
    expect(stats).toContain('1 approval waiting')
    expect(stats).toContain('reflection 1 / 4 checks')
    expect(stats).toContain('orch llama-3.3-70b-instruct')
    fireEvent.click(within(screen.getByTestId('graph-stats')).getByText('Abort'))
    expect(props.onAbort).toHaveBeenCalledTimes(1)
  })

  it('a 20-agent plan renders without overlapping nodes (layout from the DAG)', () => {
    seq = 0
    const twenty = [...Array(20)].map((_, i) => ({ id: `n${i}`, label: `Task ${i}`, stage: 'worker', role: 'R', model: 'm', phase: 1,
      dependsOn: i < 8 ? [] : [`n${i % 8}`, ...(i >= 14 ? [`n${i - 6}`] : [])] }))
    render(<GraphView {...props} view={reduceRunEvents('run-1', [ev({ type: 'orchestrator_plan', steps: twenty })])} queues={new Map()} />)
    const boxes = [...document.querySelectorAll<HTMLElement>('[data-graph-node]')].map((n) => ({ x: parseFloat(n.style.left), y: parseFloat(n.style.top) }))
    expect(boxes).toHaveLength(22)
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(Math.abs(a.x - b.x) < 200 && Math.abs(a.y - b.y) < 76).toBe(false)
  })
})

describe('List and Graph in the dock', () => {
  const dockProps = {
    task: 't', config: DEFAULT_MULTI_AGENT_CONFIG, readOnly: false, estimate: null, onApprove: vi.fn(), onCancel: vi.fn(), onAbort: vi.fn(),
    focusAgentId: null, onSelectAgent: vi.fn(), onClose: vi.fn(),
  }
  function Dock({ initial }: { initial: McpToolPermissionRequest[] }) {
    const [mode, setMode] = useState<'list' | 'graph'>('list')
    const [requests, setRequests] = useState(initial)
    const respond = (r: McpToolPermissionResponse) => setRequests((rs) => rs.filter((x) => x.requestId !== r.requestId))
    return (
      <>
        <button onClick={() => setMode(mode === 'list' ? 'graph' : 'list')}>switch</button>
        <MultiAgentSidebarView {...dockProps} view={running([{ type: 'agent_token', agentId: '1.3', attempt: 0, token: 'streaming text' }])}
          permissionRequests={requests} onRespondPermission={respond} viewMode={mode} />
      </>
    )
  }

  it('toggling keeps every piece of state and never remounts either view; approvals resolved in Graph vanish from List', () => {
    vi.useFakeTimers()
    try {
      render(<Dock initial={[req('1.2', 0), req('1.2', 1)]} />)
      fireEvent.click(within(screen.getByTestId('agent-card-1.3')).getByRole('button', { expanded: false }))
      const listTrace = screen.getByTestId('agent-trace-1.3')
      fireEvent.click(screen.getByText('switch'))
      expect(screen.getByTestId('agent-dock').dataset.view).toBe('graph')
      expect(screen.getByTestId('dock-list').className).toContain('hidden')
      const canvas = screen.getByTestId('agent-graph-canvas')
      fireEvent.click(screen.getByTestId('graph-node-1.2'))
      fireEvent.click(within(screen.getByTestId('needs-focused')).getByText('Allow'))
      fireEvent.click(screen.getByText('switch'))
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByTestId('agent-trace-1.3')).toBe(listTrace) // same DOM node: not remounted, still expanded
      expect(screen.getByTestId('approval-r-1.2-1')).toBeTruthy() // the head allowed in Graph is gone from List
      fireEvent.click(screen.getByText('switch'))
      expect(screen.getByTestId('agent-graph-canvas')).toBe(canvas)
      expect(screen.getByTestId('graph-node-1.2').dataset.selected).toBe('true') // graph selection kept
      expect(screen.getByTestId('needs-focused').textContent).toContain('1 of 1') // and it shows 1.2's next request
    } finally { vi.useRealTimers() }
  })
})
