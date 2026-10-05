/**
 * Top bar for multi-agent chats (designs/05-topbar.html): single chats keep
 * today's bar; agent chats get the black bar with the mode pill, its hover
 * card (graph + models table) and the chat actions at the far right.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'

vi.mock('@preact/signals-react/runtime', () => ({ useSignals: () => {} }))

import { TopBar } from '../../renderer/src/components/layout/TopBar'
import { pillSummary, modelRows, type TopBarRun } from '../../renderer/src/components/layout/MultiAgentModeIndicator'
import { ModelStoreProvider, useModelStore } from '../../renderer/src/store/ModelStore'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent, AgentStep, ChatMode } from '../../shared/types'

const W = 'deepseek/deepseek-v4.1-flash'
const ORCH = 'meta-llama/llama-3.3-70b-instruct'
const REFLECT = 'google/gemini-3.5-flash-lite'
const SYNTH = 'z-ai/glm-5.3-flash'
const STEPS: AgentStep[] = [
  { id: '1.1', label: 'Flights from SIN', stage: 'worker', role: 'Scout', model: W, phase: 1, dependsOn: [] },
  { id: '1.2', label: 'Visa and entry', stage: 'worker', role: 'Scout', model: W, phase: 1, dependsOn: [] },
  { id: '1.3', label: 'Weather in December', stage: 'worker', role: 'Scout', model: W, phase: 1, dependsOn: [] },
  { id: '2.1', label: 'Day-by-day itinerary', stage: 'worker', role: 'Planner', model: W, phase: 2, dependsOn: ['1.1', '1.2', '1.3'] },
]

/** Builds a trace; `ev` stamps runId/seq/ts. */
function trace(build: (ev: (type: string, body?: Record<string, unknown>) => void) => void): AgentEvent[] {
  const events: AgentEvent[] = []
  let seq = 0
  build((type, body = {}) => events.push({ runId: 'r2', seq: ++seq, ts: 1_000 + seq * 100, type, ...body } as AgentEvent))
  return events
}
const planned = (ev: (type: string, body?: Record<string, unknown>) => void): void => {
  ev('orchestrator_plan', { steps: STEPS })
  ev('run_config', {
    models: { orchestrator: ORCH, worker: W, reflection: REFLECT, synthesizer: SYNTH },
    sources: { orchestrator: 'default', worker: 'active', reflection: 'saved', synthesizer: 'saved' },
    catalogueChecked: true, maxAgents: 4, budgetCapUsd: 0.5, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium',
  })
  ev('hitl_resume', { agentId: 'orchestrator', approved: true })
}
const passed = (ev: (type: string, body?: Record<string, unknown>) => void, id: string, extra: Record<string, unknown> = {}): void => {
  ev('agent_start', { agentId: id, role: 'Scout', model: W, attempt: 0 })
  ev('agent_complete', { agentId: id, attempt: 0, output: 'ok', tokenCount: 10, costUsd: 0.001, ...extra })
  ev('reflection_result', { agentId: id, attempt: 0, score: 5, passed: true, reason: 'solid', model: REFLECT })
}

const LIVE = trace((ev) => {
  planned(ev)
  passed(ev, '1.1')
  ev('agent_start', { agentId: '1.2', role: 'Scout', model: W, attempt: 0 })
  ev('tool_start', { agentId: '1.2', attempt: 0, callId: 'c1', tool: 'web_search', server: 'brave', argsPreview: '{}' })
  ev('agent_start', { agentId: '1.3', role: 'Scout', model: W, attempt: 0, runTotals: { costUsd: 0.02, tokens: 1200, budgetReached: false } })
  ev('reflection_start', { agentId: '1.3', attempt: 0 })
})
const FINISHED = trace((ev) => {
  planned(ev)
  for (const s of STEPS) passed(ev, s.id)
  ev('synthesis_start')
  ev('task_complete', { finalOutput: 'Done [1.1]', totalCostUsd: 0.07, totalTokens: 365_900 })
})

const runOf = (events: AgentEvent[], live = false, extra: Partial<TopBarRun> = {}): TopBarRun =>
  ({ view: reduceRunEvents('r2', events), runIds: ['r1', 'r2'], live, ...extra })

// ── window.api ───────────────────────────────────────────────────────────────

