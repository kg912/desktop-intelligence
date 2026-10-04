import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import { useState } from 'react'

// Same Preact-signals shim as InputBar.test.tsx (jsdom has no signals runtime).
vi.mock('@preact/signals-react/runtime', () => {
  const { useState, useEffect, useRef } = require('react')
  return {
    useSignals: () => {},
    useSignal: (init: any) => {
      const ref = useRef<any>(null)
      const [, forceUpdate] = useState(0)
      if (!ref.current) {
        ref.current = {
          _val: init,
          get value() { return this._val },
          set value(v) { this._val = v; forceUpdate((x: number) => x + 1) },
          peek() { return this._val },
        }
      }
      return ref.current
    },
    useSignalEffect: (cb: any) => { useEffect(() => { cb() }) },
    useComputed: (cb: any) => ({ get value() { return cb() }, peek() { return cb() } }),
  }
})

import { FinalSynthesis, MultiAgentSidebarView } from '../../renderer/src/components/chat/MultiAgentSidebarView'
import { Sidebar } from '../../renderer/src/components/layout/Sidebar'
import type { AgentRailState } from '../../renderer/src/components/layout/Sidebar'
import { McpPermissionDialog } from '../../renderer/src/components/chat/McpPermissionDialog'
import { MultiAgentSettingsPanel } from '../../renderer/src/components/settings/MultiAgentSettingsPanel'
import { RunModelsSummary } from '../../renderer/src/components/settings/RunModelsSummary'
import { InputBar } from '../../renderer/src/components/layout/InputBar'
import { ModelStoreProvider, useModelStore } from '../../renderer/src/store/ModelStore'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import type { AgentEvent, McpToolPermissionRequest } from '../../shared/types'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'

let seq = 0
const ev = (e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq: ++seq, ts: 1_000 * seq, ...e }) as AgentEvent
const steps = [
  { id: '1.1', label: 'Research the market', stage: 'worker', role: 'Researcher', model: 'openai/gpt-4o', phase: 1 },
  { id: '1.2', label: 'Analyze the code', stage: 'worker', role: 'Analyzer', model: 'openai/gpt-4o', phase: 1 },
]
function view(extra: Array<Record<string, unknown>> = []) {
  seq = 0
  return reduceRunEvents('run-1', [ev({ type: 'orchestrator_plan', steps }), ...extra.map(ev)])
}

const dockProps = {
  task: 'Plan a 12-day Alps itinerary',
  config: { ...DEFAULT_MULTI_AGENT_CONFIG, budgetCapUsd: 0.5 },
  readOnly: false,
  estimate: { minUsd: 0.04, maxUsd: 0.18, unpricedModels: [] },
  permissionRequests: [] as McpToolPermissionRequest[],
  onRespondPermission: vi.fn(),
  onApprove: vi.fn(),
  onCancel: vi.fn(),
  onAbort: vi.fn(),
  focusAgentId: null as string | null,
  onSelectAgent: vi.fn(),
  onClose: vi.fn(),
}
const planPause = { type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} }
const agentRequest = (agentId: string, role: string): McpToolPermissionRequest => ({
  serverName: 'brave', toolName: 'brave__web_search', args: { q: 'hotels Füssen' }, requestId: `q-${agentId}`, chatId: 'c',
  agent: { runId: 'run-1', agentId, role, model: 'deepseek/flash' }, timeoutMs: 300_000,
})

beforeEach(() => vi.clearAllMocks())

