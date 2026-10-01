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

import { MultiAgentPlanPane } from '../../renderer/src/components/chat/MultiAgentPlanPane'
import { MultiAgentExecutionArea } from '../../renderer/src/components/chat/MultiAgentExecutionArea'
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

const paneProps = {
  task: 'Analyze MU stock',
  collapsed: false,
  onToggleCollapsed: vi.fn(),
  estimate: { minUsd: 0.04, maxUsd: 0.18, unpricedModels: [] },
  budgetCapUsd: 0.5,
  readOnly: false,
  onApprove: vi.fn(),
  onCancel: vi.fn(),
  onAbort: vi.fn(),
  onSelectAgent: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

describe('MultiAgentPlanPane', () => {
  it('pre-flight: shows the plan tree, the cost range with worst case prominent, and approve/cancel', () => {
    const v = view([{ type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} }])
    render(<MultiAgentPlanPane {...paneProps} view={v} />)
    expect(screen.getByText('Orchestrator Plan')).toBeTruthy()
    expect(screen.getByText('1.1 · Research the market')).toBeTruthy()
    const preflight = screen.getByTestId('preflight')
    expect(within(preflight).getByText('$0.04 – $0.18')).toBeTruthy()
    expect(within(preflight).getByText(/Worst case \$0\.18/)).toBeTruthy()
    fireEvent.click(within(preflight).getByText('Approve & run'))
    fireEvent.click(within(preflight).getByText('Cancel'))
    expect(paneProps.onApprove).toHaveBeenCalledTimes(1)
    expect(paneProps.onCancel).toHaveBeenCalledTimes(1)
    // No abort during pre-flight — Cancel is the way out.
    expect(screen.queryByText('Abort')).toBeNull()
  })

  it('caps the displayed worst case at the budget and names unpriced models', () => {
    const v = view([{ type: 'hitl_pause', agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} }])
    render(<MultiAgentPlanPane {...paneProps} view={v} estimate={{ minUsd: 0.2, maxUsd: 3, unpricedModels: ['x/free'] }} />)
    expect(screen.getByText(/Worst case \$0\.50/)).toBeTruthy()
    expect(screen.getByText(/No published price for x\/free/)).toBeTruthy()
  })

  it('running: per-step status (paused pulses), abort, live totals and the budget badge', () => {
    const v = view([
      { type: 'hitl_resume', agentId: 'orchestrator', approved: true },
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'm' },
      { type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'm' },
      { type: 'hitl_pause', agentId: '1.2', role: 'Analyzer', serverName: 'fs', toolName: 'read', args: {}, runTotals: { costUsd: 0.51, tokens: 1234, budgetReached: true } },
    ])
    render(<MultiAgentPlanPane {...paneProps} view={v} />)
    expect(screen.getByTestId('plan-step-1.1').dataset.status).toBe('running')
    expect(screen.getByTestId('plan-step-1.2').dataset.status).toBe('paused')
    expect(screen.getByTestId('plan-step-1.2').className).toContain('animate-pulse')
    expect(screen.getByText(/Total: \$0\.51 · 1,234 tok/)).toBeTruthy()
    expect(screen.getByText('Budget cap reached')).toBeTruthy()
    fireEvent.click(screen.getByText('Abort'))
    expect(paneProps.onAbort).toHaveBeenCalled()
  })

  it('collapses to a 40px dot rail (never zero) that can select an agent or re-expand', () => {
    const v = view([{ type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' }])
    render(<MultiAgentPlanPane {...paneProps} view={v} collapsed />)
    const pane = screen.getByTestId('plan-pane')
    expect(pane.style.width).toBe('40px')
    fireEvent.click(screen.getByTitle(/1\.1 · Research the market — running/))
    expect(paneProps.onSelectAgent).toHaveBeenCalledWith('1.1')
    fireEvent.click(screen.getByTitle('Show orchestrator plan'))
    expect(paneProps.onToggleCollapsed).toHaveBeenCalled()
  })

  it('expands a step to show its reflection history', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm' },
      { type: 'agent_complete', agentId: '1.1', output: 'x', tokenCount: 10, costUsd: 0.001 },
      { type: 'reflection_result', agentId: '1.1', score: 2, passed: false, reason: 'too shallow' },
    ])
    render(<MultiAgentPlanPane {...paneProps} view={v} />)
    fireEvent.click(within(screen.getByTestId('plan-step-1.1')).getByTitle('Expand'))
    expect(screen.getByText(/Reflection 2\/5 · failed — too shallow/)).toBeTruthy()
  })
})

