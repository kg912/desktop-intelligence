// maxToolRounds (multi-agent): the setting reaches the sidecar request, drives the
// estimate, and shows in run.md (config row + "stopped at tool limit" anomaly).
// The sidecar's own loop (forced wrap-up vs unlimited) is resources/python/test_tool_rounds.py.
import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-max-tool-rounds-test' } }))

import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import type { CoordinatorDeps } from '../MultiAgentRunCoordinator'
import { findAnomalies, renderRunMd, summarise } from '../MultiAgentRunLogger'
import type { RunLogMeta } from '../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent, AgentStep, MultiAgentConfig } from '../../../shared/types'
import { ESTIMATE, estimateRunCost, sanitizeMultiAgentConfig } from '../../../shared/multiAgentModels'

const MODELS = { orchestrator: 'm/plan', worker: 'm/work', reflection: 'm/judge', synthesizer: 'm/synth' }
const CONFIG: MultiAgentConfig = { ...DEFAULT_MULTI_AGENT_CONFIG, models: MODELS }

function coordinator() {
  const sidecar = Object.assign(new EventEmitter(), {
    startRun: vi.fn(async (req: { chatId: string }) => {
      sidecar.emit('runStarted', { runId: 'run-1', chatId: req.chatId })
      return { ok: true as const, runId: 'run-1' }
    }),
    respondHitl: vi.fn(), abortRun: vi.fn(), isAwaitingPlanApproval: vi.fn(() => false),
  })
  const c = new MultiAgentRunCoordinator({
    sidecar: sidecar as unknown as CoordinatorDeps['sidecar'],
    mcp: { getToolSchemasForMultiAgent: () => [], getMultiAgentExclusions: () => [], clearRunTrust: vi.fn(), cancelRunPermissions: vi.fn() } as unknown as CoordinatorDeps['mcp'],
    builtin: { getToolSchemas: () => [], call: vi.fn() },
    sendEvent: () => {},
    db: { begin: vi.fn(), saveTrace: vi.fn(), saveAssistantMessage: vi.fn(), getRun: () => null, claimMode: () => null },
    observe: () => {},
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-1', openRouterModel: 'm/work' }),
    catalogue: async () => [],
  })
  return { c, sidecar }
}

describe('maxToolRounds reaches the sidecar request', () => {
  it.each([5, null])('sends %s in the run start config', async (rounds) => {
    const { c, sidecar } = coordinator()
    await c.start({ chatId: `chat-${rounds}`, task: 't', config: { ...CONFIG, maxToolRounds: rounds } })
    expect((sidecar.startRun.mock.calls[0][0] as unknown as { config: MultiAgentConfig }).config.maxToolRounds).toBe(rounds)
  })
})

describe('maxToolRounds config and estimate', () => {
  it('defaults to 12, keeps null as unlimited, clamps to 1–50', () => {
    expect(DEFAULT_MULTI_AGENT_CONFIG.maxToolRounds).toBe(12)
    expect(sanitizeMultiAgentConfig({}).maxToolRounds).toBe(12)
    expect(sanitizeMultiAgentConfig({ maxToolRounds: null }).maxToolRounds).toBeNull()
    expect(sanitizeMultiAgentConfig({ maxToolRounds: 99 }).maxToolRounds).toBe(50)
    expect(sanitizeMultiAgentConfig({ maxToolRounds: 0 }).maxToolRounds).toBe(1)
  })

  const steps: AgentStep[] = [{ id: '1.1', label: 'Research', stage: 'worker', role: 'Researcher', model: 'm/work', phase: 1 }]
  const pricing = { 'm/work': { prompt: 1e-6, completion: 4e-6 }, 'm/judge': { prompt: 1e-7, completion: 1e-7 }, 'm/synth': { prompt: 2e-6, completion: 8e-6 } }
  const est = (maxToolRounds: number | null) => estimateRunCost({ task: 't', steps, config: { ...CONFIG, maxToolRounds }, pricing })

  it('worst case grows with the setting; best case does not depend on it', () => {
    expect(est(3).maxUsd).toBeLessThan(est(12).maxUsd)
    expect(est(12).maxUsd).toBeLessThan(est(50).maxUsd)
    expect(est(3).minUsd).toBe(est(50).minUsd)
    expect(est(12).nominal).toBe(false)
  })

  it('unlimited uses the fixed nominal figure and says so', () => {
    expect(est(null)).toEqual({ ...est(ESTIMATE.nominalToolRounds), nominal: true })
  })
})

describe('run.md: max tool rounds and the tool-limit anomaly', () => {
  const meta = (config: MultiAgentConfig): RunLogMeta => ({
    schema: 1, runId: 'run-1', chatId: 'chat-1', chatTitle: 'c', task: 't', startedAt: 1, endedAt: 2, status: 'completed', config,
  })
  const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'run-1', seq, ts: seq, ...e }) as unknown as AgentEvent
  const runConfig = (maxToolRounds: number | null) =>
    ev(1, { type: 'run_config', models: MODELS, sources: {}, catalogueChecked: true, maxAgents: 4, budgetCapUsd: 0.5, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, maxToolRounds, reasoningEffort: 'medium' })

  it.each([[7, '| Max tool rounds | 7 |'], [null, '| Max tool rounds | unlimited |']] as const)('config snapshot shows %s', (rounds, row) => {
    const events = [runConfig(rounds)]
    const m = meta({ ...CONFIG, maxToolRounds: rounds })
    expect(renderRunMd(m, events, [], summarise(m, events, []))).toContain(row)
  })

  it('flags an answer from the forced round as "stopped at tool limit"', () => {
    const events = [ev(2, { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'x', tokenCount: 1, costUsd: 0, stoppedAtToolLimit: true }),
      ev(3, { type: 'agent_complete', agentId: '1.2', attempt: 0, output: 'y', tokenCount: 1, costUsd: 0 })]
    const anomalies = findAnomalies(meta(CONFIG), events, [], 0, 0).filter((a) => a.kind === 'tool_limit')
    expect(anomalies).toEqual([{ kind: 'tool_limit', message: expect.stringContaining('agent 1.1 stopped at tool limit'), ref: 'agent-1.1.md' }])
  })
})
