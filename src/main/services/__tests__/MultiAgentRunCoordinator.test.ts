import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-coordinator-test' } }))

import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import type { CoordinatorDeps } from '../MultiAgentRunCoordinator'
import { McpDeniedError } from '../McpServerManager'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent, MultiAgentConfig } from '../../../shared/types'
import type { OpenRouterModelInfo } from '../../../shared/multiAgentModels'

const model = (id: string, prompt = 1e-6, completion = 2e-6): OpenRouterModelInfo => ({
  id, name: id, contextLength: 128_000, promptPrice: prompt, completionPrice: completion, supportsTools: true,
})

class FakeSidecar extends EventEmitter {
  runId = 'run-1'
  awaitingPlan = false
  startRun = vi.fn(async (req: { chatId: string }) => {
    this.emit('runStarted', { runId: this.runId, chatId: req.chatId })
    return { ok: true as const, runId: this.runId }
  })
  respondHitl = vi.fn(async () => {})
  abortRun = vi.fn(async () => {})
  isAwaitingPlanApproval = vi.fn(() => this.awaitingPlan)
  push(event: Partial<AgentEvent> & { type: string; seq: number }): void {
    this.emit('event', { runId: this.runId, ts: 1, ...event })
  }
}

function setup(over: { settings?: Partial<ReturnType<CoordinatorDeps['settings']>>; catalogue?: OpenRouterModelInfo[] | Error } = {}) {
  const sidecar = new FakeSidecar()
  const mcp = {
    getToolSchemas: vi.fn(() => [{ type: 'function' as const, function: { name: 'fs__read', description: 'read', parameters: { type: 'object', properties: {}, required: [] } } }]),
    callToolForMultiAgent: vi.fn(async () => ({ text: 'tool-output', images: [], userNote: '' })),
    clearRunTrust: vi.fn(),
    cancelRunPermissions: vi.fn(),
  } satisfies Record<keyof CoordinatorDeps['mcp'], unknown>
  const db = {
    begin: vi.fn(),
    saveTrace: vi.fn(),
    saveAssistantMessage: vi.fn(),
    getRun: vi.fn(() => null),
  }
  const sent: AgentEvent[] = []
  const observed: AgentEvent[] = []
  const catalogue = over.catalogue ?? [model('meta-llama/llama-3.3-70b-instruct'), model('active/model', 3e-6, 4e-6)]
  const coordinator = new MultiAgentRunCoordinator({
    sidecar,
    mcp: mcp as unknown as CoordinatorDeps['mcp'],
    sendEvent: (e) => sent.push(e),
    db,
    observe: (_chat, e) => observed.push(e),
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-1', openRouterModel: 'active/model', ...over.settings }),
    catalogue: async () => {
      if (catalogue instanceof Error) throw catalogue
      return catalogue
    },
    flushDelayMs: 5,
  })
  return { coordinator, sidecar, mcp, db, sent, observed }
}

const config = (models: Partial<MultiAgentConfig['models']> = {}): MultiAgentConfig => ({
  ...DEFAULT_MULTI_AGENT_CONFIG,
  models: { ...DEFAULT_MULTI_AGENT_CONFIG.models, ...models },
})

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