const api = {
  getBackendSettings: vi.fn(async () => ({ provider: 'lmstudio', openrouterModel: W })),
  getModelConfig: vi.fn(async () => ({ contextLength: 32768 })),
  isFullscreen: vi.fn(async () => false),
  exportChatPdf: vi.fn(async () => ({ success: true })),
  getMultiAgentConfig: vi.fn(async () => ({ ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: '', worker: '', reflection: REFLECT, synthesizer: SYNTH } })),
  getMultiAgentCatalogue: vi.fn(async () => ({ models: [], error: null })),
  getMultiAgentSidecarStatus: vi.fn(async () => 'running'),
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).api = new Proxy(api, {
    get: (target, key) =>
      key in target ? (target as any)[key]
        : typeof key === 'string' && key.startsWith('on') ? () => () => {}
        : async () => undefined,
  })
})

function SelectModel({ id }: { id: string }) {
  const { setSelectedModel } = useModelStore()
  useEffect(() => { setSelectedModel(id) }, [id, setSelectedModel])
  return null
}

function renderBar(props: { mode: ChatMode; run?: TopBarRun | null; activeChatId?: string | null; dockOpen?: boolean }) {
  const handlers = { onToggleAgentDock: vi.fn(), onOpenAgentRunView: vi.fn(), onOpenAgentSettings: vi.fn(), onUpdateChatSystemInstructions: vi.fn() }
  const utils = render(
    <ModelStoreProvider>
      <SelectModel id="qwen/qwen3.5-35b-a3b" />
      <TopBar
        activeChatId={props.activeChatId === undefined ? 'chat-1' : props.activeChatId}
        onCompactComplete={() => {}}
        onSidebarToggle={() => {}}
        chatSystemInstructions={null}
        onUpdateChatSystemInstructions={handlers.onUpdateChatSystemInstructions}
        mode={props.mode}
        agentRun={props.run ?? null}
        agentDockOpen={props.dockOpen ?? false}
        onToggleAgentDock={handlers.onToggleAgentDock}
        onOpenAgentRunView={handlers.onOpenAgentRunView}
        onOpenAgentSettings={handlers.onOpenAgentSettings}
      />
    </ModelStoreProvider>
  )
  return { ...utils, ...handlers }
}

// ── Mode switch ──────────────────────────────────────────────────────────────

