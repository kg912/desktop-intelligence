/**
 * Whether a multi-agent run is logged is decided once, at start, from
 * ObservabilityService.isEnabled(). Real ObservabilityService on a real temp
 * dir, real coordinator, wired as in src/main/index.ts.
 */
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, afterAll } from 'vitest'

const USER_DATA = mkdtempSync(join(tmpdir(), 'di-run-logging-'))
const shell = vi.hoisted(() => ({ openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA }, shell }))

let settings: Record<string, unknown> = {}
vi.mock('../SettingsStore', () => ({
  readSettings: () => settings,
  writeSettings: (patch: Record<string, unknown>) => { settings = { ...settings, ...patch } },
}))

import { ObservabilityService } from '../ObservabilityService'
import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import type { CoordinatorDeps } from '../MultiAgentRunCoordinator'
import type { CallRecord } from '../MultiAgentRunLogger'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'

afterAll(() => rmSync(USER_DATA, { recursive: true, force: true }))

const CONFIG = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'm/w', worker: 'm/w', reflection: 'm/w', synthesizer: 'm/w' } }

function app(obs: ObservabilityService) {
  let next = 0
  const sidecar = Object.assign(new EventEmitter(), {
    startRun: vi.fn(async (req: { chatId: string }) => {
      const runId = `run-${++next}`
      sidecar.emit('runStarted', { runId, chatId: req.chatId })
      return { ok: true as const, runId }
    }),
    respondHitl: vi.fn(), abortRun: vi.fn(), isAwaitingPlanApproval: vi.fn(() => false),
  })
  const coordinator = new MultiAgentRunCoordinator({
    sidecar: sidecar as unknown as CoordinatorDeps['sidecar'],
    mcp: { getToolSchemasForMultiAgent: () => [], getMultiAgentExclusions: () => [], clearRunTrust: vi.fn(), cancelRunPermissions: vi.fn() } as unknown as CoordinatorDeps['mcp'],
    builtin: { getToolSchemas: () => [], call: vi.fn() },
    sendEvent: () => {},
    db: { begin: vi.fn(), saveTrace: vi.fn(), saveAssistantMessage: vi.fn(), getRun: () => null, claimMode: () => null },
    observe: (_chatId, e) => obs.multiAgentRuns.event(e),
    runLog: {
      enabled: () => obs.isEnabled(),
      begin: (run) => obs.multiAgentRuns.begin({ ...run, chatTitle: 'Chat' }),
      record: (runId, record) => obs.multiAgentRuns.record(runId, record as CallRecord),
    },
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-1', openRouterModel: 'm/w' }),
    catalogue: async () => [],
    flushDelayMs: 1,
  })
  /** Start a run and drive it to task_complete. */
  const run = async (chatId: string) => {
    const result = await coordinator.start({ chatId, task: 't', config: CONFIG })
    if (!result.ok) throw new Error(result.reason)
    const done = { runId: result.runId, seq: 1, ts: 1, type: 'task_complete', finalOutput: 'x', totalCostUsd: 0, totalTokens: 0 } as AgentEvent
    sidecar.emit('event', done)
    await new Promise((r) => setTimeout(r, 10))
    await obs.multiAgentRuns.flush()
    return { ...result, observe: (sidecar.startRun.mock.calls.at(-1)![0] as unknown as { observe: boolean }).observe }
  }
  return { run }
}

describe('run logging is decided at run start', () => {
  it('off at launch: not recorded, and the Debug panel lists it as "not recorded"; switched on after launch: the next run is recorded with its folder', async () => {
    settings = { observabilityEnabled: false }
    const obs = new ObservabilityService()
    const { run } = app(obs)

    const off = await run('chat-a')
    expect(off).toMatchObject({ recorded: false, observe: false })
    expect(existsSync(obs.multiAgentRuns.runDir('chat-a', off.runId))).toBe(false)

    // The Debug toggle (or the dock's "Log the next run") after launch.
    obs.setPrefs({ observabilityEnabled: true })
    const on = await run('chat-b')
    expect(on).toMatchObject({ recorded: true, observe: true })
    const dir = obs.multiAgentRuns.runDir('chat-b', on.runId)
    expect(existsSync(join(dir, 'run.meta.json'))).toBe(true)
    expect(existsSync(join(dir, 'run.md'))).toBe(true)

    const rows = await obs.listMultiAgentRunLogs([
      { runId: off.runId, chatId: 'chat-a', chatTitle: 'A', startedAt: 1 },
      { runId: on.runId, chatId: 'chat-b', chatTitle: 'B', startedAt: 2 },
    ])
    expect(Object.fromEntries(rows.map((r) => [r.runId, r.status]))).toEqual({ [off.runId]: 'not_recorded', [on.runId]: 'completed' })
    obs.revealMultiAgentRun('chat-b', on.runId)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(join(dir, 'run.meta.json'))
  })
})
