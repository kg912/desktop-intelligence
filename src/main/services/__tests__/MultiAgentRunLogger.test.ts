/**
 * Observability spec Phase 2: the per-run writer, on a real temp directory.
 * The end-to-end run through the real sidecar is in MultiAgentSidecar.integration.test.ts.
 */
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { describe, it, expect, vi, afterAll } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/di-runlog-test' } }))

import { MultiAgentRunLogger, parseJsonl, peakConcurrency, readRun, renderRun, safeId } from '../MultiAgentRunLogger'
import type { CallRecord, RunLogMeta } from '../MultiAgentRunLogger'
import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import type { CoordinatorDeps } from '../MultiAgentRunCoordinator'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'

const TMP = mkdtempSync(join(tmpdir(), 'di-runlog-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
let n = 0
const freshRoot = (): string => join(TMP, `root-${++n}`)
const CONFIG = { ...DEFAULT_MULTI_AGENT_CONFIG, models: { orchestrator: 'm/plan', worker: 'm/work', reflection: 'm/judge', synthesizer: 'm/synth' } }
const SECRET = 'sk-or-v1-very-secret-key'

function model(seq: number, role: CallRecord['role'], over: Partial<CallRecord> = {}): CallRecord {
  return {
    schema: 1, runId: 'run-1', chatId: 'chat-1', seq, kind: 'model', role, agentId: null, attempt: 0, toolRound: 0,
    model: `m/${role}`, modelServed: `m/${role}`,
    request: { messages: [{ role: 'system', content: `system for ${role}` }, { role: 'user', content: 'task' }], params: { model: `m/${role}`, temperature: 0.2 } },
    response: { content: `output ${seq}`, reasoning: '', toolCalls: [], finishReason: 'stop' },
    usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: null, costUsd: 0.001, generationId: `gen-${seq}` },
    timing: { startedAt: 1_000 + seq * 10, firstTokenAt: null, endedAt: 1_000 + seq * 10 + 5, ms: 5 },
    error: null, capped: null,
    ...over,
  }
}

const ev = (seq: number, e: Record<string, unknown>): AgentEvent => ({ runId: 'run-1', seq, ts: seq, ...e }) as AgentEvent

const PLAN = [
  { id: '1.1', label: 'Research', stage: 'worker', role: 'Researcher', model: 'm/work', phase: 1, dependsOn: [] },
  { id: '1.2', label: 'Analyse', stage: 'worker', role: 'Analyst', model: 'm/work', phase: 1, dependsOn: [] },
]

/** A complete small run fed through the REAL coordinator into the logger, as index.ts wires it. */
async function fullRun(root: string, opts: { enabled?: boolean } = {}) {
  const logger = new MultiAgentRunLogger(root, { secrets: () => [SECRET] })
  const sidecar = new (class extends EventEmitter {
    startRun = vi.fn(async (req: { chatId: string }) => {
      this.emit('runStarted', { runId: 'run-1', chatId: req.chatId })
      return { ok: true as const, runId: 'run-1' }
    })
    respondHitl = vi.fn(async () => {})
    abortRun = vi.fn(async () => {})
    isAwaitingPlanApproval = () => false
  })()
  const coordinator = new MultiAgentRunCoordinator({
    sidecar,
    mcp: { getToolSchemas: () => [], callToolForMultiAgent: vi.fn(), callBuiltinForMultiAgent: vi.fn(), clearRunTrust: vi.fn(), cancelRunPermissions: vi.fn() } as unknown as CoordinatorDeps['mcp'],
    builtin: { getToolSchemas: () => [], call: vi.fn() },
    sendEvent: () => {},
    db: { begin: vi.fn(), saveTrace: vi.fn(), saveAssistantMessage: vi.fn(), getRun: vi.fn(() => null), claimMode: vi.fn(() => null) },
    observe: (_chat, e) => logger.event(e),
    runLog: {
      enabled: () => opts.enabled ?? true,
      begin: (run) => logger.begin({ ...run, chatTitle: 'Audit chat' }),
      record: (runId, record) => logger.record(runId, record as CallRecord),
    },
    settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: SECRET, openRouterModel: 'm/work' }),
    catalogue: async () => [],
    flushDelayMs: 1,
  })
  await coordinator.start({ chatId: 'chat-1', task: 'Explain X', config: CONFIG })
  const rec = (r: CallRecord) => sidecar.emit('obsRecord', { runId: 'run-1', chatId: 'chat-1', record: r })
  sidecar.emit('event', ev(1, { type: 'orchestrator_plan', steps: PLAN }))
  rec(model(1, 'planner'))
  sidecar.emit('event', ev(2, { type: 'run_config', models: CONFIG.models, sources: { worker: 'saved' }, catalogueChecked: true, maxAgents: 4, budgetCapUsd: 1, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium', tools: ['fs__read'] }))
  rec(model(2, 'worker', { agentId: '1.1', response: { content: '', reasoning: 'think', toolCalls: [{ id: 'c1', name: 'fs__read', arguments: '{"path":"/a"}' }], finishReason: 'tool_calls' } }))
  rec({ ...model(3, 'worker'), kind: 'tool', agentId: '1.1', callId: 'c1', name: 'fs__read', args: '{"path":"/a"}', result: `file body ${SECRET}`, approved: true, denied: false, error: null })
  rec(model(4, 'worker', { agentId: '1.1', toolRound: 1 }))
  rec(model(5, 'worker', { agentId: '1.2' }))
  rec(model(6, 'reflection', { agentId: '1.1' }))
  rec(model(7, 'reflection', { agentId: '1.2' }))
  sidecar.emit('event', ev(3, { type: 'reflection_result', agentId: '1.2', attempt: 0, score: 2, passed: false, reason: 'shallow', issues: ['no sources'] }))
  rec(model(8, 'worker', { agentId: '1.2', attempt: 1 }))
  rec(model(9, 'synthesis'))
  sidecar.emit('event', ev(4, { type: 'task_complete', finalOutput: 'final', totalCostUsd: 0.009, totalTokens: 1350 }))
  if (opts.enabled !== false) await waitFor(() => readMeta(logger.runDir('chat-1', 'run-1'))?.summary !== undefined)
  return { logger, sidecar, dir: logger.runDir('chat-1', 'run-1') }
}

function readMeta(dir: string): RunLogMeta | null {
  try { return JSON.parse(readFileSync(join(dir, 'run.meta.json'), 'utf8')) } catch { return null }
}

async function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('MultiAgentRunLogger (observability spec Phase 2)', () => {
  it('a full run produces the section 4 tree, rendered from the JSONL', async () => {
    const root = freshRoot()
    const { dir, sidecar } = await fullRun(root)
    expect(dir).toBe(join(root, 'chat-1', 'run-1'))
    expect(readdirSync(dir).sort()).toEqual([
      'agent-1.1.jsonl', 'agent-1.1.md', 'agent-1.2.jsonl', 'agent-1.2.md', 'events.jsonl',
      'planner.jsonl', 'planner.md', 'run.md', 'run.meta.json', 'synthesis.jsonl', 'synthesis.md',
    ])
    expect(sidecar.startRun).toHaveBeenCalledWith(expect.objectContaining({ observe: true }))
    const meta = readMeta(dir)!
    expect(meta).toMatchObject({ status: 'completed', chatTitle: 'Audit chat', task: 'Explain X', summary: { modelCalls: 8, toolCalls: 1 } })
    // Records land in the file of their role/agent, in full.
    expect(parseJsonl<CallRecord>(readFileSync(join(dir, 'agent-1.1.jsonl'), 'utf8')).map((r) => r.seq)).toEqual([2, 3, 4, 6])
    expect(parseJsonl<AgentEvent>(readFileSync(join(dir, 'events.jsonl'), 'utf8')).map((e) => e.type)).toEqual(['orchestrator_plan', 'run_config', 'reflection_result', 'task_complete'])
    const run = readFileSync(join(dir, 'run.md'), 'utf8')
    expect(run).toContain('# Multi-agent run: Audit chat')
    expect(run).toContain('```mermaid')
    expect(run).toContain('[agent-1.1.md#call-3](agent-1.1.md#call-3)')
    const agent = readFileSync(join(dir, 'agent-1.2.md'), 'utf8')
    expect(agent).toMatch(/## Attempt 0[\s\S]*### Reflection[\s\S]*score 2\/5, failed[\s\S]*- no sources[\s\S]*## Attempt 1/)
    expect(readFileSync(join(dir, 'synthesis.md'), 'utf8')).toContain('system for synthesis')
  })

  it('never writes a credential: the key inside a tool result is scrubbed in JSONL and markdown', async () => {
    const { dir } = await fullRun(freshRoot())
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain(SECRET)
    expect(readFileSync(join(dir, 'agent-1.1.jsonl'), 'utf8')).toContain('file body [redacted]')
  })

  it('with observability off: observe:false to the sidecar and no files at all', async () => {
    const root = freshRoot()
    // Same run, but the toggle says off: begin is never called, so its events and records are ignored.
    const { sidecar, logger } = await fullRun(root, { enabled: false })
    expect(sidecar.startRun).toHaveBeenCalledWith(expect.objectContaining({ observe: false }))
    await logger.flush()
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(root)).toBe(false)
  })

  it('a crash mid-run (SIGKILL) leaves valid JSONL and run.meta.json status "incomplete"', async () => {
    const root = freshRoot()
    const script = join(TMP, 'crash-child.ts')
    writeFileSync(script, `
      import { MultiAgentRunLogger } from ${JSON.stringify(resolve(__dirname, '../MultiAgentRunLogger.ts'))}
      const logger = new MultiAgentRunLogger(${JSON.stringify(root)}, { secrets: () => [] })
      logger.begin({ runId: 'run-1', chatId: 'chat-1', chatTitle: 't', task: 'x', config: ${JSON.stringify(CONFIG)} })
      let seq = 0
      setInterval(() => {
        for (let i = 0; i < 20; i++) {
          seq++
          logger.event({ runId: 'run-1', seq, ts: seq, type: 'agent_token', agentId: '1.1', attempt: 0, token: 'x'.repeat(seq % 5000) })
          logger.record('run-1', { schema: 1, runId: 'run-1', chatId: 'chat-1', seq, kind: 'model', role: 'worker', agentId: '1.1', attempt: 0, timing: { startedAt: 1, endedAt: 2, ms: 1 }, response: { content: 'y'.repeat(seq * 37 % 9000), reasoning: '', toolCalls: [], finishReason: 'stop' } })
        }
        if (seq === 200) console.log('ready')
      }, 1)
    `)
    // One process (no tsx wrapper), so SIGKILL hits the writer itself.
    const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: resolve(__dirname, '../../../..'), stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((ready) => child.stdout.on('data', (d) => String(d).includes('ready') && ready()))
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))
    const dir = join(root, 'chat-1', 'run-1')
    expect(readMeta(dir)?.status).toBe('incomplete')
    for (const name of ['events.jsonl', 'agent-1.1.jsonl']) {
      const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    }
    // And it can still be rendered after the fact; status stays incomplete.
    expect((await renderRun(dir)).status).toBe('incomplete')
    expect(existsSync(join(dir, 'run.md'))).toBe(true)
  }, 30_000)

  it('retention keeps the newest N run directories and never deletes an active run', async () => {
    const root = freshRoot()
    const logger = new MultiAgentRunLogger(root, { secrets: () => [], keep: () => 2 })
    const begin = (runId: string, startedAt: number) => logger.begin({ runId, chatId: 'c', chatTitle: '', task: 't', config: CONFIG, startedAt })
    begin('old-active', 1) // never finishes
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      begin(id, 10 + i)
      logger.event({ runId: id, seq: 1, ts: 1, type: 'task_failed', reason: 'x', partialOutputs: {} } as AgentEvent)
      await logger.flush()
      await new Promise((r) => setTimeout(r, 20)) // let finish() render
    }
    await logger.prune()
    expect(readdirSync(join(root, 'c')).sort()).toEqual(['b', 'c', 'old-active'])
  })

  it('a logger that cannot write never throws into the caller', async () => {
    const blocker = join(TMP, `file-not-dir-${++n}`)
    writeFileSync(blocker, '')
    const logger = new MultiAgentRunLogger(blocker, { secrets: () => [] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => {
      logger.begin({ runId: 'r', chatId: 'c', chatTitle: '', task: 't', config: CONFIG })
      logger.record('r', model(1, 'planner'))
      logger.event({ runId: 'r', seq: 1, ts: 1, type: 'task_complete', finalOutput: '', totalCostUsd: 0, totalTokens: 0 } as AgentEvent)
    }).not.toThrow()
    await logger.flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ids from model output cannot escape the run directory', () => {
    expect(safeId('../../etc/passwd')).not.toContain('/')
    expect(safeId('1.1')).toBe('1.1')
    expect(safeId('..')).toBe('_')
  })

  it('peak concurrency is computed from the recorded timestamps', () => {
    const at = (seq: number, start: number, end: number) => model(seq, 'worker', { timing: { startedAt: start, endedAt: end, ms: end - start } })
    expect(peakConcurrency([at(1, 0, 10), at(2, 5, 15), at(3, 6, 7), at(4, 10, 20)])).toBe(3)
    expect(peakConcurrency([at(1, 0, 10), at(2, 10, 20)])).toBe(1) // back to back is not overlap
  })

  it('readRun skips a torn trailing line', async () => {
    const { dir } = await fullRun(freshRoot())
    writeFileSync(join(dir, 'planner.jsonl'), readFileSync(join(dir, 'planner.jsonl'), 'utf8') + '{"seq": 99, "kind": "mo')
    const { records } = await readRun(dir)
    expect(records.map((r) => r.seq)).not.toContain(99)
  })
})