describe('TopBar mode switch', () => {
  it('a single chat renders today\'s bar: model name, context meter, Compact and Reload, no pill', async () => {
    renderBar({ mode: 'single' })
    const bar = screen.getByTestId('top-bar')
    expect(bar.dataset.mode).toBe('single')
    expect(bar.className).not.toContain('bg-black')
    expect(await screen.findByText('qwen/qwen3.5-35b-a3b')).toBeTruthy()
    expect(screen.getByTestId('context-meter')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Compact' })).toBeTruthy()
    expect(screen.getByTitle('Reload model (clears memory)')).toBeTruthy()
    expect(screen.queryByTestId('mode-pill')).toBeNull()
  })

  it('a multi-agent chat renders the black bar with the pill and no model name, meter, Compact or Reload', async () => {
    renderBar({ mode: 'multi-agent' })
    const bar = screen.getByTestId('top-bar')
    expect(bar.dataset.mode).toBe('multi-agent')
    expect(bar.className).toContain('bg-black')
    expect(bar.className).toContain('h-[52px]')
    expect(screen.getByTestId('mode-pill').textContent).toContain('Multi-agent')
    await waitFor(() => expect(api.getBackendSettings).toHaveBeenCalled())
    expect(screen.queryByText('qwen/qwen3.5-35b-a3b')).toBeNull()
    expect(screen.queryByTestId('context-meter')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull()
    expect(screen.queryByTitle('Reload model (clears memory)')).toBeNull()
  })

  it('still seeds the context total from the model config in multi-agent mode (harmless: the meter is just not drawn)', async () => {
    renderBar({ mode: 'multi-agent' })
    await waitFor(() => expect(api.getModelConfig).toHaveBeenCalledTimes(1))
  })

  it('keeps the fullscreen / traffic-light padding logic', () => {
    renderBar({ mode: 'multi-agent' })
    expect(screen.getByTestId('top-bar').className).toContain('px-8')
  })
})

// ── Pill ─────────────────────────────────────────────────────────────────────

describe('mode pill', () => {
  it('no run yet: dim outline, plain label', () => {
    renderBar({ mode: 'multi-agent' })
    const pill = screen.getByTestId('mode-pill')
    expect(pill.dataset.tone).toBe('idle')
    expect(screen.queryByTestId('mode-pill-sub')).toBeNull()
  })

  it('run live: glowing tone, red dot and "2 of 4 working" from the run state', () => {
    renderBar({ mode: 'multi-agent', run: runOf(LIVE, true) })
    const pill = screen.getByTestId('mode-pill')
    expect(pill.dataset.tone).toBe('live')
    expect(pill.querySelector('.ma-mpill-dot')?.getAttribute('data-s')).toBe('run')
    expect(screen.getByTestId('mode-pill-sub').textContent).toContain('2 of 4 working')
  })

  it('run finished: green dot and "4 agents · 2 phases" from the graph', () => {
    renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
    const pill = screen.getByTestId('mode-pill')
    expect(pill.dataset.tone).toBe('done')
    expect(pill.querySelector('.ma-mpill-dot')?.getAttribute('data-s')).toBe('ok')
    expect(screen.getByTestId('mode-pill-sub').textContent).toContain('4 agents · 2 phases')
  })

  it('failed, stopped and budget runs get an honest label and no green dot', () => {
    const oneFailed = trace((ev) => {
      planned(ev)
      for (const s of STEPS.slice(0, 3)) passed(ev, s.id)
      ev('agent_start', { agentId: '2.1', role: 'Planner', model: W, attempt: 0 })
      ev('agent_failed', { agentId: '2.1', reason: 'repetition loop' })
      ev('task_complete', { finalOutput: 'partial', totalCostUsd: 0.05, totalTokens: 1000 })
    })
    const aborted = trace((ev) => { planned(ev); passed(ev, '1.1'); ev('task_failed', { reason: 'Run aborted by user' }) })
    const budget = trace((ev) => {
      planned(ev)
      for (const s of STEPS) passed(ev, s.id)
      ev('task_complete', { finalOutput: 'x', totalCostUsd: 0.5, totalTokens: 1000, runTotals: { costUsd: 0.5, tokens: 1000, budgetReached: true } })
    })
    expect(pillSummary(runOf(oneFailed))).toEqual({ tone: 'bad', sub: '1 failed' })
    expect(pillSummary(runOf(aborted))).toEqual({ tone: 'bad', sub: 'stopped' })
    expect(pillSummary(runOf(budget))).toEqual({ tone: 'bad', sub: 'budget reached' })
    renderBar({ mode: 'multi-agent', run: runOf(oneFailed) })
    expect(screen.getByTestId('mode-pill').querySelector('.ma-mpill-dot')?.getAttribute('data-s')).toBe('fail')
  })

  it('click and Enter toggle the dock like the "View agent run" pill', async () => {
    const user = userEvent.setup()
    const { onToggleAgentDock } = renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
    const pill = screen.getByTestId('mode-pill')
    await user.click(pill)
    expect(onToggleAgentDock).toHaveBeenCalledTimes(1)
    pill.focus()
    await user.keyboard('{Enter}')
    expect(onToggleAgentDock).toHaveBeenCalledTimes(2)
  })

  it('is a focusable button with aria-expanded reflecting the card', async () => {
    renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
    const pill = screen.getByRole('button', { name: /Multi-agent, 4 agents · 2 phases/ })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    act(() => pill.focus())
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    expect(pill.getAttribute('aria-controls')).toBe(screen.getByTestId('mode-card').id)
  })
})

// ── Hover card ───────────────────────────────────────────────────────────────

describe('hover card', () => {
  it('opens on hover, stays while the pointer moves into it, closes after leaving', async () => {
    vi.useFakeTimers()
    try {
      renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
      const wrapper = screen.getByTestId('mode-pill').parentElement!
      fireEvent.mouseEnter(wrapper)
      expect(screen.getByTestId('mode-card')).toBeTruthy()
      fireEvent.mouseLeave(wrapper)
      act(() => { vi.advanceTimersByTime(100) })
      fireEvent.mouseEnter(wrapper) // into the card (same wrapper) before the delay ends
      act(() => { vi.advanceTimersByTime(500) })
      expect(screen.getByTestId('mode-card')).toBeTruthy()
      fireEvent.mouseLeave(wrapper)
      act(() => { vi.advanceTimersByTime(200) })
      expect(screen.queryByTestId('mode-card')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens on keyboard focus, closes on Escape without the Escape reaching the dock, and on blur', () => {
    renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
    const pill = screen.getByTestId('mode-pill')
    act(() => pill.focus())
    expect(screen.getByTestId('mode-card')).toBeTruthy()
    const dockEscape = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    window.addEventListener('keydown', dockEscape)
    fireEvent.keyDown(pill, { key: 'Escape' })
    window.removeEventListener('keydown', dockEscape)
    expect(screen.queryByTestId('mode-card')).toBeNull()
    expect(dockEscape).toHaveReturnedWith(true)
    fireEvent.mouseEnter(pill.parentElement!)
    expect(screen.getByTestId('mode-card')).toBeTruthy()
    fireEvent.blur(pill, { relatedTarget: document.body })
    expect(screen.queryByTestId('mode-card')).toBeNull()
  })

  it('no graph yet: says so, explains, shows the next run\'s models with their source, and links to settings', async () => {
    const { onOpenAgentSettings } = renderBar({ mode: 'multi-agent' })
    act(() => screen.getByTestId('mode-pill').focus())
    const card = screen.getByTestId('mode-card')
    expect(within(card).getByTestId('mode-card-title').textContent).toContain('No agent graph yet')
    expect(card.textContent).toContain('The orchestrator plans the agents after your first message.')
    expect(screen.queryByTestId('agent-graph')).toBeNull()
    await waitFor(() => expect(card.textContent).toContain('sidecar running'))
    // Same rule as Settings → "Models the next run will use": blank follows the active model.
    await waitFor(() => expect(screen.getByTestId('card-model-reflection').textContent).toContain(`${REFLECT}saved`))
    expect(screen.getByTestId('card-model-worker').textContent).toContain(`${W}follows active`)
    expect(screen.getByTestId('card-model-orchestrator').textContent).toContain(`${W}follows active`)
    expect(screen.getByTestId('card-model-synthesizer').textContent).toContain(`${SYNTH}saved`)
    expect(screen.getByTestId('mode-card-footer').textContent).toContain('Change in Settings → Multi-Agent')
    fireEvent.click(within(card).getByRole('button', { name: 'Open settings' }))
    expect(onOpenAgentSettings).toHaveBeenCalledTimes(1)
  })

  it('live: title, phase, graph with node states, what each role has done, and cost against budget', () => {
    const { onOpenAgentRunView } = renderBar({ mode: 'multi-agent', run: runOf(LIVE, true) })
    act(() => screen.getByTestId('mode-pill').focus())
    expect(screen.getByTestId('mode-card-title').textContent).toContain('Run 2 of 2 · in progress')
    expect(screen.getByTestId('mode-card').textContent).toContain('Phase 1 of 2')
    expect(screen.getByTestId('graph-node-1.1').getAttribute('data-s')).toBe('ok')
    expect(screen.getByTestId('graph-node-1.2').getAttribute('data-s')).toBe('run')
    expect(screen.getByTestId('graph-node-1.2').querySelector('.ma-g-t')?.textContent).toMatch(/^Visa and.* · tool$/)
    expect(screen.getByTestId('graph-node-1.3').querySelector('.ma-g-t')?.textContent).toBe('Reflecting') // label does not fit beside it
    expect(screen.getByTestId('graph-node-2.1').getAttribute('data-s')).toBe('q')
    expect(screen.getByTestId('graph-synthesis').getAttribute('opacity')).toBe('0.5')
    expect(screen.getByTestId('card-model-orchestrator').textContent).toContain(`${ORCH}done`)
    expect(screen.getByTestId('card-model-worker').textContent).toContain(`${W}3 agents`)
    expect(screen.getByTestId('card-model-reflection').textContent).toContain(`${REFLECT}1 check`)
    expect(screen.getByTestId('card-model-synthesizer').textContent).toContain(`${SYNTH}waiting`)
    expect(screen.getByTestId('mode-card-footer').textContent).toContain('$0.02 of $0.50 budget')
    fireEvent.click(screen.getByRole('button', { name: 'Open run view' }))
    expect(onOpenAgentRunView).toHaveBeenCalledTimes(1)
  })

  it('finished: totals with tokens, every agent passed, real models from run_config', () => {
    renderBar({ mode: 'multi-agent', run: runOf(FINISHED) })
    act(() => screen.getByTestId('mode-pill').focus())
    expect(screen.getByTestId('mode-card-title').textContent).toContain('Run 2 of 2 · finished')
    expect(screen.getByTestId('mode-card').textContent).toContain('all agents passed')
    expect(screen.getByTestId('card-model-worker').textContent).toContain(`${W}4 agents`)
    expect(screen.getByTestId('card-model-reflection').textContent).toContain(`${REFLECT}4 checks`)
    expect(screen.getByTestId('card-model-synthesizer').textContent).toContain(`${SYNTH}done`)
    expect(screen.getByTestId('mode-card-footer').textContent).toContain('$0.07 · 365.9k tokens')
    expect(api.getMultiAgentConfig).not.toHaveBeenCalled() // run_config is the source once a run has started
  })

  it('a failed node is red with an error mark', () => {
    const events = trace((ev) => {
      planned(ev)
      ev('agent_start', { agentId: '1.1', role: 'Scout', model: W, attempt: 0 })
      ev('agent_failed', { agentId: '1.1', reason: 'Context window exceeded' })
    })
    renderBar({ mode: 'multi-agent', run: runOf(events, true) })
    act(() => screen.getByTestId('mode-pill').focus())
    const node = screen.getByTestId('graph-node-1.1')
    expect(node.getAttribute('data-s')).toBe('fail')
    expect(node.textContent).toContain('✕')
  })

  it('shows the saved model before a run and the real model after; a served mismatch shows the served model with an amber tag', async () => {
    const next = { orchestrator: { model: ORCH, source: 'default' as const }, worker: { model: W, source: 'active' as const },
      reflection: { model: 'saved/reviewer', source: 'saved' as const }, synthesizer: { model: SYNTH, source: 'saved' as const } }
    expect(modelRows(null, next).find((r) => r.role === 'reflection')).toMatchObject({ model: 'saved/reviewer', tag: 'saved', tone: 'ok' })
    expect(modelRows(runOf(FINISHED), next).find((r) => r.role === 'reflection')).toMatchObject({ model: REFLECT, tag: '4 checks', tone: 'plain' })

    const served = trace((ev) => {
      planned(ev)
      passed(ev, '1.1', { modelServed: 'other/fallback-model' })
      // A dated variant of the requested id is the same model: no tag.
      ev('task_complete', { finalOutput: 'x', totalCostUsd: 0.01, totalTokens: 10, modelServed: `${SYNTH}-20260101` })
    })
    renderBar({ mode: 'multi-agent', run: runOf(served) })
    act(() => screen.getByTestId('mode-pill').focus())
    const worker = screen.getByTestId('card-model-worker')
    expect(worker.textContent).toContain('other/fallback-modelserved')
    expect(worker.querySelector('.ma-src')?.getAttribute('data-tone')).toBe('amber')
    expect(worker.querySelector('.ma-src')?.getAttribute('title')).toBe(`Requested ${W}; OpenRouter served other/fallback-model`)
    expect(screen.getByTestId('card-model-synthesizer').textContent).toContain(`${SYNTH}done`)
  })

  it('a large graph (more than 8 agents) scales to the card width; the card caps its height and scrolls', () => {
    const many: AgentStep[] = Array.from({ length: 12 }, (_, i) => ({ id: `1.${i + 1}`, label: `Step ${i + 1}`, stage: 'worker', role: 'Scout', model: W, phase: 1 }))
    const events = trace((ev) => ev('orchestrator_plan', { steps: many }))
    renderBar({ mode: 'multi-agent', run: runOf(events, true) })
    act(() => screen.getByTestId('mode-pill').focus())
    const svg = screen.getByTestId('agent-graph')
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/)
    expect(svg.getAttribute('class')).toBe('ma-graph') // width:100%; height:auto in CSS
    expect(screen.getByTestId('mode-card').className).toBe('ma-pop') // max-height + overflow-y:auto in CSS
    expect(screen.getAllByTestId(/^graph-node-/)).toHaveLength(12)
  })
})

// ── Chat actions ─────────────────────────────────────────────────────────────

describe('chat actions in the multi-agent bar', () => {
  it('sit at the far right and keep working: instructions popup and PDF download', async () => {
    const { onUpdateChatSystemInstructions } = renderBar({ mode: 'multi-agent' })
    const right = screen.getByTestId('top-bar-actions')
    expect(screen.getByTestId('top-bar').lastElementChild).toBe(right)
    const instructions = within(right).getByTitle('Add instructions for this chat')
    const download = within(right).getByTitle('Download chat as PDF')

    fireEvent.click(download)
    await waitFor(() => expect(api.exportChatPdf).toHaveBeenCalledWith('chat-1'))

    fireEvent.click(instructions)
    const textarea = screen.getByPlaceholderText(/Add instructions for this chat only/)
    fireEvent.change(textarea, { target: { value: 'Be terse.' } })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onUpdateChatSystemInstructions).toHaveBeenCalledWith('Be terse.')
  })

  it('download keeps its disabled state with no chat', () => {
    renderBar({ mode: 'multi-agent', activeChatId: null })
    const download = within(screen.getByTestId('top-bar-actions')).getByTitle('Select a chat to export')
    expect((download as HTMLButtonElement).disabled).toBe(true)
  })
})
