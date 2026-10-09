/**
 * Phase 0 of specs/multi-agent-observability.md: every claim the old
 * multi-agent logger makes, tested against the REAL ObservabilityService
 * writing to a REAL temp directory (no fs mock), fed by the REAL coordinator.
 * Each test fails if its claim is false. Findings: docs/observability-audit.md.
 */
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

const USER_DATA = mkdtempSync(join(tmpdir(), 'di-obs-audit-'))
const shell = vi.hoisted(() => ({ openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA }, shell }))

let settings: Record<string, unknown> = {}
vi.mock('../SettingsStore', () => ({
  readSettings: () => settings,
  writeSettings: (patch: Record<string, unknown>) => { settings = { ...settings, ...patch } },
}))

import { ObservabilityService } from '../ObservabilityService'
import { MultiAgentRunCoordinator, COALESCE_WINDOW_MS } from '../MultiAgentRunCoordinator'
import type { CoordinatorDeps } from '../MultiAgentRunCoordinator'
import { agentEventStepType, parseAgentEvent } from '../../../shared/agentEvents'
import type { AgentTraceStepType } from '../../../shared/agentEvents'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'

const LOG = join(USER_DATA, 'observability-logs', 'multi-agent-events.jsonl')
const RUN = 'run-audit'

/** One valid event per AgentEvent type. Typed as a Record so a new type that is not listed fails typecheck. */
const SAMPLES: Record<AgentEvent['type'], Record<string, unknown>> = {
  orchestrator_plan: { steps: [{ id: '1.1', label: 'Research', stage: 'worker', role: 'Researcher', model: 'm/w', phase: 1, dependsOn: [] }] },
  run_config: { models: { worker: 'm/w' }, sources: { worker: 'saved' }, catalogueChecked: true, maxAgents: 2, budgetCapUsd: 1, reflectionPassThreshold: 3, maxRetriesPerAgent: 1, reasoningEffort: 'medium' },
  hitl_pause: { agentId: 'orchestrator', role: 'Orchestrator', toolName: 'approve_plan', serverName: 'multi-agent', args: {} },
  hitl_resume: { agentId: 'orchestrator', approved: true },
  context_compacted: { agentId: '1.1', attempt: 0, stubbed: 2, tokensFreed: 5_000 },
  agent_start: { agentId: '1.1', role: 'Researcher', model: 'm/w', attempt: 0 },
  agent_reasoning: { agentId: '1.1', attempt: 0, token: 'think' },
  agent_token: { agentId: '1.1', attempt: 0, token: 'answer' },
  tool_start: { agentId: '1.1', attempt: 0, callId: 'c1', tool: 'read', server: 'fs', argsPreview: '{}' },
  tool_done: { agentId: '1.1', attempt: 0, callId: 'c1', ok: true, durationMs: 3, resultPreview: 'r', resultChars: 1 },
  agent_complete: { agentId: '1.1', attempt: 0, output: 'answer', tokenCount: 10, costUsd: 0.001 },
  reflection_start: { agentId: '1.1', attempt: 0 },
  reflection_result: { agentId: '1.1', attempt: 0, score: 2, passed: false, reason: 'shallow' },
  retry: { agentId: '1.1', attempt: 1, reason: 'shallow' },
  agent_failed: { agentId: '1.1', attempt: 1, reason: 'gave up' },
  synthesis_start: {},
  synthesis_token: { token: 'final' },
  task_complete: { finalOutput: 'final', totalCostUsd: 0.002, totalTokens: 20 },
  task_failed: { reason: 'boom', partialOutputs: {} },
}
const TYPES = Object.keys(SAMPLES) as AgentEvent['type'][]

function event(type: AgentEvent['type'], seq: number, extra: Record<string, unknown> = {}): AgentEvent {
  return parseAgentEvent({ runId: RUN, seq, ts: seq * 1_000, type, ...SAMPLES[type], ...extra })
}

