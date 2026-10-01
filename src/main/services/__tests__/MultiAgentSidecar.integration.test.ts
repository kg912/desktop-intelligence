/**
 * End-to-end: the REAL Python sidecar (resources/python/multi_agent_sidecar.py),
 * launched by the REAL MultiAgentSidecarManager inside the REAL srt sandbox,
 * talking to a local fake OpenRouter that speaks the streaming SSE protocol
 * (content + tool_call deltas, SSE comments, final usage chunk).
 *
 * Covers MULTI_AGENT_SPEC.html DoD D1 (≥2 parallel agents end-to-end), D2
 * (reflection failure + automatic retry), D3 (provenance tags), D4 (a HITL
 * pause does not block a parallel agent), D7 (per-agent usage from OpenRouter
 * usage), D8 (clean abort / no orphans), D9 (budget cap: partial synthesis,
 * no overspend), plus re-plan on an over-cap plan, HITL timeout, auth and
 * crash recovery.
 *
 * Gated: needs macOS sandbox-exec and a Python with the pinned sidecar
 * requirements — `npm run test:sidecar:setup` creates
 * node_modules/.cache/di-sidecar-venv (or set DI_SIDECAR_PYTHON).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer } from 'http'
import type { IncomingMessage, Server } from 'http'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { AgentEvent, MultiAgentConfig } from '../../../shared/types'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? '/tmp/di-sidecar-it-userdata' : '/tmp') },
}))

import { MultiAgentSidecarManager } from '../MultiAgentSidecarManager'
import { srtBackend } from '../sandbox/sandboxServiceInstance'

const ROOT = resolve(__dirname, '../../../..')
const SCRIPT = join(ROOT, 'resources/python/multi_agent_sidecar.py')
const PYTHON = process.env.DI_SIDECAR_PYTHON ?? join(ROOT, 'node_modules/.cache/di-sidecar-venv/bin/python')

function canRun(): boolean {
  if (process.platform !== 'darwin' || !existsSync(PYTHON)) return false
  try {
    execFileSync('which', ['sandbox-exec'], { stdio: 'ignore' })
    execFileSync(PYTHON, ['-c', 'import fastapi, uvicorn, langgraph'], { stdio: 'ignore', timeout: 30_000 })
    return true
  } catch {
    return false
  }
}
const ENABLED = canRun()

// ── Fake OpenRouter ─────────────────────────────────────────────────────────

interface Reply {
  content?: string
  toolCalls?: Array<{ id: string; name: string; args: string }>
  /** Hold the response open this long before streaming (parallelism tests). */
  delayMs?: number
}
type Body = {
  model: string
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>
  tools?: Array<{ function: { name: string } }>
  max_tokens?: number
  stream?: boolean
  usage?: { include?: boolean }
}
interface FakeOpenRouter {
  url: string
  /** start/end: ms timestamps when the request body arrived and the response ended. */
  requests: Array<{ body: Body; auth: string | undefined; start: number; end: number }>
  pricing: Record<string, { prompt: number; completion: number }>
  close(): Promise<void>
}

const PROMPT_TOKENS = 100
const COMPLETION_TOKENS = 50