describe('MultiAgentSidebarView (the widened sidebar dock)', () => {
  it('pre-flight replaces the card column: plan with dependencies, cost range, worst case, approve/cancel, no Abort', () => {
    seq = 0
    const v = reduceRunEvents('run-1', [
      ev({ type: 'orchestrator_plan', steps: [...steps, { id: '2.1', label: 'Draft the itinerary', stage: 'worker', role: 'Planner', model: 'w', phase: 2, dependsOn: ['1.1', '1.2'] }] }),
      ev(planPause),
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    const preflight = screen.getByTestId('preflight')
    expect(within(preflight).getByText('Planner · after 1.1, 1.2')).toBeTruthy()
    expect(within(preflight).getByText('$0.04 – $0.18')).toBeTruthy()
    expect(within(preflight).getByText(/Worst case \$0\.18/)).toBeTruthy()
    fireEvent.click(within(preflight).getByText('Approve & run'))
    fireEvent.click(within(preflight).getByText('Cancel'))
    expect(dockProps.onApprove).toHaveBeenCalledTimes(1)
    expect(dockProps.onCancel).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Abort')).toBeNull()
    expect(screen.queryByTestId('agent-card-1.1')).toBeNull()
  })

  it('caps the displayed worst case at the budget and names unpriced models', () => {
    render(<MultiAgentSidebarView {...dockProps} view={view([planPause])} estimate={{ minUsd: 0.2, maxUsd: 3, unpricedModels: ['x/free'] }} />)
    expect(screen.getByText(/Worst case \$0\.50/)).toBeTruthy()
    expect(screen.getByText(/No published price for x\/free/)).toBeTruthy()
  })

  it('running: totals against the cap, budget badge, Abort, statuses, and the parallel timeline', () => {
    const v = view([
      { type: 'hitl_resume', agentId: 'orchestrator', approved: true },
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'm' },
      { type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'm', runTotals: { costUsd: 0.51, tokens: 31_200, budgetReached: true } },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(screen.getByTestId('run-totals').textContent).toBe('$0.51 / $0.5031.2k tokBudget cap reached')
    expect(screen.getByTestId('concurrency-caption').textContent).toBe('2 agents running in parallel')
    expect(screen.getByTestId('lane-1.1').querySelector('i')!.dataset.s).toBe('run')
    expect(screen.getByTestId('agent-card-1.1').dataset.status).toBe('running')
    fireEvent.click(screen.getByText('Abort'))
    expect(dockProps.onAbort).toHaveBeenCalled()
  })

  it('a finished run reports the peak overlap; queued steps show their dependency hint', () => {
    seq = 0
    const graph = [...steps, { id: '2.1', label: 'Combine', stage: 'worker', role: 'Planner', model: 'w', phase: 2, dependsOn: ['1.1', '1.2'] }]
    const live = reduceRunEvents('run-1', [
      ev({ type: 'orchestrator_plan', steps: graph }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' }),
      ev({ type: 'agent_start', agentId: '1.2', role: 'A', model: 'm' }),
      ev({ type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'ok' }),
    ])
    const { unmount } = render(<MultiAgentSidebarView {...dockProps} view={live} />)
    expect(within(screen.getByTestId('step-2.1')).getByText('Waits for 1.2')).toBeTruthy()
    expect(screen.getByTestId('lane-2.1').querySelector('i')!.dataset.s).toBe('q')
    unmount()
    seq = 0
    const finished = reduceRunEvents('run-1', [
      ev({ type: 'orchestrator_plan', steps: graph }),
      ev({ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' }),
      ev({ type: 'agent_start', agentId: '1.2', role: 'A', model: 'm' }),
      ev({ type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'ok' }),
      ev({ type: 'reflection_result', agentId: '1.2', score: 4, passed: true, reason: 'ok' }),
      ev({ type: 'agent_start', agentId: '2.1', role: 'P', model: 'm' }),
      ev({ type: 'reflection_result', agentId: '2.1', score: 4, passed: true, reason: 'ok' }),
      ev({ type: 'task_complete', finalOutput: 'x', totalCostUsd: 0, totalTokens: 0 }),
    ])
    render(<MultiAgentSidebarView {...dockProps} view={finished} />)
    expect(screen.getByTestId('concurrency-caption').textContent).toBe('Peak: 2 agents in parallel')
    expect(screen.queryByText('Abort')).toBeNull()
  })

  it('accordion: the working agent is open, a passed agent collapses to its header (no trace rendered), clicks toggle', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'm' },
      { type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'm' },
      { type: 'agent_complete', agentId: '1.1', output: 'Salzburg first.', tokenCount: 14_800, costUsd: 0.02 },
      { type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'covers every cluster' },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(screen.getByTestId('agent-card-1.2').dataset.open).toBe('true')
    const passed = screen.getByTestId('agent-card-1.1')
    expect(passed.dataset.open).toBe('false')
    expect(within(passed).getByText('Pass 5/5')).toBeTruthy()
    expect(screen.queryByTestId('agent-trace-1.1')).toBeNull()
    fireEvent.click(within(passed).getByRole('button', { expanded: false }))
    expect(screen.getByTestId('agent-trace-1.1')).toBeTruthy()
    expect(within(passed).getByTestId('reflection-gate').textContent).toContain('5/5 — covers every cluster')
  })

  it('renders the trace: reasoning (clamped, expandable), tool rows, the answer, and a failed gate with its model and issues', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'TransAgent', model: 'deepseek/flash', attempt: 0 },
      { type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: 'Salzburg to Innsbruck is the long leg.' },
      { type: 'tool_start', agentId: '1.1', attempt: 0, callId: 'c1', tool: 'brave_web_search', server: 'brave', argsPreview: '{"q":"Railjet 24 December"}' },
      { type: 'tool_done', agentId: '1.1', attempt: 0, callId: 'c1', ok: true, durationMs: 1200, resultPreview: 'Railjet hourly', resultChars: 4200 },
      { type: 'agent_token', agentId: '1.1', attempt: 0, token: 'Vienna → Salzburg every 30 minutes.' },
      { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 2, passed: false, reason: 'Day 7 is impossible', model: 'meta-llama/llama-3.3-70b-instruct', issues: ['Split Hallstatt and Füssen'] },
      { type: 'retry', agentId: '1.1', attempt: 1, reason: 'Day 7 is impossible' },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    const card = screen.getByTestId('agent-card-1.1')
    expect(within(card).getByText('Retry 1 of 2')).toBeTruthy()
    const reasoning = within(card).getByTitle('Expand reasoning')
    expect(reasoning.className).toContain('line-clamp-3')
    fireEvent.click(reasoning)
    expect(within(card).getByTitle('Collapse reasoning').className).not.toContain('line-clamp-3')
    expect(within(card).getByText('brave_web_search')).toBeTruthy()
    expect(within(card).getByText('4,200 chars')).toBeTruthy()
    fireEvent.click(within(card).getByText('brave_web_search'))
    expect(within(card).getByText('Railjet hourly')).toBeTruthy()
    expect(within(card).getByText('Vienna → Salzburg every 30 minutes.')).toBeTruthy()
    const gate = within(card).getByTestId('reflection-gate')
    expect(gate.textContent).toContain('Reflection gate · attempt 1 · llama-3.3-70b-instruct')
    expect(gate.textContent).toContain('2/5 — Day 7 is impossible')
    expect(gate.textContent).toContain('Split Hallstatt and Füssen')
  })

  it('approval requests render inline in the agent\'s card: Approve, Deny, Trust this agent', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.2', role: 'StayAgent', model: 'm' },
      { type: 'hitl_pause', agentId: '1.2', role: 'StayAgent', serverName: 'brave', toolName: 'web_search', args: {} },
    ])
    const requests = [agentRequest('1.2', 'StayAgent')]
    const { rerender } = render(<MultiAgentSidebarView {...dockProps} view={v} permissionRequests={requests} />)
    const card = screen.getByTestId('agent-card-1.2')
    expect(within(card).getByText('Approval')).toBeTruthy()
    expect(within(screen.getByTestId('step-1.2')).getByText('Analyzer · needs approval')).toBeTruthy()
    fireEvent.click(within(card).getByText('Trust StayAgent for this run'))
    expect(dockProps.onRespondPermission).toHaveBeenCalledWith({ requestId: 'q-1.2', approved: true, alwaysAllow: false, userNote: '', agentTrust: 'trust' })
    rerender(<MultiAgentSidebarView {...dockProps} view={v} permissionRequests={[{ ...requests[0], requestId: 'q2' }]} />)
    fireEvent.click(within(screen.getByTestId('agent-card-1.2')).getByText('Deny'))
    expect(dockProps.onRespondPermission).toHaveBeenLastCalledWith({ requestId: 'q2', approved: false, alwaysAllow: false, userNote: '' })
  })

  it('read-only (a saved run): no Abort and no approvals', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.2', role: 'StayAgent', model: 'm' },
      { type: 'hitl_pause', agentId: '1.2', role: 'StayAgent', serverName: 'brave', toolName: 'web_search', args: {} },
    ])
    render(<MultiAgentSidebarView {...dockProps} readOnly view={v} permissionRequests={[agentRequest('1.2', 'StayAgent')]} />)
    expect(screen.queryByText('Abort')).toBeNull()
    expect(screen.queryByText('Approve')).toBeNull()
    expect(screen.getByText('read-only')).toBeTruthy()
  })

  it('clicking a step focuses its card: it opens and scrolls into view', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' },
      { type: 'agent_complete', agentId: '1.1', output: 'done', tokenCount: 1, costUsd: 0 },
      { type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'ok' },
    ])
    function Harness() {
      const [focus, setFocus] = useState<string | null>(null)
      return <MultiAgentSidebarView {...dockProps} view={v} focusAgentId={focus} onSelectAgent={setFocus} />
    }
    render(<Harness />)
    expect(screen.getByTestId('agent-card-1.1').dataset.open).toBe('false')
    fireEvent.click(screen.getByTestId('step-1.1'))
    expect(screen.getByTestId('agent-card-1.1').dataset.open).toBe('true')
    expect(screen.getByTestId('step-1.1').className).toContain('bg-ma-bg3')
  })

  it('Esc closes the dock', () => {
    render(<MultiAgentSidebarView {...dockProps} view={view()} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(dockProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('a builtin__brave_web_search call renders as a tool row; the header lists the offered tools', () => {
    const v = view([
      { type: 'run_config', models: DEFAULT_MULTI_AGENT_CONFIG.models, sources: {}, catalogueChecked: true, maxAgents: 4, budgetCapUsd: 0.5,
        reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium', tools: ['builtin__brave_web_search', 'fs__read_file', 'fs__list'] },
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'openai/gpt-4o', attempt: 0 },
      { type: 'tool_start', agentId: '1.1', attempt: 0, callId: 'c1', tool: 'brave_web_search', server: 'builtin', argsPreview: '{"query": "hotels Füssen"}' },
      { type: 'tool_done', agentId: '1.1', attempt: 0, callId: 'c1', ok: true, durationMs: 1200, resultPreview: 'Hotel Müller', resultChars: 12 },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(screen.getByTestId('agent-tools-1.1').textContent).toBe('Tools: brave_web_search, +2')
    expect(screen.getByTestId('agent-tools-1.1').title).toBe('builtin__brave_web_search, fs__read_file, fs__list')
    const trace = screen.getByTestId('agent-trace-1.1')
    expect(within(trace).getByText('brave_web_search')).toBeTruthy()
    expect(within(trace).getByText('{"query": "hotels Füssen"}')).toBeTruthy()
    expect(within(trace).getByText('12 chars')).toBeTruthy()
  })

  it('says "No tools" when none were offered, and shows nothing on traces from before tools were recorded', () => {
    const base = { type: 'run_config', models: DEFAULT_MULTI_AGENT_CONFIG.models, sources: {}, catalogueChecked: true, maxAgents: 4, budgetCapUsd: 0.5,
      reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium' }
    const { unmount } = render(<MultiAgentSidebarView {...dockProps} view={view([{ ...base, tools: [] }])} />)
    expect(screen.getByTestId('agent-tools-1.1').textContent).toBe('No tools')
    unmount()
    render(<MultiAgentSidebarView {...dockProps} view={view([base])} />)
    expect(screen.queryByTestId('agent-tools-1.1')).toBeNull()
  })

  it('shows its run models as chips: orchestrator, reflection and synthesizer from run_config', () => {
    const v = view([{
      type: 'run_config', models: { orchestrator: 'meta-llama/llama-3.3-70b-instruct', worker: 'w', reflection: 'qwen/judge', synthesizer: 'qwen/qwen3-235b' },
      sources: { orchestrator: 'saved', worker: 'active', reflection: 'saved', synthesizer: 'default' }, catalogueChecked: true,
      maxAgents: 4, budgetCapUsd: 0.5, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium',
    }])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    const chips = screen.getByLabelText('Run models').textContent
    expect(chips).toBe('orch · llama-3.3-70b-instructreflect · judgesynth · qwen3-235b')
  })
})

describe('The main-area synthesis', () => {
  it('before synthesis: counts passed agents; then streams with provenance chips that select the agent (D3)', () => {
    const onSelect = vi.fn()
    const waiting = view([
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' },
      { type: 'reflection_result', agentId: '1.1', score: 5, passed: true, reason: 'ok' },
    ])
    const { rerender } = render(<FinalSynthesis view={waiting} onSelectAgent={onSelect} />)
    expect(screen.getByTestId('synthesis').textContent).toContain('Starts when every agent has passed its gate. Currently 1 of 2 passed.')
    const streaming = view([{ type: 'synthesis_start' }, { type: 'synthesis_token', token: 'Rail first [1.1]; lodging [1.2].' }])
    rerender(<FinalSynthesis view={streaming} onSelectAgent={onSelect} />)
    const chip = within(screen.getByTestId('synthesis')).getByText('1.1')
    expect(chip.closest('a')?.getAttribute('href')).toBe('#agent-1.1')
    fireEvent.click(chip)
    expect(onSelect).toHaveBeenCalledWith('1.1')
  })
})

describe('Sidebar — multi-agent rail button and dock width', () => {
  const base = {
    onToggleChat: vi.fn(), onToggleStarred: vi.fn(), onToggleAgents: vi.fn(), agentsPanel: <div>dock-content</div>, overlayDock: false,
    chats: [], activeChatId: null, onSelectChat: vi.fn(), onNewChat: vi.fn(), onDeleteChat: vi.fn(), onRenameChat: vi.fn(),
    onStarChat: vi.fn(), onOpenSettings: vi.fn(),
  }
  const rail = (state: AgentRailState['state'], count = 0, visible = true): AgentRailState => ({ visible, state, count })

  it('is hidden until a run exists, then carries the run state: live (red + count), approval (amber + count), done, plain when open', () => {
    const { rerender } = render(<Sidebar {...base} sidebarMode="chat" agentRail={rail('idle', 0, false)} />)
    expect(screen.queryByTitle('Agent run')).toBeNull()
    rerender(<Sidebar {...base} sidebarMode="chat" agentRail={rail('live', 3)} />)
    expect(screen.getByTitle('Agent run').dataset.state).toBe('live')
    expect(screen.getByTestId('agent-rail-badge').textContent).toBe('3')
    rerender(<Sidebar {...base} sidebarMode="chat" agentRail={rail('approval', 1)} />)
    expect(screen.getByTitle('Agent run').dataset.state).toBe('approval')
    expect(screen.getByTestId('agent-rail-badge').textContent).toBe('1')
    rerender(<Sidebar {...base} sidebarMode="chat" agentRail={rail('done')} />)
    expect(screen.getByTitle('Agent run').dataset.state).toBe('done')
    expect(screen.queryByTestId('agent-rail-badge')).toBeNull()
    rerender(<Sidebar {...base} sidebarMode="agents" agentRail={rail('live', 3)} />)
    expect(screen.getByTitle('Agent run').dataset.state).toBe('open')
    expect(screen.queryByTestId('agent-rail-badge')).toBeNull()
    fireEvent.click(screen.getByTitle('Agent run'))
    expect(base.onToggleAgents).toHaveBeenCalled()
  })

  it('disabled outside agent chats: greyed, no badge, no glow state, no click, a tooltip that says why', () => {
    render(<Sidebar {...base} sidebarMode="chat" agentRail={{ ...rail('live', 3), disabled: true }} />)
    const button = screen.getByTitle('Only available in agent chats')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.dataset.state).toBe('disabled')
    expect(button.style.opacity).toBe('0.35')
    expect(screen.queryByTestId('agent-rail-badge')).toBeNull()
    fireEvent.click(button)
    expect(base.onToggleAgents).not.toHaveBeenCalled()
  })

  it('navigation lock: chats, favourites, settings, New, the chat list and search are greyed and inert with a tooltip', () => {
    const LOCK = 'Agents are running. Abort the run to leave.'
    const chats = [{ id: 'c1', title: 'Old trip', createdAt: 1, updatedAt: Date.now(), systemInstructions: null, starred: false }]
    render(<Sidebar {...base} chats={chats} sidebarMode="chat" navLocked agentRail={rail('live', 1)} />)
    expect(screen.getAllByTitle(LOCK).filter((el) => el.getAttribute('role') === 'button')).toHaveLength(3)
    const newButton = screen.getByText('New').closest('button')!
    expect(newButton.getAttribute('aria-disabled')).toBe('true')
    expect(newButton.title).toBe(LOCK)
    fireEvent.click(newButton)
    expect(base.onNewChat).not.toHaveBeenCalled()
    const list = screen.getByTestId('chat-list')
    expect(list.title).toBe(LOCK)
    expect(list.getAttribute('aria-disabled')).toBe('true')
    expect((list.firstElementChild as HTMLElement).style.pointerEvents).toBe('none')
    expect((screen.getByPlaceholderText('Search…') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getAllByTitle(LOCK)[0])
    expect(base.onToggleChat).not.toHaveBeenCalled()
    expect(base.onOpenSettings).not.toHaveBeenCalled()
  })

  it('one panel, two widths: 264 px for chats and favourites, 760 px for the dock, 0 when closed; overlay below 1280 px', () => {
    const { rerender } = render(<Sidebar {...base} sidebarMode="chat" agentRail={rail('live', 1)} />)
    const panel = (): HTMLElement => screen.getByTestId('sidebar-panel')
    expect(panel().style.width).toBe('264px')
    rerender(<Sidebar {...base} sidebarMode="starred" agentRail={rail('live', 1)} />)
    expect(panel().style.width).toBe('264px')
    rerender(<Sidebar {...base} sidebarMode="agents" agentRail={rail('live', 1)} />)
    expect(panel().style.width).toBe('760px')
    expect(screen.getByText('dock-content')).toBeTruthy()
    expect(screen.queryByText('No chats yet')).toBeNull()
    expect(panel().style.position).toBe('')
    rerender(<Sidebar {...base} sidebarMode="agents" overlayDock agentRail={rail('live', 1)} />)
    expect(panel().style.position).toBe('absolute')
    rerender(<Sidebar {...base} sidebarMode={null} agentRail={rail('live', 1)} />)
    expect(panel().style.width).toBe('0px')
  })
})

describe('McpPermissionDialog — agent identity and per-agent trust', () => {
  const agentRequest: McpToolPermissionRequest = {
    serverName: 'filesystem', toolName: 'read_file', args: { path: '/spec' }, requestId: 'r1', chatId: 'c',
    agent: { runId: 'run-1', agentId: '1.2', role: 'Analyzer', model: 'claude-3.5-sonnet' }, timeoutMs: 300_000,
  }

  it('shows who is asking and a countdown; Block sends agentTrust=block', () => {
    const onRespond = vi.fn()
    render(<McpPermissionDialog request={agentRequest} onRespond={onRespond} inline />)
    expect(screen.getByTestId('permission-subtitle').textContent).toBe('Analyzer Agent (claude-3.5-sonnet) is requesting access to read_file.')
    expect(screen.getByText('Auto-denies in 5:00')).toBeTruthy()
    fireEvent.click(screen.getByText('Block this agent'))
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ approved: false, agentTrust: 'block' }))
  })

  it('single-model requests keep the original dialog without agent actions', () => {
    const { agent: _a, timeoutMs: _t, ...plain } = agentRequest
    render(<McpPermissionDialog request={plain} onRespond={vi.fn()} />)
    expect(screen.getByText('Tool permission required')).toBeTruthy()
    expect(screen.queryByText('Block this agent')).toBeNull()
    expect(screen.queryByText(/Auto-denies/)).toBeNull()
  })
})

describe('InputBar — multi-agent states', () => {
  function setApi(provider: string) {
    ;(window as any).api = {
      ...(window as any).api,
      getBackendSettings: vi.fn().mockResolvedValue({ provider }),
      setBypassPermissions: vi.fn().mockResolvedValue(undefined),
      getFilePath: vi.fn(),
    }
  }

  function ModeProbe() {
    const { multiAgentMode } = useModelStore()
    return <span data-testid="mode">{String(multiAgentMode)}</span>
  }

  it('shows the agent-specific lock message while locked', () => {
    setApi('openrouter')
    render(<ModelStoreProvider><InputBar disabled lockedMessage="Analyzer Agent needs your approval" /></ModelStoreProvider>)
    expect(screen.getByTestId('input-locked-message').textContent).toContain('Analyzer Agent needs your approval')
  })

  it('multi-agent mode: breathing glow on, attachments off — and it is reset when the backend is not OpenRouter (D10)', async () => {
    setApi('openrouter')
    function Harness() {
      const [key, setKey] = useState(0)
      return (
        <ModelStoreProvider>
          <InputBar key={key} />
          <ModeProbe />
          <button onClick={() => setKey((k) => k + 1)}>remount</button>
        </ModelStoreProvider>
      )
    }
    const { container } = render(<Harness />)
    const toggle = await screen.findByText('Multi-Agent')
    fireEvent.click(toggle)
    expect(screen.getByTestId('mode').textContent).toBe('true')
    expect(container.querySelector('.ma-breathe')).toBeTruthy()
    expect((screen.getByTitle('Multi-agent runs do not take attachments') as HTMLButtonElement).disabled).toBe(true)

    setApi('lmstudio')
    await act(async () => { fireEvent.click(screen.getByText('remount')) })
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('false'))
    expect(screen.queryByText('Multi-Agent')).toBeNull()
  })
})

describe('MultiAgentSettingsPanel', () => {
  // Phase 5 rebuilt the model pickers as a ModelSelect listbox (was a native <select>);
  // the same behaviours are asserted through it.
  it('filters the OpenRouter catalogue, shows prices per 1M, and saves the chosen models and reasoning effort', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    ;(window as any).api = {
      ...(window as any).api,
      getMultiAgentConfig: vi.fn().mockResolvedValue({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 }),
      getMultiAgentSidecarStatus: vi.fn().mockResolvedValue('running'),
      getMultiAgentCatalogue: vi.fn().mockResolvedValue({
        error: null,
        models: [
          { id: 'meta-llama/llama-3.3-70b-instruct', name: 'L', contextLength: 131_072, promptPrice: 1.3e-7, completionPrice: 4e-7, supportsTools: true },
          { id: 'tiny/no-tools', name: 'T', contextLength: 8_000, promptPrice: 1e-8, completionPrice: 1e-8, supportsTools: false },
        ],
      }),
      saveMultiAgentConfig: save,
      getBackendSettings: vi.fn().mockResolvedValue({ openrouterModel: 'deepseek/deepseek-v4.1-flash' }),
    }
    render(<MultiAgentSettingsPanel />)
    await screen.findByText('1 of 2 models')
    expect(screen.getByTestId('sidecar-status').textContent).toBe('running')
    const openWorker = (): void => fireEvent.click(screen.getByRole('combobox', { name: 'Worker agents model' }))
    openWorker()
    expect(screen.getByRole('option', { name: /meta-llama\/llama-3\.3-70b-instruct\$0\.130 \/ \$0\.400131k/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /tiny\/no-tools/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Worker agents model' }), { key: 'Escape' })

    fireEvent.click(screen.getByText('Requires tool-call support'))
    fireEvent.change(screen.getByLabelText('Min context'), { target: { value: '0' } })
    openWorker()
    fireEvent.mouseDown(screen.getByRole('option', { name: /tiny\/no-tools/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      models: expect.objectContaining({ worker: 'tiny/no-tools' }), maxAgents: 4, sidecarPort: 7823, reasoningEffort: 'high',
    })))
  })
})

describe('RunModelsSummary (refinement Phase 3)', () => {
  it('shows each role\'s model with its source: default, saved, follows active, not in catalogue', () => {
    const models = { orchestrator: DEFAULT_MULTI_AGENT_CONFIG.models.orchestrator, worker: '', reflection: 'my/judge', synthesizer: 'gone/model' }
    const catalogue = new Set([DEFAULT_MULTI_AGENT_CONFIG.models.orchestrator, 'my/judge', 'deepseek/flash'])
    render(<RunModelsSummary models={models} activeModel="deepseek/flash" catalogueIds={catalogue} />)
    const row = (role: string): string => screen.getByTestId(`run-model-${role}`).textContent ?? ''
    expect(row('orchestrator')).toBe(`Orchestrator${DEFAULT_MULTI_AGENT_CONFIG.models.orchestrator}default`)
    expect(row('worker')).toBe('Worker agentsdeepseek/flashfollows active model')
    expect(row('reflection')).toBe('Reflectionmy/judgesaved')
    expect(row('synthesizer')).toBe('Synthesizergone/modelnot in catalogue · run will not start')
    expect(screen.getByText('Active OpenRouter model: deepseek/flash')).toBeTruthy()
  })

  it('updates live from the settings dropdowns before saving, with an unsaved-changes marker', async () => {
    ;(window as any).api = {
      ...(window as any).api,
      getMultiAgentConfig: vi.fn().mockResolvedValue({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 }),
      getMultiAgentSidecarStatus: vi.fn().mockResolvedValue('running'),
      getMultiAgentCatalogue: vi.fn().mockResolvedValue({
        error: null,
        models: [{ id: 'meta-llama/llama-3.3-70b-instruct', name: 'L', contextLength: 131_072, promptPrice: 1.3e-7, completionPrice: 4e-7, supportsTools: true }],
      }),
      getBackendSettings: vi.fn().mockResolvedValue({ openrouterModel: 'deepseek/flash' }),
      saveMultiAgentConfig: vi.fn().mockResolvedValue(undefined),
    }
    render(<MultiAgentSettingsPanel />)
    await screen.findByText('Active OpenRouter model: deepseek/flash')
    await waitFor(() => expect(screen.getByTestId('run-model-synthesizer').textContent).toMatch(/not in catalogue/))
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    fireEvent.click(screen.getByRole('combobox', { name: 'Worker agents model' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: /meta-llama/ }))
    expect(screen.getByTestId('run-model-worker').textContent).toBe('Worker agentsmeta-llama/llama-3.3-70b-instructsaved')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })
})

describe('Reasoning view and card fixes (Part E)', () => {
  const reasoningView = (text: string, extra: Array<Record<string, unknown>> = []) => view([
    { type: 'agent_start', agentId: '1.1', role: 'TransAgent', model: 'deepseek/flash', attempt: 0 },
    { type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: text },
    ...extra,
  ])

  it('collapsed: 3 lines; expanded: capped at 18 lines by CSS and scrolls inside; never clipped at the card edge', () => {
    render(<MultiAgentSidebarView {...dockProps} view={reasoningView('In this leg the Railjet takes two hours.')} />)
    const block = screen.getByTitle('Expand reasoning')
    expect(block.className).toContain('line-clamp-3')
    expect(block.className).toContain('min-w-0')
    expect(block.className).toContain('[overflow-wrap:anywhere]')
    fireEvent.click(block)
    const open = screen.getByTitle('Collapse reasoning')
    expect(open.dataset.expanded).toBe('true')
    expect(open.className).not.toContain('line-clamp-3')
    expect(open.className).toContain('ma-reasoning')
    const css = require('fs').readFileSync(require('path').resolve(__dirname, '../../renderer/src/styles/globals.css'), 'utf8') as string
    expect(css).toContain('.ma-reasoning[data-expanded="true"] { max-height: 18lh; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #2a2a2a transparent; }')
  })

  it('while streaming, follows the end unless the user scrolled up', () => {
    const { rerender } = render(<MultiAgentSidebarView {...dockProps} view={reasoningView('step one')} />)
    fireEvent.click(screen.getByTitle('Expand reasoning'))
    const block = screen.getByTitle('Collapse reasoning')
    let height = 800
    Object.defineProperty(block, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(block, 'clientHeight', { configurable: true, get: () => 380 })
    height = 900
    rerender(<MultiAgentSidebarView {...dockProps} view={reasoningView('step one', [{ type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: ' two' }])} />)
    expect(block.scrollTop).toBe(900)
    block.scrollTop = 100
    fireEvent.scroll(block)
    height = 1000
    rerender(<MultiAgentSidebarView {...dockProps} view={reasoningView('step one', [
      { type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: ' two' },
      { type: 'agent_reasoning', agentId: '1.1', attempt: 0, token: ' three' },
    ])} />)
    expect(block.scrollTop).toBe(100)
  })

  it('a just-started agent never shows a negative elapsed time', () => {
    seq = 0
    const v = reduceRunEvents('run-1', [
      ev({ type: 'orchestrator_plan', steps }),
      { ...ev({ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 }), ts: Date.now() + 5_000 },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    const header = within(screen.getByTestId('agent-card-1.1')).getByRole('button', { expanded: true })
    expect(header.textContent).toContain('0s')
    expect(header.textContent).not.toMatch(/-\d+s/)
  })

  it('a live card with no content shows plain "Working…" (no timeline marker) and the same chevron as other cards', () => {
    render(<MultiAgentSidebarView {...dockProps} view={view([{ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 }])} />)
    const trace = screen.getByTestId('agent-trace-1.1')
    expect(screen.getByTestId('agent-empty-1.1').textContent).toBe('Working…')
    expect(trace.querySelector('.ma-ev')).toBeNull()
    const chevron = (id: string): string => screen.getByTestId(`agent-card-${id}`).querySelector('button > svg')!.getAttribute('class')!.replace(' rotate-180', '')
    expect(chevron('1.1')).toBe(chevron('1.2'))
  })
})

describe('Output limits (Part F)', () => {
  it('a cut-off agent and a cut-off synthesis show which limit ended them', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 },
      { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'Day 1: Vienna. Day 2: Hallst', tokenCount: 9, costUsd: 0, truncated: 'budget' },
      { type: 'agent_start', agentId: '1.2', role: 'A', model: 'm', attempt: 0 },
      { type: 'agent_complete', agentId: '1.2', attempt: 0, output: 'Full answer', tokenCount: 9, costUsd: 0 },
      { type: 'synthesis_start' },
      { type: 'task_complete', finalOutput: 'Itinerary [1.1]', totalCostUsd: 0, totalTokens: 9, truncated: 'context' },
    ])
    render(<MultiAgentSidebarView {...dockProps} view={v} />)
    expect(screen.getByTestId('cut-off-1.1').textContent).toBe('Cut off: budget cap')
    expect(screen.queryByTestId('cut-off-1.2')).toBeNull()
    render(<FinalSynthesis view={v} onSelectAgent={vi.fn()} />)
    expect(screen.getByTestId('cut-off-synthesis').textContent).toBe('Cut off: context window')
  })

  it('a retry clears the previous attempt\'s cut-off', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 },
      { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'x', tokenCount: 1, costUsd: 0, truncated: 'context' },
      { type: 'retry', agentId: '1.1', attempt: 1, reason: 'too short' },
    ])
    expect(v.agents['1.1'].truncated).toBeUndefined()
  })

  it('the budget cap setting explains that it is the only output limit besides the context window', async () => {
    ;(window as any).api = {
      ...(window as any).api,
      getMultiAgentConfig: vi.fn().mockResolvedValue({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 }),
      getMultiAgentCatalogue: vi.fn().mockResolvedValue({ models: [], error: null }),
      getBackendSettings: vi.fn().mockResolvedValue({ provider: 'openrouter', openrouterModel: 'x/y' }),
    }
    render(<MultiAgentSettingsPanel />)
    expect(await screen.findByText("Output length is limited only by this budget and the model's context window.")).toBeTruthy()
  })
})