function readLog(): Array<{ chatId: string; runId: string; stepType: string; event: AgentEvent }> {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** emitMultiAgentEvent is fire-and-forget; wait until `n` lines landed (or time out). */
async function waitForLines(n: number): Promise<void> {
  for (let i = 0; i < 200 && readLog().length < n; i++) await new Promise((r) => setTimeout(r, 10))
}

class FakeSidecar extends EventEmitter {
  startRun = vi.fn(async (req: { chatId: string }) => {
    this.emit('runStarted', { runId: RUN, chatId: req.chatId })
    return { ok: true as const, runId: RUN }
  })
  respondHitl = vi.fn(async () => {})
  abortRun = vi.fn(async () => {})
  isAwaitingPlanApproval = vi.fn(() => false)
}

/** The production wiring from src/main/index.ts: observe → emitMultiAgentEvent. */
function coordinatorWith(obs: ObservabilityService, observe?: CoordinatorDeps['observe']) {
  const sidecar = new FakeSidecar()
  const db = { begin: vi.fn(), saveTrace: vi.fn(), saveAssistantMessage: vi.fn(), getRun: vi.fn(() => null), claimMode: vi.fn(() => null) }
  const sent: AgentEvent[] = []
  const coordinator = new MultiAgentRunCoordinator({
    sidecar,
    mcp: { getToolSchemasForMultiAgent: () => [], getMultiAgentExclusions: () => [], callToolForMultiAgent: vi.fn(), callBuiltinForMultiAgent: vi.fn(), clearRunTrust: vi.fn(), cancelRunPermissions: vi.fn() } as unknown as CoordinatorDeps['mcp'],
    builtin: { getToolSchemas: () => [], call: vi.fn() },
    sendEvent: (e) => sent.push(e),
    db,
    observe: observe ?? ((chatId, e) => obs.emitMultiAgentEvent(chatId, e)),
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-audit', openRouterModel: 'm/w' }),
    catalogue: async () => [],
    flushDelayMs: 1,
  })
  const start = () => coordinator.start({ chatId: 'chat-audit', task: 'audit', config: { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'm/w', worker: 'm/w', reflection: 'm/w', synthesizer: 'm/w' } } })
  return { coordinator, sidecar, db, sent, start }
}

beforeEach(() => {
  rmSync(join(USER_DATA, 'observability-logs'), { recursive: true, force: true })
  settings = {}
})
afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }))

describe('Phase 0 audit — the old multi-agent logger', () => {
  it('claim: observabilityEnabled defaults to false when the setting was never saved', () => {
    expect(new ObservabilityService().isEnabled()).toBe(false)
    expect(new ObservabilityService().getPrefs().observabilityEnabled).toBe(false)
  })

  it('claim: with the toggle off, nothing is written — no file, no directory', async () => {
    const obs = new ObservabilityService()
    for (const [i, type] of TYPES.entries()) obs.emitMultiAgentEvent('chat-audit', event(type, i + 1))
    await new Promise((r) => setTimeout(r, 100))
    expect(existsSync(join(USER_DATA, 'observability-logs'))).toBe(false)
  })

  it('claim: with the toggle on, each event is one JSON line in the single global file', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    obs.emitMultiAgentEvent('chat-audit', event('agent_start', 1))
    await waitForLines(1)
    expect(readLog()).toEqual([expect.objectContaining({ chatId: 'chat-audit', runId: RUN, agentId: '1.1', stepType: 'worker', event: expect.objectContaining({ type: 'agent_start' }) })])
  })

  it('claim: turning the toggle on at runtime (setPrefs) takes effect for the next event without a restart', async () => {
    const obs = new ObservabilityService()
    obs.setPrefs({ observabilityEnabled: true })
    obs.emitMultiAgentEvent('chat-audit', event('agent_start', 1))
    await waitForLines(1)
    expect(readLog()).toHaveLength(1)
  })

  it('claim: stepType maps every AgentEvent type as documented', () => {
    const expected: Record<AgentEvent['type'], AgentTraceStepType> = {
      orchestrator_plan: 'orchestrator', run_config: 'orchestrator',
      hitl_pause: 'orchestrator', hitl_resume: 'orchestrator', // agentId "orchestrator" in SAMPLES
      agent_start: 'worker', agent_reasoning: 'worker', agent_token: 'worker', tool_start: 'worker', tool_done: 'worker',
      agent_complete: 'worker', retry: 'worker', agent_failed: 'worker', context_compacted: 'worker',
      reflection_start: 'reflection', reflection_result: 'reflection',
      synthesis_start: 'synthesizer', synthesis_token: 'synthesizer',
      task_complete: 'run', task_failed: 'run',
    }
    for (const type of TYPES) expect([type, agentEventStepType(event(type, 1))]).toEqual([type, expected[type]])
    // A worker's tool pause is a worker step, not the orchestrator's.
    expect(agentEventStepType(event('hitl_pause', 1, { agentId: '1.1', role: 'Researcher', toolName: 'read', serverName: 'fs' }))).toBe('worker')
  })

  it('claim: every AgentEvent type the UI receives reaches the file (through the real coordinator)', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    const { sidecar, sent, start } = coordinatorWith(obs)
    await start()
    // task_failed is terminal too, so it gets its own run below.
    const types = TYPES.filter((t) => t !== 'task_failed')
    types.forEach((type, i) => sidecar.emit('event', event(type, i + 1)))
    await waitForLines(types.length)
    expect(new Set(sent.map((e) => e.type))).toEqual(new Set(types))
    expect(new Set(readLog().map((l) => l.event.type))).toEqual(new Set(types))

    const second = coordinatorWith(obs)
    await second.start()
    second.sidecar.emit('event', event('task_failed', 99))
    await waitForLines(types.length + 1)
    expect(readLog().at(-1)?.event.type).toBe('task_failed')
  })

  it('claim: token events are coalesced per agent+attempt within the window — UI gets every token, the file gets the joined text', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    const { sidecar, sent, start } = coordinatorWith(obs)
    await start()
    const tok = (seq: number, ts: number, token: string) => ({ ...event('agent_token', seq, { token }), ts })
    sidecar.emit('event', tok(1, 0, 'Hel'))
    sidecar.emit('event', tok(2, 10, 'lo '))
    sidecar.emit('event', tok(3, 20, 'wor'))
    sidecar.emit('event', tok(4, 20 + COALESCE_WINDOW_MS, 'ld')) // outside the window → a new line
    sidecar.emit('event', event('task_complete', 5))
    await waitForLines(3)
    expect(sent.filter((e) => e.type === 'agent_token')).toHaveLength(4)
    const tokens = readLog().filter((l) => l.event.type === 'agent_token').map((l) => (l.event as { token: string }).token)
    expect(tokens).toEqual(['Hello wor', 'ld'])
  })

  it('claim: lines land in emit order (seq ascending) even when events arrive in a burst', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    const N = 300
    for (let i = 1; i <= N; i++) obs.emitMultiAgentEvent('chat-audit', event('tool_start', i, { callId: `c${i}` }))
    await waitForLines(N)
    const seqs = readLog().map((l) => l.event.seq)
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  })

  it('claim: listMultiAgentEvents is newest first, so the Debug panel\'s slice(0, 25) is the 25 newest', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    for (let i = 1; i <= 40; i++) obs.emitMultiAgentEvent('chat-audit', event('tool_start', i, { callId: `c${i}` }))
    await waitForLines(40)
    const shown = (await obs.listMultiAgentEvents()).slice(0, 25).map((e) => e.event.seq)
    expect(shown).toEqual(Array.from({ length: 25 }, (_, i) => 40 - i))
  })

  it('claim: a run with the toggle on produces file entries for that run, start to terminal', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    const { sidecar, start } = coordinatorWith(obs)
    await start()
    const seq = ['orchestrator_plan', 'run_config', 'agent_start', 'agent_complete', 'synthesis_start', 'task_complete'] as const
    seq.forEach((type, i) => sidecar.emit('event', event(type, i + 1)))
    await waitForLines(seq.length)
    const lines = readLog().filter((l) => l.runId === RUN && l.chatId === 'chat-audit')
    expect(lines.map((l) => l.event.type)).toEqual([...seq])
  })

  it('rule: a logger that throws never fails the run — the UI and the database still get every event', async () => {
    const obs = new ObservabilityService()
    const { sidecar, sent, db, start } = coordinatorWith(obs, () => { throw new Error('disk full') })
    await start()
    const seq = ['agent_start', 'agent_complete', 'task_complete'] as const
    expect(() => seq.forEach((type, i) => sidecar.emit('event', event(type, i + 1)))).not.toThrow()
    expect(sent.map((e) => e.type)).toEqual([...seq])
    expect(db.saveAssistantMessage).toHaveBeenCalled()
  })
})