describe('MultiAgentRunCoordinator.start', () => {
  it('refuses non-OpenRouter backends and missing keys (spec D10)', async () => {
    const lm = setup({ settings: { backendProvider: 'lmstudio' } })
    expect(await lm.coordinator.start({ chatId: 'c', task: 't', config: config() })).toEqual({ ok: false, reason: expect.stringMatching(/OpenRouter backend/) })
    const nokey = setup({ settings: { openRouterApiKey: '' } })
    expect(await nokey.coordinator.start({ chatId: 'c', task: 't', config: config() })).toEqual({ ok: false, reason: expect.stringMatching(/API key/) })
    expect(lm.sidecar.startRun).not.toHaveBeenCalled()
  })

  it('resolves empty and unknown role models to the active model, supplies pricing and tools, returns the resolved config', async () => {
    const { coordinator, sidecar, db } = setup()
    const result = await coordinator.start({ chatId: 'chat-1', task: 'do it', config: config({ worker: '', synthesizer: 'retired/model' }) })
    const sent = sidecar.startRun.mock.calls[0][0] as unknown as {
      config: MultiAgentConfig; pricing: Record<string, unknown>; tools: Array<{ name: string }>; openRouterApiKey: string
    }
    expect(sent.config.models).toEqual({
      orchestrator: 'meta-llama/llama-3.3-70b-instruct',
      worker: 'active/model',
      reflection: 'meta-llama/llama-3.3-70b-instruct',
      synthesizer: 'active/model',
    })
    expect(sent.pricing).toEqual({
      'meta-llama/llama-3.3-70b-instruct': { prompt: 1e-6, completion: 2e-6, contextLength: 128000 },
      'active/model': { prompt: 3e-6, completion: 4e-6, contextLength: 128000 },
    })
    expect(sent.tools).toEqual([expect.objectContaining({ name: 'fs__read' })])
    expect(sent.openRouterApiKey).toBe('sk-or-1')
    expect(result).toEqual({ ok: true, runId: 'run-1', config: sent.config })
    expect(db.begin).toHaveBeenCalledWith('chat-1')
  })

  it('Test C: four distinct configured role models are sent and returned as resolved', async () => {
    const ids = ['a/orch', 'b/work', 'c/refl', 'd/synth']
    const { coordinator, sidecar } = setup({ catalogue: ids.map((id) => model(id)) })
    const models = { orchestrator: ids[0], worker: ids[1], reflection: ids[2], synthesizer: ids[3] }
    const result = await coordinator.start({ chatId: 'c', task: 't', config: config(models) })
    expect((sidecar.startRun.mock.calls[0][0] as unknown as { config: MultiAgentConfig }).config.models).toEqual(models)
    expect(result).toMatchObject({ ok: true, config: { models } })
  })

  it('Test D: a configured model missing from the catalogue silently falls back to the active model (baseline)', async () => {
    const { coordinator } = setup()
    const result = await coordinator.start({ chatId: 'c', task: 't', config: config({ orchestrator: 'gone/model' }) })
    expect(result).toMatchObject({ ok: true, config: { models: { orchestrator: 'active/model' } } })
  })

  it('still starts (ids as configured, no pricing) when the catalogue is unreachable', async () => {
    const { coordinator, sidecar } = setup({ catalogue: new Error('offline') })
    await coordinator.start({ chatId: 'c', task: 't', config: config({ worker: 'x/y' }) })
    const sent = sidecar.startRun.mock.calls[0][0] as unknown as { config: MultiAgentConfig; pricing: object }
    expect(sent.config.models.worker).toBe('x/y')
    expect(sent.pricing).toEqual({})
  })

  it('rejects a second concurrent run in the same chat', async () => {
    const { coordinator } = setup()
    await coordinator.start({ chatId: 'c', task: 't', config: config() })
    expect(await coordinator.start({ chatId: 'c', task: 't2', config: config() })).toEqual({ ok: false, reason: expect.stringMatching(/already in progress/) })
  })
})

