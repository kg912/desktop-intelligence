/**
 * specs/search-selector.md §4 (main process): the run's web search provider is snapshot at start and carried on
 * run_config; each worker search's search_call record is summarised onto its tool_done; a change in Settings
 * mid-run changes neither the snapshot nor what the workers search with; no API key reaches an event.
 */
import { EventEmitter } from 'events'
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-search-snapshot-test' } }))

import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import type { BuiltinCallContext, CoordinatorDeps } from '../MultiAgentRunCoordinator'
import { DEFAULT_MULTI_AGENT_CONFIG, DEFAULT_SYNTHESIZER_MODEL } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'

const EXA_KEY = 'exa-snapshot-key-SECRET-5d1e'
const BRAVE_KEY = 'brave-snapshot-key-SECRET-77aa'

class FakeSidecar extends EventEmitter {
  startRun = vi.fn(async (req: { chatId: string }) => {
    this.emit('runStarted', { runId: 'run-1', chatId: req.chatId })
    return { ok: true as const, runId: 'run-1' }
  })
  respondHitl = vi.fn(async () => {})
  isAwaitingPlanApproval = vi.fn(() => false)
  push(event: Partial<AgentEvent> & { type: string; seq: number }): void {
    this.emit('event', { runId: 'run-1', ts: 1, ...event })
  }
}

const searchRecord = (callId: string) => ({
  schema: 1, runId: 'run-1', chatId: 'c', kind: 'search_call', role: 'worker', agentId: '1.1', attempt: 0, toolRound: 0, callId,
  name: 'builtin__web_search', timing: { startedAt: 1, endedAt: 1601, ms: 1600 },
  search: {
    provider: 'exa', query: 'q', requestedType: 'deep', effectiveType: 'auto', caps: [],
    request: { url: 'https://api.exa.ai/search', method: 'POST', headers: { 'x-api-key': EXA_KEY } },
    status: 200, rawResponse: { results: [{}, {}, {}], costDollars: { total: 0.007 } }, formatted: { chars: 900 }, retries: [], error: null,
  },
})

function setup() {
  const sidecar = new FakeSidecar()
  let settings: Record<string, unknown> = { braveSearchEnabled: true, webSearchProvider: 'exa', exaSearchType: 'deep', exaApiKey: EXA_KEY, braveSearchApiKey: BRAVE_KEY }
  const sent: AgentEvent[] = []
  const calls: Array<BuiltinCallContext | undefined> = []
  const builtin = {
    getToolSchemas: () => [],
    call: vi.fn(async (_t: string, _a: Record<string, unknown>, ctx?: BuiltinCallContext) => {
      calls.push(ctx)
      ctx?.record(searchRecord(ctx.callId ?? ''))
      return 'results'
    }),
  }
  const coordinator = new MultiAgentRunCoordinator({
    sidecar: sidecar as unknown as CoordinatorDeps['sidecar'],
    mcp: {
      getToolSchemasForMultiAgent: () => [], getMultiAgentExclusions: () => [], clearRunTrust: vi.fn(), cancelRunPermissions: vi.fn(),
      callBuiltinForMultiAgent: async (_t: string, _a: unknown, _c: unknown, run: () => Promise<string>) => ({ text: await run(), images: [], userNote: '' }),
    } as unknown as CoordinatorDeps['mcp'],
    builtin,
    sendEvent: (e) => sent.push(e),
    db: { begin: vi.fn(), saveTrace: vi.fn(), saveAssistantMessage: vi.fn(), getRun: vi.fn(() => null), claimMode: vi.fn(() => null) },
    observe: () => {},
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-1', openRouterModel: 'active/model' }),
    webSearchSettings: () => settings as never,
    catalogue: async () => [DEFAULT_SYNTHESIZER_MODEL, 'meta-llama/llama-3.3-70b-instruct', 'active/model'].map((id) => ({
      id, name: id, contextLength: 128_000, promptPrice: 1e-6, completionPrice: 2e-6, supportsTools: true,
    })),
    flushDelayMs: 5,
  })
  return { coordinator, sidecar, sent, calls, builtin, change: (patch: Record<string, unknown>) => { settings = { ...settings, ...patch } } }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('multi-agent web search snapshot', () => {
  it('run_config carries the start-time snapshot (effective worker type); tool_done carries the record summary', async () => {
    const { coordinator, sidecar, sent, calls, change } = setup()
    await coordinator.start({ chatId: 'c', task: 't', config: { ...DEFAULT_MULTI_AGENT_CONFIG } })
    // The user switches to Brave in Settings while the run is live.
    change({ webSearchProvider: 'brave' })
    sidecar.push({ type: 'run_config', seq: 1 } as never)
    expect(sent.find((e) => e.type === 'run_config')).toMatchObject({ webSearch: { provider: 'exa', type: 'auto' } })

    sidecar.push({ type: 'hitl_pause', seq: 2, agentId: '1.1', role: 'worker', toolName: 'web_search', serverName: 'builtin', args: { query: 'q' }, callId: 'call-7', toolRound: 0 } as never)
    await tick()
    // Workers search with the pinned provider and depth, not the new setting.
    expect(calls[0]?.searchSettings).toEqual({ webSearchProvider: 'exa', exaSearchType: 'deep' })
    sidecar.push({ type: 'tool_done', seq: 3, agentId: '1.1', attempt: 0, callId: 'call-7', ok: true, durationMs: 1700, resultPreview: 'r', resultChars: 900 } as never)
    expect(sent.find((e) => e.type === 'tool_done')).toMatchObject({ search: { provider: 'exa', type: 'auto', ms: 1600, costUsd: 0.007, results: 3 } })
    // A tool_done for another call is passed through untouched.
    sidecar.push({ type: 'tool_done', seq: 4, agentId: '1.1', attempt: 0, callId: 'other', ok: true, durationMs: 1, resultPreview: '', resultChars: 0 } as never)
    expect(sent.at(-1)).not.toHaveProperty('search')

    const json = JSON.stringify(sent) + JSON.stringify(calls.map((c) => c?.searchSettings))
    expect(json).not.toContain(EXA_KEY)
    expect(json).not.toContain(BRAVE_KEY)
  })

  it('web search off at start: run_config.webSearch is null', async () => {
    const { coordinator, sidecar, sent, change } = setup()
    change({ braveSearchEnabled: false })
    await coordinator.start({ chatId: 'c', task: 't', config: { ...DEFAULT_MULTI_AGENT_CONFIG } })
    sidecar.push({ type: 'run_config', seq: 1 } as never)
    expect(sent[0]).toMatchObject({ webSearch: null })
  })
})