describe('run history in the dock header', () => {
  const done = () => view([{ type: 'task_complete', finalOutput: 'x', totalCostUsd: 0, totalTokens: 0 }])

  it('shows "Run N of M" with prev/next for a saved run and asks for the neighbouring run ids', () => {
    const onShowRun = vi.fn()
    render(<MultiAgentSidebarView {...dockProps} readOnly view={done()} runIds={['run-0', 'run-1', 'run-2']} onShowRun={onShowRun} />)
    expect(screen.getByTestId('run-position').textContent).toBe('Run 2 of 3')
    fireEvent.click(screen.getByLabelText('Previous run'))
    fireEvent.click(screen.getByLabelText('Next run'))
    expect(onShowRun.mock.calls).toEqual([['run-0'], ['run-2']])
  })

  it('disables the ends, hides with a single run, and locks while a live run is shown', () => {
    const { unmount } = render(<MultiAgentSidebarView {...dockProps} readOnly view={done()} runIds={['run-0', 'run-1']} />)
    expect(screen.getByTestId('run-position').textContent).toBe('Run 2 of 2')
    expect((screen.getByLabelText('Next run') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Previous run') as HTMLButtonElement).disabled).toBe(false)
    unmount()
    const single = render(<MultiAgentSidebarView {...dockProps} readOnly view={done()} runIds={['run-1']} />)
    expect(screen.queryByTestId('run-position')).toBeNull()
    single.unmount()
    render(<MultiAgentSidebarView {...dockProps} view={view([{ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' }])} runIds={['run-0', 'run-1']} />)
    expect((screen.getByLabelText('Previous run') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('Max tool rounds', () => {
  it('the slider ends in an Unlimited stop that saves null, and its help names the three remaining stops', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    ;(window as any).api = {
      ...(window as any).api,
      getMultiAgentConfig: vi.fn().mockResolvedValue({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 }),
      getMultiAgentSidecarStatus: vi.fn().mockResolvedValue('running'),
      getMultiAgentCatalogue: vi.fn().mockResolvedValue({ models: [], error: null }),
      getBackendSettings: vi.fn().mockResolvedValue({ provider: 'openrouter', openrouterModel: 'x/y' }),
      saveMultiAgentConfig: save,
    }
    render(<MultiAgentSettingsPanel />)
    const slider = await screen.findByLabelText('Max tool rounds') as HTMLInputElement
    expect(slider.min).toBe('1')
    await waitFor(() => expect(slider.value).toBe(String(DEFAULT_MULTI_AGENT_CONFIG.maxToolRounds)))
    expect(screen.getByText(/budget cap, the repetition guard and the model's context window/)).toBeTruthy()
    fireEvent.change(slider, { target: { value: slider.max } })
    expect(screen.getByText('Unlimited')).toBeTruthy()
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ maxToolRounds: null })))
    fireEvent.change(slider, { target: { value: '50' } })
    expect(screen.queryByText('Unlimited')).toBeNull()
  })

  it('an agent answered on the forced last round shows "stopped at tool limit"; a retry clears it', () => {
    const events = [
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 },
      { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'findings', tokenCount: 1, costUsd: 0, stoppedAtToolLimit: true },
      { type: 'agent_start', agentId: '1.2', role: 'A', model: 'm', attempt: 0 },
      { type: 'agent_complete', agentId: '1.2', attempt: 0, output: 'answer', tokenCount: 1, costUsd: 0 },
    ]
    render(<MultiAgentSidebarView {...dockProps} view={view(events)} />)
    expect(screen.getByTestId('tool-limit-1.1').textContent).toBe('stopped at tool limit')
    expect(screen.queryByTestId('tool-limit-1.2')).toBeNull()
    expect(view([...events, { type: 'retry', agentId: '1.1', attempt: 1, reason: 'score 2/5' }]).agents['1.1'].stoppedAtToolLimit).toBeUndefined()
  })
})