describe('MultiAgentExecutionArea', () => {
  const areaProps = { readOnly: false, permissionRequests: [], onRespondPermission: vi.fn(), focusAgentId: null, onSelectAgent: vi.fn(), onBack: vi.fn() }

  it('renders one card per agent with status badge and a live token counter while streaming', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'm' },
      { type: 'agent_token', agentId: '1.1', token: 'Searching ' },
      { type: 'agent_token', agentId: '1.1', token: 'MU…' },
    ])
    render(<MultiAgentExecutionArea {...areaProps} view={v} />)
    const card = screen.getByTestId('agent-card-1.1')
    expect(within(card).getByText('Live')).toBeTruthy()
    expect(within(card).getByText('~2 tok')).toBeTruthy()
    expect(within(card).getByText('Searching MU…')).toBeTruthy()
    expect(within(screen.getByTestId('agent-card-1.2')).getByText('Queued')).toBeTruthy()
    expect(screen.queryByText('Back to chat')).toBeNull() // no leaving mid-run
  })

  it('collapses completed agents to a summary with exact usage, expandable, with the reflection gate', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.1', role: 'Researcher', model: 'm' },
      { type: 'agent_complete', agentId: '1.1', output: 'MU rose **14%** on HBM demand.', tokenCount: 1200, costUsd: 0.0042 },
      { type: 'reflection_result', agentId: '1.1', score: 4, passed: true, reason: 'well sourced' },
    ])
    render(<MultiAgentExecutionArea {...areaProps} view={v} />)
    const card = screen.getByTestId('agent-card-1.1')
    expect(within(card).getByText('Pass')).toBeTruthy()
    expect(within(card).getByText('1,200 tok · $0.0042')).toBeTruthy()
    expect(within(card).getByText('MU rose 14% on HBM demand.')).toBeTruthy()
    expect(within(card).getByTestId('reflection-gate').textContent).toContain('4/5 passed — well sourced')
    fireEvent.click(within(card).getByText('MU rose 14% on HBM demand.'))
    expect(within(card).getByText('Collapse')).toBeTruthy()
  })

  it('renders an agent\'s approval request inline in its card, with agent identity', () => {
    const v = view([
      { type: 'agent_start', agentId: '1.2', role: 'Analyzer', model: 'm' },
      { type: 'hitl_pause', agentId: '1.2', role: 'Analyzer', serverName: 'fs', toolName: 'read_file', args: { path: '/x' } },
    ])
    const request: McpToolPermissionRequest = {
      serverName: 'fs', toolName: 'read_file', args: { path: '/x' }, requestId: 'q1', chatId: 'c',
      agent: { runId: 'run-1', agentId: '1.2', role: 'Analyzer', model: 'anthropic/claude-3.5-sonnet' }, timeoutMs: 300_000,
    }
    render(<MultiAgentExecutionArea {...areaProps} view={v} permissionRequests={[request]} />)
    const card = screen.getByTestId('agent-card-1.2')
    expect(within(card).getByText('Analyzer Agent needs approval')).toBeTruthy()
    expect(within(card).getByText(/Analyzer Agent \(anthropic\/claude-3\.5-sonnet\) is requesting access to read_file/)).toBeTruthy()
    fireEvent.click(within(card).getByText('Allow all from this agent'))
    expect(areaProps.onRespondPermission).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'q1', approved: true, agentTrust: 'trust' }))
  })

  it('synthesis: provenance tags are clickable chips that select the source agent (D3); Back to chat when done', () => {
    const v = view([
      { type: 'synthesis_start' },
      { type: 'task_complete', finalOutput: 'MU rose [1.1]; the code is ready [1.2].', totalCostUsd: 0.018, totalTokens: 12_400 },
    ])
    render(<MultiAgentExecutionArea {...areaProps} view={v} />)
    const synthesis = screen.getByTestId('synthesis')
    const chip = within(synthesis).getByText('1.1')
    expect(chip.closest('a')?.getAttribute('href')).toBe('#agent-1.1')
    fireEvent.click(chip)
    expect(areaProps.onSelectAgent).toHaveBeenCalledWith('1.1')
    expect(within(synthesis).getByText(/\$0\.02 total · 12,400 tokens/)).toBeTruthy()
    fireEvent.click(screen.getByText('Back to chat'))
    expect(areaProps.onBack).toHaveBeenCalled()
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
  it('filters the OpenRouter catalogue, shows prices per 1M, and saves clamped settings', async () => {
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
    const worker = screen.getByText('Worker agents model').querySelector('select')!
    expect(within(worker).getByText('meta-llama/llama-3.3-70b-instruct — $0.130 / $0.400 per 1M · 131k ctx')).toBeTruthy()
    expect(within(worker).queryByText(/tiny\/no-tools/)).toBeNull()

    fireEvent.click(screen.getByText('Requires tool-call support'))
    fireEvent.change(screen.getByText('Min context').querySelector('select')!, { target: { value: '0' } })
    expect(within(worker).getByText(/tiny\/no-tools/)).toBeTruthy()

    fireEvent.change(worker, { target: { value: 'tiny/no-tools' } })
    fireEvent.click(screen.getByText('Save multi-agent defaults'))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      models: expect.objectContaining({ worker: 'tiny/no-tools' }), maxAgents: 4, sidecarPort: 7823,
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
    fireEvent.change(screen.getByText('Worker agents model').querySelector('select')!, { target: { value: 'meta-llama/llama-3.3-70b-instruct' } })
    expect(screen.getByTestId('run-model-worker').textContent).toBe('Worker agentsmeta-llama/llama-3.3-70b-instructsaved')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })
})
