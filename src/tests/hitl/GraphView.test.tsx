/** Goals 6 and 7 — graph view with the HITL inbox in a collapsible bottom dock (designs/06, 08–10). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import { AUTO_FIT_MIN_SCALE, fitView, pickDensity } from '../../renderer/src/components/chat/AgentGraphCanvas'
import { COMPACT_METRICS, GRAPH_METRICS, layoutDag } from '../../renderer/src/lib/dagLayout'
import { formatElapsed } from '../../renderer/src/lib/multiAgentRunState'
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
// This jsdom setup has no localStorage (the app's reads/writes are try/caught); an in-memory one stands in.
const store = new Map<string, string>()
const memoryStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, clear: () => store.clear() }

describe('GraphView', () => {
  it('draws the runtime plan: orchestrator, phase columns, workers, final synthesis; columns labelled from the phases', () => {
    graph()
    expect([...document.querySelectorAll('[data-graph-node]')].map((n) => (n as HTMLElement).dataset.graphNode)).toEqual(['orch', '1.1', '1.2', '1.3', '1.5', 'out'])
    const text = screen.getByTestId('agent-graph-canvas').textContent!
    for (const label of ['PLAN', 'PHASE 1 · PARALLEL WORKERS', 'PHASE 2', 'OUTPUT']) expect(text).toContain(label)
    expect(screen.getByTestId('graph-node-1.5').textContent).toContain('waits on 1.1 1.2 1.3')
    expect(screen.getByTestId('graph-node-1.1').style.height).toBe('80px')
    expect(screen.getByTestId('graph-node-1.1').querySelector('[data-testid="graph-node-meta"]')).toBeTruthy()
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
    expect(screen.getByTestId('graph-selection').textContent).toBe('1.3 · feeds 1.5')
    fireEvent.doubleClick(screen.getByTestId('graph-node-1.3'))
    expect(props.onOpenAgent).toHaveBeenCalledWith('1.3')
    fireEvent.click(screen.getByText('Open full view'))
    expect(props.onOpenAgent).toHaveBeenCalledTimes(2)
  })

  it('Needs you: one horizontal card per waiting agent (head of its queue) with +N queued, tool, args or code, Allow / Trust agent / Deny', () => {
    graph(running(), [req('1.2', 0, { code: 'df.groupby("peer")' }), req('1.2', 1, { code: 'df.to_csv(...)' }), req('1.3', 0), req('1.1', 0), req('1.1', 1)])
    expect(screen.getByTestId('needs-count').textContent).toBe('5')
    expect(screen.getByTestId('needs-summary').textContent).toBe('5 tool calls waiting across 3 agents')
    expect(screen.getByText('Trust web_search for all')).toBeTruthy()
    expect(screen.getAllByTestId(/^needs-card-\d/).map((c) => c.dataset.testid)).toEqual(['needs-card-1.1', 'needs-card-1.2', 'needs-card-1.3'])
    const c12 = screen.getByTestId('needs-card-1.2')
    expect(c12.textContent).toContain('Financial')
    expect(c12.textContent).toContain('+1')
    expect(within(c12).getByTestId('needs-card-args').textContent).toBe('df.groupby("peer")')
    expect(within(screen.getByTestId('needs-card-1.3')).getByTestId('needs-card-args').textContent).toBe('q: "q0"')
    expect(screen.getByTestId('needs-card-1.3').textContent).not.toContain('+')
    fireEvent.click(within(c12).getByText('Trust agent'))
    expect(props.onRespond).toHaveBeenCalledWith({ requestId: 'r-1.2-0', approved: true, alwaysAllow: false, userNote: '', agentTrust: 'trust' })
    fireEvent.click(within(screen.getByTestId('needs-card-1.3')).getByText('Deny'))
    expect(props.onRespond).toHaveBeenLastCalledWith({ requestId: 'r-1.3-0', approved: false, alwaysAllow: false, userNote: '' })
    fireEvent.click(screen.getByText('Trust web_search for all'))
    expect(props.onRespond).toHaveBeenCalledTimes(2 + 5)
    expect(props.onRespond).toHaveBeenLastCalledWith({ requestId: 'r-1.1-1', approved: true, alwaysAllow: 'session', userNote: '' })
  })

  it('Needs you keyboard: J/K move between cards, Y allows, N denies, only with focus in the panel', () => {
    graph(running(), [req('1.1', 0), req('1.3', 0)])
    fireEvent.keyDown(window, { key: 'y' })
    expect(props.onRespond).not.toHaveBeenCalled()
    const group = screen.getByRole('group', { name: 'Approvals' })
    fireEvent.keyDown(group, { key: 'j' })
    expect(document.activeElement).toBe(screen.getByTestId('needs-card-1.1'))
    fireEvent.keyDown(group, { key: 'j' })
    expect(document.activeElement).toBe(screen.getByTestId('needs-card-1.3'))
    fireEvent.keyDown(group, { key: 'n' })
    expect(props.onRespond).toHaveBeenLastCalledWith({ requestId: 'r-1.3-0', approved: false, alwaysAllow: false, userNote: '' })
    fireEvent.keyDown(group, { key: 'k' })
    fireEvent.keyDown(group, { key: 'y' })
    expect(props.onRespond).toHaveBeenLastCalledWith({ requestId: 'r-1.1-0', approved: true, alwaysAllow: false, userNote: '' })
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
    expect(stats).toContain('1 reflection check · 0/4 passed')
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
      fireEvent.click(within(screen.getByTestId('needs-card-1.2')).getByText('Allow'))
      fireEvent.click(screen.getByText('switch'))
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.getByTestId('agent-trace-1.3')).toBe(listTrace) // same DOM node: not remounted, still expanded
      expect(screen.getByTestId('approval-r-1.2-1')).toBeTruthy() // the head allowed in Graph is gone from List
      fireEvent.click(screen.getByText('switch'))
      expect(screen.getByTestId('agent-graph-canvas')).toBe(canvas)
      expect(screen.getByTestId('graph-node-1.2').dataset.selected).toBe('true') // graph selection kept
      expect(within(screen.getByTestId('needs-card-1.2')).getByTestId('needs-card-args').textContent).toBe('q: "q1"') // and it shows 1.2's next request
    } finally { vi.useRealTimers() }
  })
})

describe('fitView', () => {
  it('fits and centres a graph that fits; a too-wide graph auto-fits no smaller than readable and starts at its left edge; the fit button fits it all', () => {
    expect(fitView({ w: 1000, h: 600 }, { width: 500, height: 300 }, true)).toEqual({ k: 1, x: 250, y: 150 })
    const auto = fitView({ w: 500, h: 600 }, { width: 1600, height: 400 }, true)
    expect(auto).toEqual({ k: AUTO_FIT_MIN_SCALE, x: 8, y: (600 - 400 * AUTO_FIT_MIN_SCALE) / 2 })
    // The height always fits (a short canvas under a tall dock): the floor applies to width only.
    expect(fitView({ w: 1104, h: 286 }, { width: 1336, height: 502 }, true).k).toBeCloseTo(270 / 502)
    const all = fitView({ w: 500, h: 600 }, { width: 1600, height: 400 }, false)
    expect(all.k).toBeCloseTo(484 / 1600)
    expect(all.x).toBeCloseTo((500 - 1600 * all.k) / 2)
  })
})

describe('bottom dock (Goal 7)', () => {
  const dockOf = () => screen.getByTestId('graph-dock')
  const mode = () => dockOf().dataset.mode
  const Live = ({ requests, chatId = 'chat-1', active = true }: { requests: McpToolPermissionRequest[]; chatId?: string; active?: boolean }) =>
    <GraphView {...props} view={running()} queues={approvalQueues(requests, 'run-1')} chatId={chatId} active={active} />
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage); store.clear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('the right-hand inspector is gone: the canvas takes the width, the dock sits under it and above the stats strip', () => {
    const v = running()
    render(<GraphView {...props} view={v} queues={new Map()} />)
    expect(screen.queryByTestId('graph-inspector')).toBeNull()
    expect(screen.queryByRole('complementary')).toBeNull()
    const canvas = screen.getByTestId('agent-graph-canvas')
    const stats = screen.getByTestId('graph-stats')
    expect(canvas.compareDocumentPosition(dockOf()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dockOf().compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Idle run: collapsed 44px bar with tab counts, the latest log line, the Cmd+J hint and an expand button.
    expect(mode()).toBe('collapsed')
    expect(dockOf().style.height).toBe('44px')
    expect(screen.getByTestId('dock-chip-needs').textContent).toBe('Needs you 0')
    expect(screen.getByTestId('dock-chip-node').textContent).toBe('Node none selected')
    expect(screen.getByTestId('dock-chip-log').textContent).toBe('Run log')
    const last = v.log.at(-1)!
    expect(screen.getByTestId('dock-latest').textContent).toBe(`${formatElapsed(last.ts - v.startedAt)} · ${last.text}`)
    expect(screen.getByTestId('dock-bar').textContent).toContain('⌘J')
    const expand = screen.getByRole('button', { name: 'Expand panel' })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    // Open: handle, then tabs (tablist / tab / tabpanel), then the body.
    expect(screen.getByRole('separator', { name: 'Resize panel' })).toBeTruthy()
    expect(within(screen.getByRole('tablist')).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Needs you', 'Node', 'Run log'])
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('graph-dock-tab-needs')
    expect(screen.getByRole('button', { name: 'Collapse panel' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Run log' }))
    expect(within(screen.getByRole('tabpanel')).getByTestId('run-log')).toBeTruthy()
  })

  it('first approvals: opens once on Needs you, announces it politely without moving focus; closes ~2s after the queue empties if untouched', () => {
    const { rerender } = render(<Live requests={[]} />)
    const before = document.activeElement
    rerender(<Live requests={[req('1.1', 0), req('1.2', 0)]} />)
    expect(mode()).toBe('auto')
    expect(screen.getByRole('tab', { name: 'Needs you 2' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('dock-auto-chip').textContent).toBe('auto-opened · closes when queue is empty')
    const live = screen.getByTestId('dock-announce')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('2 approvals need you')
    expect(document.activeElement).toBe(before)
    rerender(<Live requests={[]} />)
    act(() => { vi.advanceTimersByTime(1999) })
    expect(mode()).toBe('auto')
    act(() => { vi.advanceTimersByTime(1) })
    expect(mode()).toBe('collapsed')
  })

  it('touched while open: no auto-close', () => {
    const { rerender } = render(<Live requests={[req('1.1', 0)]} />)
    fireEvent.pointerDown(dockOf())
    rerender(<Live requests={[]} />)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(mode()).toBe('auto')
  })

  it('collapsed while approvals wait: stays collapsed with a yellow, pulsing bar and the count; only a new batch re-opens it', () => {
    const { rerender } = render(<Live requests={[req('1.1', 0)]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    rerender(<Live requests={[req('1.1', 0), req('1.3', 0)]} />)
    expect(mode()).toBe('collapsed')
    expect(dockOf().className).toContain('ma-gdock-alert')
    expect(dockOf().className).toContain('border-[#e6b422]/55')
    expect(screen.getByTestId('dock-chip-needs').textContent).toBe('Needs you 2')
    rerender(<Live requests={[]} />)
    rerender(<Live requests={[req('1.2', 0)]} />)
    expect(mode()).toBe('auto')
  })

  it('selecting a node opens a peek on the Node tab; Esc closes it (and only it); so does a click on empty canvas', () => {
    const onKey = vi.fn()
    window.addEventListener('keydown', onKey)
    render(<Live requests={[]} />)
    fireEvent.click(screen.getByTestId('graph-node-1.3'))
    expect(mode()).toBe('peek')
    expect(screen.getByRole('tab', { name: 'Node 1.3' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mode()).toBe('collapsed')
    expect(onKey.mock.calls[0][0].defaultPrevented).toBe(true) // the run view's own Esc (close the panel) skips it
    fireEvent.click(screen.getByTestId('graph-node-1.1'))
    expect(mode()).toBe('peek')
    const canvas = screen.getByTestId('agent-graph-canvas')
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5 })
    fireEvent.pointerUp(canvas, { clientX: 5, clientY: 5 })
    expect(mode()).toBe('collapsed')
    // A dock the user opened is not a peek-by-selection: Esc leaves it.
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mode()).toBe('peek')
    window.removeEventListener('keydown', onKey)
  })

  it('Cmd+J toggles the dock, only while the Graph view is showing', () => {
    const { rerender } = render(<Live requests={[]} />)
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(mode()).toBe('peek')
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(mode()).toBe('collapsed')
    rerender(<Live requests={[]} active={false} />)
    fireEvent.keyDown(window, { key: 'j', metaKey: true })
    expect(mode()).toBe('collapsed')
  })

  it('Run log never opens by itself', () => {
    const { rerender } = render(<Live requests={[req('1.1', 0)]} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Run log' }))
    rerender(<Live requests={[]} />)
    rerender(<Live requests={[req('1.2', 0)]} />)
    expect(screen.getByRole('tab', { name: 'Run log' }).getAttribute('aria-selected')).toBe('true') // already open: tab untouched
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }))
    rerender(<Live requests={[]} />)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(mode()).toBe('collapsed')
  })

  it('pinned: survives a reload of the same chat, never auto-closes; other chats keep their own state', () => {
    const first = render(<Live requests={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand panel' }))
    fireEvent.click(screen.getByTestId('dock-pin'))
    expect(mode()).toBe('pinned')
    expect(JSON.parse(localStorage.getItem('di.graphDock.chat-1')!)).toMatchObject({ pinned: true })
    first.unmount()
    const again = render(<Live requests={[]} />)
    expect(mode()).toBe('pinned')
    again.rerender(<Live requests={[req('1.1', 0)]} />)
    again.rerender(<Live requests={[]} />)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(mode()).toBe('pinned')
    again.rerender(<Live requests={[]} chatId="chat-2" />)
    expect(mode()).toBe('collapsed')
    again.rerender(<Live requests={[]} chatId="chat-1" />)
    expect(mode()).toBe('pinned')
  })
})

describe('bottom dock sizes (measured pane)', () => {
  class FakeRO {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width: 1240, height: 800 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect() {}
    unobserve() {}
  }
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage); store.clear(); vi.stubGlobal('ResizeObserver', FakeRO) })
  afterEach(() => vi.unstubAllGlobals())

  it('auto-open ~38% of the pane; the handle resizes with the arrow keys and pins at that height', () => {
    render(<GraphView {...props} view={running()} queues={approvalQueues([req('1.1', 0)], 'run-1')} chatId="c" />)
    expect(screen.getByTestId('graph-dock').style.height).toBe('304px') // 38% of 800
    const handle = screen.getByRole('separator', { name: 'Resize panel' })
    expect(handle.getAttribute('aria-valuenow')).toBe('38')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(screen.getByTestId('graph-dock').dataset.mode).toBe('pinned')
    expect(screen.getByTestId('graph-dock').style.height).toBe('344px')
    expect(screen.getByTestId('dock-pin-label').textContent).toBe('43% · drag to resize')
    for (let i = 0; i < 10; i++) fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(screen.getByTestId('graph-dock').style.height).toBe('480px') // the 60% cap
    for (let i = 0; i < 20; i++) fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(screen.getByTestId('graph-dock').style.height).toBe('240px') // the 240px floor
  })
})

describe('pickDensity', () => {
  // The designs' plan: orchestrator, six workers, 1.5, 1.8, final synthesis.
  const nodes = [
    { id: 'orch' }, ...['1.1', '1.2', '1.3', '1.4', '1.6', '1.7'].map((id) => ({ id, dependsOn: ['orch'] })),
    { id: '1.5', dependsOn: ['1.1', '1.2', '1.3', '1.4'] }, { id: '1.8', dependsOn: ['1.5', '1.6', '1.7'] }, { id: 'out', dependsOn: ['1.8'] },
  ]
  const regular = layoutDag(nodes, GRAPH_METRICS)
  const compact = layoutDag(nodes, COMPACT_METRICS)
  it('regular cards with the dock collapsed (08); compact when the dock is open and the height binds (09); the whole graph fits at 1240px', () => {
    expect(pickDensity({ w: 1240, h: 840 }, regular, compact)).toBe('regular')
    expect(pickDensity({ w: 1240, h: 520 }, regular, compact)).toBe('compact')
    expect(pickDensity({ w: 0, h: 0 }, regular, compact)).toBe('regular')
    for (const h of [840, 520, 380]) {
      const layout = pickDensity({ w: 1240, h }, regular, compact) === 'compact' ? compact : regular
      const v = fitView({ w: 1240, h }, layout, true)
      expect(v.x).toBeGreaterThanOrEqual(0)
      expect(v.x + layout.width * v.k).toBeLessThanOrEqual(1240)
      expect(v.y + layout.height * v.k).toBeLessThanOrEqual(h)
    }
  })
})

describe('spec B 7b: assess in the dock', () => {
  const rules = { checklist: { open: 1, total: 1 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.1, capUsd: 1 }, progress: 'first', tools: 'n/a' }

  it('an ask_user question joins Needs you (counted, the dock opens), and the run gets an Assess tab', () => {
    const onAssess = vi.fn()
    const v = running([
      { type: 'ledger_update', ledger: { r1: { status: 'unverified', claimIds: [] } }, counts: { verified: 0, unverified: 1, conflicted: 0, missing: 0, pending: 0 } },
      { type: 'assess_start', wave: 1, open: 1 },
      { type: 'assess_decision', wave: 1, decision: 'ask_user', reason: 'Only you know.', question: 'Kayseri or Nevşehir?', steps: [], unclosable: [], costUsd: 0.001, durationMs: 800, model: 'm/a', rules },
      { type: 'hitl_pause', agentId: 'assess', role: 'Assess', model: 'm/a', toolName: 'ask_user', serverName: 'multi-agent', args: { question: 'Kayseri or Nevşehir?' } },
    ])
    render(<GraphView {...props} view={{ ...v, checklist: [{ id: 'r1', text: 'Leg 2 airport', scope: 'global' }] }} queues={new Map()} onAssess={onAssess} />)
    expect(screen.getByTestId('needs-count').textContent).toBe('1')
    const needs = screen.getByTestId('needs-assess')
    expect(within(needs).getByTestId('assess-question').textContent).toBe('Kayseri or Nevşehir?')
    fireEvent.change(within(needs).getByLabelText('Your answer'), { target: { value: 'Kayseri' } })
    fireEvent.click(within(needs).getByRole('button', { name: 'Answer' }))
    expect(onAssess).toHaveBeenCalledWith({ kind: 'answer', answer: 'Kayseri' })
    fireEvent.click(screen.getByRole('tab', { name: 'Assess' }))
    expect(screen.getByTestId('coverage-section')).toBeTruthy()
  })
})
