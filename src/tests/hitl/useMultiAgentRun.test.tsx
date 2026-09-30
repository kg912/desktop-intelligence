import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useMultiAgentRun } from '../../renderer/src/hooks/useMultiAgentRun'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../shared/types'
import type { AgentEvent } from '../../shared/types'

let emit: (e: AgentEvent) => void = () => {}
const api = {
  onMultiAgentEvent: vi.fn((cb: (e: AgentEvent) => void) => { emit = cb; return () => {} }),
  getMultiAgentConfig: vi.fn(async () => ({ ...DEFAULT_MULTI_AGENT_CONFIG, sidecarPort: 7823 })),
  getMultiAgentCatalogue: vi.fn(async () => ({ models: [{ id: 'w', name: 'w', contextLength: 1, promptPrice: 1e-6, completionPrice: 2e-6, supportsTools: true }], error: null })),
  startMultiAgentRun: vi.fn(),
  respondMultiAgentPlan: vi.fn(async () => {}),
  abortMultiAgentRun: vi.fn(async () => {}),
  getMultiAgentRun: vi.fn(),
}

const e = (seq: number, body: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq, ts: seq, ...body }) as AgentEvent
const frame = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))) })

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as any).api = api
})

describe('useMultiAgentRun', () => {
  it('keeps events that arrive before the run id is known, and applies them once it is', async () => {
    let resolveStart!: (v: unknown) => void
    api.startMultiAgentRun.mockReturnValue(new Promise((r) => { resolveStart = r }))
    const onFinished = vi.fn()
    const { result } = renderHook(() => useMultiAgentRun(onFinished))
    let started!: Promise<boolean>
    act(() => { started = result.current.start('chat-1', 'task') })
    await waitFor(() => expect(api.startMultiAgentRun).toHaveBeenCalled())
    emit(e(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'x', stage: 'worker', role: 'R', model: 'w', phase: 1 }] }))
    await frame()
    resolveStart({ ok: true, runId: 'run-1', config: { ...DEFAULT_MULTI_AGENT_CONFIG, budgetCapUsd: 2 } })
    await act(async () => { expect(await started).toBe(true) })
    expect(result.current.run?.view.steps).toHaveLength(1)
    expect(result.current.run?.config.budgetCapUsd).toBe(2) // resolved config from main
    await waitFor(() => expect(result.current.pricing).toEqual({ w: { prompt: 1e-6, completion: 2e-6 } }))
  })

  it('batches a burst of tokens into one update per frame and reports completion once', async () => {
    api.startMultiAgentRun.mockResolvedValue({ ok: true, runId: 'run-1' })
    const onFinished = vi.fn()
    let renders = 0
    const { result } = renderHook(() => { renders++; return useMultiAgentRun(onFinished) })
    await act(async () => { await result.current.start('chat-1', 'task') })
    emit(e(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'x', stage: 'worker', role: 'R', model: 'w', phase: 1 }] }))
    emit(e(2, { type: 'agent_start', agentId: '1.1', role: 'R', model: 'w' }))
    for (let i = 3; i < 203; i++) emit(e(i, { type: 'agent_token', agentId: '1.1', token: 'x' }))
    const before = renders
    await frame()
    expect(renders - before).toBeLessThanOrEqual(2)
    expect(result.current.run?.view.agents['1.1'].liveText).toHaveLength(200)
    emit(e(203, { type: 'task_complete', finalOutput: 'done', totalCostUsd: 0, totalTokens: 0 }))
    await frame()
    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished).toHaveBeenCalledWith('chat-1')
  })

  it('surfaces a start failure and does not create a run', async () => {
    api.startMultiAgentRun.mockResolvedValue({ ok: false, reason: 'OpenRouter API key is not configured' })
    const { result } = renderHook(() => useMultiAgentRun(vi.fn()))
    await act(async () => { expect(await result.current.start('chat-1', 't')).toBe(false) })
    expect(result.current.startError).toBe('OpenRouter API key is not configured')
    expect(result.current.run).toBeNull()
  })

  it('answers the plan / aborts through the restricted bridge, and review mode is read-only', async () => {
    api.startMultiAgentRun.mockResolvedValue({ ok: true, runId: 'run-1' })
    const { result } = renderHook(() => useMultiAgentRun(vi.fn()))
    await act(async () => { await result.current.start('chat-1', 't') })
    act(() => result.current.approvePlan(true))
    act(() => result.current.abort())
    expect(api.respondMultiAgentPlan).toHaveBeenCalledWith('run-1', true)
    expect(api.abortMultiAgentRun).toHaveBeenCalledWith('run-1')

    api.getMultiAgentRun.mockResolvedValue({
      mode: 'multi-agent', runStatus: 'completed', agentGraph: [],
      executionTrace: [e(1, { type: 'task_complete', finalOutput: 'old', totalCostUsd: 0, totalTokens: 0 })],
    })
    await act(async () => { expect(await result.current.review('chat-9', 'old task')).toBe(true) })
    expect(result.current.run).toMatchObject({ chatId: 'chat-9', review: true })
    expect(result.current.run?.view.phase).toBe('complete')
    vi.clearAllMocks()
    act(() => { result.current.approvePlan(true); result.current.abort() })
    expect(api.respondMultiAgentPlan).not.toHaveBeenCalled()
    expect(api.abortMultiAgentRun).not.toHaveBeenCalled()
    act(() => result.current.dismiss())
    expect(result.current.run).toBeNull()
  })
})