describe('MultiAgentRunCoordinator events', () => {
  let h: ReturnType<typeof setup>
  beforeEach(async () => {
    h = setup()
    await h.coordinator.start({ chatId: 'chat-1', task: 'do it', config: { ...config(), requirePermissions: false, hitlTimeoutMs: 42_000 } })
  })

  it('forwards every event (tokens included) to the renderer', () => {
    h.sidecar.push({ type: 'agent_token', seq: 1, agentId: '1.1', token: 'a' } as never)
    h.sidecar.push({ type: 'agent_start', seq: 2, agentId: '1.1', role: 'R', model: 'm' } as never)
    expect(h.sent.map((e) => e.type)).toEqual(['agent_token', 'agent_start'])
  })

  it('executes a worker tool pause in main with the agent context and returns the result to the sidecar', async () => {
    h.sidecar.push({ type: 'hitl_pause', seq: 1, agentId: '1.2', role: 'Analyzer', model: 'w/m', serverName: 'fs', toolName: 'read', args: { p: 1 } } as never)
    await tick()
    expect(h.mcp.callToolForMultiAgent).toHaveBeenCalledWith('fs', 'read', { p: 1 }, {
      chatId: 'chat-1', runId: 'run-1', agentId: '1.2', role: 'Analyzer', model: 'w/m', requirePermissions: false, hitlTimeoutMs: 42_000,
    })
    expect(h.sidecar.respondHitl).toHaveBeenCalledWith({ runId: 'run-1', agentId: '1.2', approved: true, result: 'tool-output' })
  })

  it('reports a denial (with the user note) and tool errors back as not approved', async () => {
    h.mcp.callToolForMultiAgent.mockRejectedValueOnce(new McpDeniedError('not that file'))
    h.sidecar.push({ type: 'hitl_pause', seq: 1, agentId: '1.1', role: 'R', serverName: 'fs', toolName: 'read', args: {} } as never)
    await tick()
    expect(h.sidecar.respondHitl).toHaveBeenLastCalledWith(expect.objectContaining({ approved: false, result: 'not that file' }))
    h.mcp.callToolForMultiAgent.mockRejectedValueOnce(new Error('server crashed'))
    h.sidecar.push({ type: 'hitl_pause', seq: 2, agentId: '1.1', role: 'R', serverName: 'fs', toolName: 'read', args: {} } as never)
    await tick()
    expect(h.sidecar.respondHitl).toHaveBeenLastCalledWith(expect.objectContaining({ approved: false, result: 'server crashed' }))
  })

  it('never proxies the plan-approval pause as a tool call', async () => {
    h.sidecar.push({ type: 'hitl_pause', seq: 1, agentId: 'orchestrator', role: 'O', serverName: 'multi-agent', toolName: 'approve_plan', args: {} } as never)
    await tick()
    expect(h.mcp.callToolForMultiAgent).not.toHaveBeenCalled()
  })

  it('persists a coalesced trace: consecutive tokens become one event with the full text', async () => {
    h.sidecar.push({ type: 'agent_start', seq: 1, agentId: '1.1', role: 'R', model: 'm' } as never)
    h.sidecar.push({ type: 'agent_token', seq: 2, agentId: '1.1', token: 'Hel' } as never)
    h.sidecar.push({ type: 'agent_token', seq: 3, agentId: '1.1', token: 'lo' } as never)
    h.sidecar.push({ type: 'agent_complete', seq: 4, agentId: '1.1', output: 'Hello', tokenCount: 3, costUsd: 0 } as never)
    await tick(20)
    const trace = h.db.saveTrace.mock.calls.at(-1)![1] as AgentEvent[]
    expect(trace.map((e) => [e.type, e.seq])).toEqual([['agent_start', 1], ['agent_token', 2], ['agent_complete', 4]])
    expect(trace[1]).toMatchObject({ token: 'Hello' })
    expect(h.observed.map((e) => e.type)).toEqual(['agent_start', 'agent_token', 'agent_complete'])
  })

  it('coalesces reasoning and tokens per agent and attempt, one stored event per 250 ms window', async () => {
    h.sidecar.push({ type: 'agent_reasoning', seq: 1, ts: 1_000, agentId: '1.1', attempt: 0, token: 'Think ' } as never)
    h.sidecar.push({ type: 'agent_reasoning', seq: 2, ts: 1_100, agentId: '1.1', attempt: 0, token: 'more' } as never)
    h.sidecar.push({ type: 'agent_reasoning', seq: 3, ts: 1_300, agentId: '1.1', attempt: 0, token: ' later' } as never) // new window
    h.sidecar.push({ type: 'agent_token', seq: 4, ts: 1_310, agentId: '1.1', attempt: 0, token: 'A' } as never)
    h.sidecar.push({ type: 'agent_token', seq: 5, ts: 1_320, agentId: '1.1', attempt: 1, token: 'B' } as never) // other attempt
    h.sidecar.push({ type: 'agent_token', seq: 6, ts: 1_330, agentId: '1.1', attempt: 0, token: 'C' } as never)
    h.sidecar.push({ type: 'agent_complete', seq: 7, ts: 1_400, agentId: '1.1', output: 'AC', tokenCount: 2, costUsd: 0 } as never)
    await tick(20)
    const trace = h.db.saveTrace.mock.calls.at(-1)![1] as AgentEvent[]
    expect(trace.map((e) => [e.type, e.seq, (e as { token?: string }).token])).toEqual([
      ['agent_reasoning', 1, 'Think more'],
      ['agent_reasoning', 3, ' later'],
      ['agent_token', 4, 'AC'],
      ['agent_token', 5, 'B'],
      ['agent_complete', 7, undefined],
    ])
    expect(h.sent).toHaveLength(7) // the renderer still sees every event live
  })

  it('tells the sidecar which models the catalogue says take no reasoning parameter', async () => {
    const plain = { ...model('plain/model'), supportsReasoning: false }
    const thinker = { ...model('think/model'), supportsReasoning: true }
    const { coordinator, sidecar } = setup({ catalogue: [plain, thinker, model('active/model')] })
    await coordinator.start({ chatId: 'c', task: 't', config: config({ orchestrator: 'plain/model', worker: 'think/model', reflection: 'plain/model', synthesizer: 'think/model' }) })
    expect((sidecar.startRun.mock.calls[0][0] as unknown as { noReasoning: string[] }).noReasoning).toEqual(['plain/model'])
  })

  it('does not write the DB per token (debounced), but writes pauses immediately', async () => {
    for (let i = 1; i <= 50; i++) h.sidecar.push({ type: 'agent_token', seq: i, agentId: '1.1', token: 'x' } as never)
    expect(h.db.saveTrace).not.toHaveBeenCalled()
    h.sidecar.push({ type: 'hitl_pause', seq: 51, agentId: '1.1', role: 'R', serverName: 'fs', toolName: 'read', args: {} } as never)
    expect(h.db.saveTrace).toHaveBeenCalledTimes(1)
    expect(h.db.saveTrace.mock.calls[0][2]).toBe('paused_hitl')
  })

  it('on completion: saves the final answer, flushes the trace, cancels pending approvals and drops agent trust', () => {
    h.sidecar.push({ type: 'task_complete', seq: 1, finalOutput: 'The answer [1.1]', totalCostUsd: 0.01, totalTokens: 10 } as never)
    expect(h.db.saveAssistantMessage).toHaveBeenCalledWith('chat-1', expect.any(String), 'The answer [1.1]')
    expect(h.db.saveTrace).toHaveBeenLastCalledWith('chat-1', expect.any(Array), 'completed', undefined)
    expect(h.mcp.cancelRunPermissions).toHaveBeenCalledWith('run-1')
    expect(h.mcp.clearRunTrust).toHaveBeenCalledWith('run-1')
    // The run is finished: later events are ignored.
    h.sidecar.push({ type: 'agent_token', seq: 2, agentId: '1.1', token: 'late' } as never)
    expect(h.sent.at(-1)?.type).toBe('task_complete')
  })

  it('on failure: saves the reason plus any partial agent outputs', () => {
    h.sidecar.push({ type: 'agent_complete', seq: 1, agentId: '1.1', output: 'Partial A', tokenCount: 1, costUsd: 0 } as never)
    h.sidecar.push({ type: 'task_failed', seq: 2, reason: 'Run aborted by user' } as never)
    const message = h.db.saveAssistantMessage.mock.calls[0][2] as string
    expect(message).toContain('Multi-agent run failed:** Run aborted by user')
    expect(message).toContain('[1.1]** Partial A')
    expect(h.db.saveTrace).toHaveBeenLastCalledWith('chat-1', expect.any(Array), 'failed', undefined)
  })

  it('answers the plan only while the sidecar is waiting for it — and never with a tool result', async () => {
    await expect(h.coordinator.respondToPlan('run-1', true)).rejects.toThrow(/not waiting/)
    h.sidecar.awaitingPlan = true
    await h.coordinator.respondToPlan('run-1', true)
    expect(h.sidecar.respondHitl).toHaveBeenCalledWith({ runId: 'run-1', agentId: 'orchestrator', approved: true })
  })

  it('serves the live run (with pending tokens) from memory and past runs from the DB', () => {
    h.sidecar.push({ type: 'orchestrator_plan', seq: 1, steps: [{ id: '1.1', label: 'x', stage: 'worker', role: 'R', model: 'm', phase: 1 }] } as never)
    h.sidecar.push({ type: 'agent_token', seq: 2, agentId: '1.1', token: 'live' } as never)
    const live = h.coordinator.getRun('chat-1')!
    expect(live.runStatus).toBe('running')
    expect(live.agentGraph).toHaveLength(1)
    expect(live.executionTrace.map((e) => e.type)).toEqual(['orchestrator_plan', 'agent_token'])
    h.coordinator.getRun('other-chat')
    expect(h.db.getRun).toHaveBeenCalledWith('other-chat')
  })
})