describe('Phase 4 — Debug panel actions on per-run logs', () => {
  const CONFIG = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'm', worker: 'm', reflection: 'm', synthesizer: 'm' } }

  it('lists recorded runs merged with "not recorded" history; open renders an unfinished run first; reveal; files outside the run are refused', async () => {
    settings = { observabilityEnabled: true }
    const obs = new ObservabilityService()
    obs.multiAgentRuns.begin({ runId: 'r1', chatId: 'c1', chatTitle: 'T', task: 't', config: CONFIG, startedAt: 2 })
    await obs.multiAgentRuns.flush()
    const rows = await obs.listMultiAgentRunLogs([{ runId: 'r0', chatId: 'c0', chatTitle: 'Old', startedAt: 1 }, { runId: 'r1', chatId: 'c1', chatTitle: 'T', startedAt: 2 }])
    expect(rows.map((r) => [r.runId, r.status])).toEqual([['r1', 'running'], ['r0', 'not_recorded']])
    expect(await obs.deleteMultiAgentRun('c1', 'r1')).toBe(false) // never while active

    obs.multiAgentRuns.event(event('task_failed', 1, { runId: 'r1' }))
    await obs.multiAgentRuns.flush()
    const dir = obs.multiAgentRuns.runDir('c1', 'r1')
    rmSync(join(dir, 'run.md'), { force: true })
    await obs.openMultiAgentRunFile('c1', 'r1')
    expect(existsSync(join(dir, 'run.md'))).toBe(true)
    expect(shell.openPath).toHaveBeenLastCalledWith(join(dir, 'run.md'))
    expect(await obs.openMultiAgentRunFile('c1', 'r1', '../../../settings.json')).toBe('not found')
    obs.revealMultiAgentRun('c1', 'r1')
    expect(shell.showItemInFolder).toHaveBeenCalledWith(join(dir, 'run.meta.json'))

    const page = await obs.listMultiAgentRunEvents('c1', 'r1', 0, 25)
    expect(page.total).toBe(1)
    expect(await obs.deleteMultiAgentRun('c1', 'r1')).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