function startFakeOpenRouter(route: (body: Body) => Reply): Promise<FakeOpenRouter> {
  const fake = { requests: [] as FakeOpenRouter['requests'], pricing: {} as FakeOpenRouter['pricing'] }
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as Body
      const record = { body, auth: req.headers.authorization, start: Date.now(), end: 0 }
      fake.requests.push(record)
      const reply = route(body)
      // Honour max_tokens like the real API does; cost from the fake price list.
      const completion = Math.min(body.max_tokens ?? COMPLETION_TOKENS, COMPLETION_TOKENS)
      const price = fake.pricing[body.model]
      const cost = price ? PROMPT_TOKENS * price.prompt + completion * price.completion : 0.001
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (obj: unknown): boolean => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      res.write(': OPENROUTER PROCESSING\n\n')
      const stream = (): void => {
        const text = reply.content ?? ''
        for (const part of text.match(/.{1,12}/gs) ?? []) send({ choices: [{ index: 0, delta: { content: part } }] })
        reply.toolCalls?.forEach((call, index) => {
          const half = Math.ceil(call.args.length / 2)
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args.slice(0, half) } }] } }] })
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.args.slice(half) } }] } }] })
        })
        send({
          choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: completion, total_tokens: PROMPT_TOKENS + completion, cost },
        })
        record.end = Date.now()
        res.end('data: [DONE]\n\n')
      }
      setTimeout(stream, reply.delayMs ?? 0)
    })
  })
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({
        url: `http://127.0.0.1:${port}`,
        ...fake,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

const systemOf = (body: Body): string => body.messages[0]?.content ?? ''
const userOf = (body: Body): string => body.messages.find((m) => m.role === 'user')?.content ?? ''

/** Default scenario: Researcher uses a tool, Analyzer is rejected once, synthesis cites both. */
let planOverride: ((body: Body, attempt: number) => Reply) | null = null
/** Consulted first for every non-planner request; undefined falls through to the default scenario. */
let replyOverride: ((body: Body) => Reply | undefined) | null = null
let plannerCalls = 0
function scenario(body: Body): Reply {
  const system = systemOf(body)
  const overridden = !system.includes('orchestrator of a team') ? replyOverride?.(body) : undefined
  if (overridden) return overridden
  if (system.includes('orchestrator of a team')) {
    plannerCalls++
    if (planOverride) return planOverride(body, plannerCalls)
    return { content: JSON.stringify([
      { id: '1.1', label: 'Research the topic', role: 'Researcher', phase: 1 },
      { id: '1.2', label: 'Analyze the implications', role: 'Analyzer', phase: 1 },
    ]) }
  }
  if (system.includes('strict reviewer')) {
    return { content: userOf(body).includes('Analysis v1') ? '{"score": 2, "reason": "too shallow"}' : '{"score": 5, "reason": "solid"}' }
  }
  if (system.includes('synthesize')) return { content: 'The topic is X [1.1] and it implies Y [1.2].' }
  if (system.includes('Researcher agent')) {
    const toolResult = body.messages.find((m) => m.role === 'tool' && m.content.includes('notes-content'))
    if (toolResult) return { content: `Research found: ${toolResult.content}` }
    return {
      toolCalls: [
        { id: 'call_1', name: 'fs__read_file', args: '{"path": "/notes.txt"}' },
        { id: 'call_2', name: 'evil__exec', args: '{"cmd": "rm -rf /"}' },
      ],
    }
  }
  if (system.includes('Analyzer agent')) {
    return { content: userOf(body).includes('rejected') ? 'Analysis v2 — thorough.' : 'Analysis v1' }
  }
  return { content: 'ok' }
}

const TOOLS = [{ name: 'fs__read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]

const baseConfig = (overrides: Partial<MultiAgentConfig> = {}): MultiAgentConfig => ({
  maxAgents: 4,
  budgetCapUsd: 10,
  models: { orchestrator: 'fake/planner', worker: 'fake/worker', reflection: 'fake/reviewer', synthesizer: 'fake/synth' },
  reflectionPassThreshold: 3,
  maxRetriesPerAgent: 2,
  hitlTimeoutMs: 60_000,
  requirePermissions: true,
  ...overrides,
})

/** Start a run and collect its events until the terminal one; `onEvent` may respond to pauses. */
function runToEnd(
  mgr: MultiAgentSidecarManager,
  opts: { config?: MultiAgentConfig; pricing?: Record<string, { prompt: number; completion: number }>; onEvent: (e: AgentEvent, all: AgentEvent[]) => void }
): Promise<AgentEvent[]> {
  return new Promise((resolveRun, reject) => {
    const events: AgentEvent[] = []
    let runId = ''
    const listener = (e: AgentEvent): void => {
      if (runId && e.runId !== runId) return
      events.push(e)
      try {
        opts.onEvent(e, events)
      } catch (err) {
        reject(err)
      }
      if (e.type === 'task_complete' || e.type === 'task_failed') {
        mgr.off('event', listener)
        resolveRun(events)
      }
    }
    mgr.on('event', listener)
    mgr
      .startRun({ chatId: 'chat-1', task: 'Explain X', config: opts.config ?? baseConfig(), tools: TOOLS, openRouterApiKey: 'sk-or-test', pricing: opts.pricing })
      .then((r) => {
        if (!r.ok) reject(new Error(r.reason))
        else runId = r.runId
      }, reject)
  })
}

const approvePlan = (mgr: MultiAgentSidecarManager) => (e: AgentEvent): void => {
  if (e.type === 'hitl_pause' && e.serverName === 'multi-agent') void mgr.respondHitl({ runId: e.runId, agentId: 'orchestrator', approved: true })
}

describe.skipIf(!ENABLED)('multi-agent sidecar — real process, real sandbox, fake OpenRouter', () => {
  let fake: FakeOpenRouter
  let mgr: MultiAgentSidecarManager

  beforeAll(async () => {
    fake = await startFakeOpenRouter(scenario)
    mgr = new MultiAgentSidecarManager({ healthIntervalMs: 60_000 })
    mgr.configure({
      scriptPath: SCRIPT,
      workspaceDir: mkdtempSync(join(tmpdir(), 'di-sidecar-it-')),
      pythonPath: PYTHON,
      openRouterBaseUrl: fake.url,
    })
    await mgr.start()
  }, 60_000)

  afterAll(async () => {
    await mgr?.stop()
    await fake?.close()
    await srtBackend.shutdown()
  })

  it('runs parallel agents end-to-end: tool pause does not block the other agent, reflection retries, provenance synthesis (D1–D4, D7)', async () => {
    fake.requests.length = 0
    plannerCalls = 0
    let researcherPause: Extract<AgentEvent, { type: 'hitl_pause' }> | null = null
    const events = await runToEnd(mgr, {
      onEvent: (e, all) => {
        approvePlan(mgr)(e)
        if (e.type === 'hitl_pause' && e.serverName === 'fs') researcherPause = e
        // Answer the Researcher's tool only once the Analyzer has fully finished —
        // proving the pause never blocked it.
        const analyzerPassed = all.some((x) => x.type === 'reflection_result' && x.agentId === '1.2' && x.passed)
        if (researcherPause && analyzerPassed) {
          const pause = researcherPause
          researcherPause = null
          void mgr.respondHitl({ runId: pause.runId, agentId: pause.agentId, approved: true, result: 'notes-content' })
        }
      },
    })
    const types = events.map((e) => e.type)
    const terminal = events.at(-1)!
    expect(terminal.type).toBe('task_complete')

    // Pre-flight: plan approval precedes every worker.
    expect(types.indexOf('hitl_pause')).toBeLessThan(types.indexOf('agent_start'))

    // Tool pause carries agent identity; the non-offered tool never reached Electron.
    const toolPauses = events.filter((e): e is Extract<AgentEvent, { type: 'hitl_pause' }> => e.type === 'hitl_pause' && e.serverName !== 'multi-agent')
    expect(toolPauses).toHaveLength(1)
    expect(toolPauses[0]).toMatchObject({ agentId: '1.1', role: 'Researcher', model: 'fake/worker', serverName: 'fs', toolName: 'read_file', args: { path: '/notes.txt' } })
    const secondResearcherRequest = fake.requests.filter((r) => systemOf(r.body).includes('Researcher agent'))[1]
    expect(JSON.stringify(secondResearcherRequest.body.messages)).toContain("tool 'evil__exec' was not offered")

    // D4: the Analyzer finished while the Researcher was paused.
    const analyzerPassIdx = events.findIndex((e) => e.type === 'reflection_result' && e.agentId === '1.2' && e.passed)
    const researcherResumeIdx = events.findIndex((e) => e.type === 'hitl_resume' && e.agentId === '1.1')
    expect(analyzerPassIdx).toBeGreaterThan(-1)
    expect(analyzerPassIdx).toBeLessThan(researcherResumeIdx)

    // D2: failed reflection → automatic retry with the failure context injected.
    expect(events).toContainEqual(expect.objectContaining({ type: 'reflection_result', agentId: '1.2', passed: false, score: 2 }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'retry', agentId: '1.2', attempt: 1, reason: 'too shallow' }))

    // D7: per-agent usage is the sum of that agent's OpenRouter usage.
    const researcherDone = events.find((e): e is Extract<AgentEvent, { type: 'agent_complete' }> => e.type === 'agent_complete' && e.agentId === '1.1')!
    expect(researcherDone.output).toContain('notes-content')
    expect(researcherDone.tokenCount).toBe(2 * (PROMPT_TOKENS + COMPLETION_TOKENS))
    expect(researcherDone.costUsd).toBeCloseTo(0.002, 8)

    // Streaming: tokens arrive before completion and assemble the output.
    const researcherTokens = events.filter((e) => e.type === 'agent_token' && e.agentId === '1.1').map((e) => (e as { token: string }).token).join('')
    expect(researcherTokens).toBe(researcherDone.output)

    // D3: synthesis streamed token by token, with provenance markers; totals match every request.
    const synthesis = events.filter((e) => e.type === 'synthesis_token').map((e) => (e as { token: string }).token).join('')
    expect(terminal).toMatchObject({ finalOutput: synthesis })
    expect(synthesis).toMatch(/\[1\.1\].*\[1\.2\]/)
    expect(terminal).toMatchObject({ totalTokens: fake.requests.length * (PROMPT_TOKENS + COMPLETION_TOKENS) })

    // Every request streamed with usage accounting and the per-run key.
    for (const r of fake.requests) {
      expect(r.body.stream).toBe(true)
      expect(r.body.usage).toEqual({ include: true })
      expect(r.auth).toBe('Bearer sk-or-test')
    }
    // Event envelope: strictly increasing seq; runTotals attached once spend exists.
    events.forEach((e, i) => i && expect(e.seq).toBeGreaterThan(events[i - 1].seq))
    expect(events.at(-2)?.runTotals?.tokens).toBeGreaterThan(0)
  }, 90_000)

  it('enforces the budget cap: parallel requests share the allowance, partial synthesis, no overspend (D9)', async () => {
    fake.requests.length = 0
    const price = { prompt: 1e-5, completion: 1e-4 }
    const pricing = { 'fake/planner': price, 'fake/worker': price, 'fake/reviewer': price, 'fake/synth': price }
    Object.assign(fake.pricing, pricing) // the server reads this same object
    const cap = 0.02
    let events: AgentEvent[] = []
    try {
      events = await runToEnd(mgr, {
        config: baseConfig({ budgetCapUsd: cap }),
        pricing,
        onEvent: (e) => {
          approvePlan(mgr)(e)
          if (e.type === 'hitl_pause' && e.serverName === 'fs') void mgr.respondHitl({ runId: e.runId, agentId: e.agentId, approved: true, result: 'notes-content' })
        },
      })
    } finally {
      for (const key of Object.keys(fake.pricing)) delete fake.pricing[key]
    }
    const terminal = events.at(-1)!
    expect(terminal.type).toBe('task_complete')
    if (terminal.type !== 'task_complete') return
    expect(terminal.totalCostUsd).toBeLessThanOrEqual(cap)
    expect(events.some((e) => e.runTotals?.budgetReached)).toBe(true)
    expect(events.some((e) => e.type === 'agent_failed' && /budget/.test(e.reason))).toBe(true)
    // Every priced request was bounded by the remaining allowance.
    for (const r of fake.requests) expect(typeof r.body.max_tokens).toBe('number')
    const spent = fake.requests.reduce((sum, r) => sum + PROMPT_TOKENS * price.prompt + Math.min(r.body.max_tokens!, COMPLETION_TOKENS) * price.completion, 0)
    expect(spent).toBeLessThanOrEqual(cap + 1e-12)
  }, 90_000)

  it('rejects an over-cap plan and re-plans (spec §06), then honours a cancelled pre-flight', async () => {
    plannerCalls = 0
    planOverride = (body, attempt) => {
      if (attempt === 1) {
        return { content: JSON.stringify([1, 2, 3].map((n) => ({ id: `1.${n}`, label: `Step ${n}`, role: 'Analyst', phase: 1 }))) }
      }
      expect(JSON.stringify(body.messages)).toContain('the maximum is 2')
      return { content: JSON.stringify([{ id: '1.1', label: 'Merged A', role: 'Analyst', phase: 1 }, { id: '1.2', label: 'Merged B', role: 'Analyst', phase: 1 }]) }
    }
    try {
      const events = await runToEnd(mgr, {
        config: baseConfig({ maxAgents: 2 }),
        onEvent: (e) => {
          if (e.type === 'hitl_pause' && e.serverName === 'multi-agent') void mgr.respondHitl({ runId: e.runId, agentId: 'orchestrator', approved: false })
        },
      })
      const plan = events.find((e): e is Extract<AgentEvent, { type: 'orchestrator_plan' }> => e.type === 'orchestrator_plan')!
      expect(plannerCalls).toBe(2)
      expect(plan.steps.map((s) => s.label)).toEqual(['Merged A', 'Merged B'])
      expect(events.at(-1)).toMatchObject({ type: 'task_failed', reason: 'Plan not approved' })
      expect(events.some((e) => e.type === 'agent_start')).toBe(false)
    } finally {
      planOverride = null
    }
  }, 60_000)

  it('auto-denies an unanswered tool approval, fails only that agent, and still synthesizes (spec §07 timeout)', async () => {
    const events = await runToEnd(mgr, {
      config: baseConfig({ hitlTimeoutMs: 1_000 }),
      onEvent: approvePlan(mgr),
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'hitl_resume', agentId: '1.1', approved: false }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_failed', agentId: '1.1', reason: expect.stringMatching(/timed out/) }))
    expect(events.at(-1)?.type).toBe('task_complete')
  }, 60_000)

  it('aborts cleanly mid-run while an agent is paused (D8)', async () => {
    const events = await runToEnd(mgr, {
      onEvent: (e) => {
        approvePlan(mgr)(e)
        if (e.type === 'hitl_pause' && e.serverName === 'fs') void mgr.abortRun(e.runId)
      },
    })
    expect(events.at(-1)).toMatchObject({ type: 'task_failed', reason: 'Run aborted by user' })
    expect(mgr.getStatus()).toBe('running')
  }, 60_000)

  // ── Phase 0 measurements (specs/multi-agent-refinement.md) ─────────────────

  /** Plan the given steps; every Scout request is held open for `holdMs`. */
  async function timedRun(plan: Array<Record<string, unknown>>, opts: { config?: MultiAgentConfig; pricing?: Record<string, { prompt: number; completion: number }> } = {}): Promise<{ events: AgentEvent[]; windows: Array<{ start: number; end: number; label: string }> }> {
    fake.requests.length = 0
    planOverride = () => ({ content: JSON.stringify(plan) })
    replyOverride = (body) => (systemOf(body).includes('Scout agent') ? { content: `Findings for ${userOf(body).match(/Your subtask \(([\d.]+)\)/)?.[1]}: detailed results.`, delayMs: 300 } : undefined)
    try {
      const events = await runToEnd(mgr, { config: opts.config, pricing: opts.pricing, onEvent: approvePlan(mgr) })
      const windows = fake.requests
        .filter((r) => systemOf(r.body).includes('Scout agent'))
        .map((r) => ({ start: r.start, end: r.end, label: userOf(r.body).match(/Your subtask \(([\d.]+)\)/)?.[1] ?? '' }))
      return { events, windows }
    } finally {
      planOverride = null
      replyOverride = null
    }
  }
  const allOverlap = (w: Array<{ start: number; end: number }>): boolean => Math.max(...w.map((x) => x.start)) < Math.min(...w.map((x) => x.end))

  it('Test A: three independent steps in one phase run with overlapping request windows', async () => {
    const { events, windows } = await timedRun([1, 2, 3].map((n) => ({ id: `1.${n}`, label: `Look up source ${n}`, role: 'Scout', phase: 1 })))
    expect(events.at(-1)?.type).toBe('task_complete')
    expect(windows).toHaveLength(3)
    expect(allOverlap(windows)).toBe(true)
  }, 60_000)

  it('Test A (chain): a plan with one step per phase serialises — measured baseline', async () => {
    const { windows } = await timedRun([1, 2, 3].map((n) => ({ id: `${n}.1`, label: `Look up source ${n}`, role: 'Scout', phase: n })))
    expect(windows).toHaveLength(3)
    for (let i = 1; i < windows.length; i++) expect(windows[i].start).toBeGreaterThanOrEqual(windows[i - 1].end)
  }, 60_000)

  it('Test B: a cap just above one worst-case reservation — measured baseline', async () => {
    // 32,768-token clamp × 1e-6 ≈ $0.033 worst case per request; cap $0.04.
    const price = { prompt: 1e-7, completion: 1e-6 }
    const pricing = { 'fake/planner': price, 'fake/worker': price, 'fake/reviewer': price, 'fake/synth': price }
    Object.assign(fake.pricing, pricing)
    try {
      const { windows } = await timedRun([1, 2, 3].map((n) => ({ id: `1.${n}`, label: `Look up source ${n}`, role: 'Scout', phase: 1 })), { config: baseConfig({ budgetCapUsd: 0.04 }), pricing })
      expect(windows).toHaveLength(3)
      // Baseline: the first request reserves nearly the whole allowance, so the third waits.
      expect(allOverlap(windows)).toBe(false)
    } finally {
      for (const key of Object.keys(fake.pricing)) delete fake.pricing[key]
    }
  }, 60_000)

  it('Test C: each role\'s configured model reaches the wire', async () => {
    const { events } = await timedRun([{ id: '1.1', label: 'Look up source 1', role: 'Scout', phase: 1 }])
    expect(events.at(-1)?.type).toBe('task_complete')
    const modelsFor = (needle: string): string[] => [...new Set(fake.requests.filter((r) => systemOf(r.body).includes(needle)).map((r) => r.body.model))]
    expect(modelsFor('orchestrator of a team')).toEqual(['fake/planner'])
    expect(modelsFor('Scout agent')).toEqual(['fake/worker'])
    expect(modelsFor('strict reviewer')).toEqual(['fake/reviewer'])
    expect(modelsFor('synthesize')).toEqual(['fake/synth'])
  }, 60_000)

  it('requires the per-launch token on every endpoint', async () => {
    const port = (mgr as unknown as { port: number }).port
    const anonymous = await fetch(`http://127.0.0.1:${port}/health`)
    const wrong = await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-di-token': 'guess' } })
    expect(anonymous.status).toBe(401)
    expect(wrong.status).toBe(401)
  })

  it('fails the in-flight run and restarts after the sidecar crashes; stop() leaves no process (D8)', async () => {
    const waitFor = async (cond: () => boolean, ms: number): Promise<void> => {
      const end = Date.now() + ms
      while (!cond()) {
        if (Date.now() > end) throw new Error('timed out waiting')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const crashed = runToEnd(mgr, {
      onEvent: (e) => {
        if (e.type === 'hitl_pause' && e.serverName === 'multi-agent') {
          const pid = (mgr as unknown as { process: { pid: number } }).process.pid
          process.kill(pid, 'SIGKILL')
        }
      },
    })
    const events = await crashed
    expect(events.at(-1)).toMatchObject({ type: 'task_failed', reason: 'The multi-agent sidecar stopped unexpectedly' })
    await waitFor(() => mgr.getStatus() === 'running', 30_000)

    const pid = (mgr as unknown as { process: { pid: number } }).process.pid
    await mgr.stop()
    expect(() => process.kill(pid, 0)).toThrow()
  }, 90_000)
})
