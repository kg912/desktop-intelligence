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
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { AgentEvent, MultiAgentConfig } from '../../../shared/types'

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? '/tmp/di-sidecar-it-userdata' : '/tmp') },
}))

import { MultiAgentSidecarManager } from '../MultiAgentSidecarManager'
import { MultiAgentRunCoordinator } from '../MultiAgentRunCoordinator'
import { McpDeniedError, McpServerManager } from '../McpServerManager'
import { MultiAgentRunLogger, readRun, verifyRunDir } from '../MultiAgentRunLogger'
import type { CallRecord, RunLogMeta } from '../MultiAgentRunLogger'
import type { McpToolPermissionRequest } from '../../../shared/types'
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
  /** Streamed before content as both `delta.reasoning` and `delta.reasoning_details` (as OpenRouter does). */
  reasoning?: string
  /** Overrides the final chunk's finish_reason (e.g. "length"). */
  finishReason?: string
  /** Answer with this HTTP error instead of a stream. */
  httpError?: { status: number; message: string }
  /** Chunks carry this `model` (OpenRouter names the model that actually served the request). */
  servedModel?: string
}
type Body = {
  model: string
  messages: Array<{ role: string; content: string; tool_calls?: unknown[]; reasoning_details?: unknown[] }>
  reasoning?: { effort: string }
  tools?: Array<{ function: { name: string } }>
  max_tokens?: number
  stream?: boolean
  usage?: { include?: boolean }
}
interface FakeOpenRouter {
  url: string
  /** start/end: ms timestamps when the request body arrived and the response ended. */
  requests: Array<{ body: Body; auth: string | undefined; start: number; end: number; reply?: Reply }>
  pricing: Record<string, { prompt: number; completion: number }>
  close(): Promise<void>
}

const PROMPT_TOKENS = 100
const COMPLETION_TOKENS = 50

/** Claims contract (reflection hardening Phase 3): a worker's final answer ends with a ```claims block.
 *  The scripted answers here make no quoted claims, so the fake ends each with an empty one — the
 *  sidecar removes it from the output and the card, so the answers the tests see are unchanged. */
const NO_CLAIMS = '\n\n```claims\n[]\n```'
function withClaims(body: Body, reply: Reply): Reply {
  const worker = (body.messages[0]?.content ?? '').includes('agent in a multi-agent team')
  const final = !reply.toolCalls && !!reply.content?.trim() && !reply.content.includes('```claims') && !/DSML/.test(reply.content)
  return worker && final ? { ...reply, content: reply.content + NO_CLAIMS } : reply
}

function startFakeOpenRouter(route: (body: Body) => Reply): Promise<FakeOpenRouter> {
  const fake = { requests: [] as FakeOpenRouter['requests'], pricing: {} as FakeOpenRouter['pricing'] }
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as Body
      const record = { body, auth: req.headers.authorization, start: Date.now(), end: 0 }
      fake.requests.push(record)
      const reply = withClaims(body, route(body))
      Object.assign(record, { reply })
      if (reply.httpError) {
        record.end = Date.now()
        res.writeHead(reply.httpError.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: reply.httpError.message, code: reply.httpError.status } }))
        return
      }
      // Honour max_tokens like the real API does; cost from the fake price list.
      const completion = Math.min(body.max_tokens ?? COMPLETION_TOKENS, COMPLETION_TOKENS)
      const price = fake.pricing[body.model]
      const cost = price ? PROMPT_TOKENS * price.prompt + completion * price.completion : 0.001
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (obj: unknown): boolean => res.write(`data: ${JSON.stringify(reply.servedModel ? { model: reply.servedModel, ...(obj as object) } : obj)}\n\n`)
      res.write(': OPENROUTER PROCESSING\n\n')
      const stream = (): void => {
        for (const part of reply.reasoning?.match(/.{1,12}/gs) ?? []) {
          send({ choices: [{ index: 0, delta: { reasoning: part, reasoning_details: [{ type: 'reasoning.text', text: part, index: 0, format: 'unknown' }] } }] })
        }
        const text = reply.content ?? ''
        for (const part of text.match(/.{1,12}/gs) ?? []) send({ choices: [{ index: 0, delta: { content: part } }] })
        reply.toolCalls?.forEach((call, index) => {
          const half = Math.ceil(call.args.length / 2)
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args.slice(0, half) } }] } }] })
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: call.args.slice(half) } }] } }] })
        })
        send({
          choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? (reply.toolCalls ? 'tool_calls' : 'stop') }],
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
    if (toolResult) return { content: `Research found, from the notes file: ${toolResult.content}` }
    return {
      toolCalls: [
        { id: 'call_1', name: 'fs__read_file', args: '{"path": "/notes.txt"}' },
        { id: 'call_2', name: 'evil__exec', args: '{"cmd": "rm -rf /"}' },
      ],
    }
  }
  if (system.includes('Analyzer agent')) {
    return { content: userOf(body).includes('rejected') ? 'Analysis v2 — thorough, covering second-order effects.' : 'Analysis v1 — only the first-order effects.' }
  }
  return { content: 'ok' }
}

const TOOLS = [{ name: 'fs__read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]

const baseConfig = (overrides: Partial<MultiAgentConfig> = {}): MultiAgentConfig => ({
  maxAgents: 4,
  maxToolRounds: 6,
  budgetCapUsd: 10,
  models: { orchestrator: 'fake/planner', worker: 'fake/worker', reflection: 'fake/reviewer', synthesizer: 'fake/synth' },
  reflectionPassThreshold: 3,
  maxRetriesPerAgent: 2,
  hitlTimeoutMs: 60_000,
  requirePermissions: true,
  reasoningEffort: 'medium',
  ...overrides,
})

/** Start a run and collect its events until the terminal one; `onEvent` may respond to pauses. */
function runToEnd(
  mgr: MultiAgentSidecarManager,
  opts: { config?: MultiAgentConfig; pricing?: Record<string, { prompt: number; completion: number }>; noReasoning?: string[]; observe?: boolean; onEvent: (e: AgentEvent, all: AgentEvent[]) => void }
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
      .startRun({ chatId: 'chat-1', task: 'Explain X', config: opts.config ?? baseConfig(), tools: TOOLS, openRouterApiKey: 'sk-or-test', currentDateTime: 'Current date and time: Monday, October 5, 2026, 10:38 PM GMT+8.', pricing: opts.pricing, noReasoning: opts.noReasoning, observe: opts.observe })
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
    // Part D changed the wording to single chat's corrective error (buildUnregisteredToolMessage), asserted exactly.
    expect(secondResearcherRequest.body.messages.find((m) => (m as { tool_call_id?: string }).tool_call_id === 'call_2')?.content).toBe(
      'Tool request rejected: "evil__exec" is not registered in the tool schema for this session and cannot be called. '
      + 'Do not call it again. Registered tools for this session: fs__read_file.')

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

  const subtaskOf = (body: Body): string => userOf(body).match(/Your subtask \(([\d.]+)\)/)?.[1] ?? ''
  /** Plan the given steps; every Scout request is held open (300 ms unless `holdMs` says otherwise). */
  async function timedRun(
    plan: Array<Record<string, unknown>>,
    opts: { config?: MultiAgentConfig; pricing?: Record<string, { prompt: number; completion: number }>; holdMs?: (stepId: string) => number; onEvent?: (e: AgentEvent) => void; reply?: (body: Body) => Reply | undefined } = {}
  ): Promise<{ events: AgentEvent[]; windows: Array<{ start: number; end: number; label: string }> }> {
    fake.requests.length = 0
    plannerCalls = 0
    planOverride = () => ({ content: JSON.stringify(plan) })
    replyOverride = (body) =>
      opts.reply?.(body) ??
      (systemOf(body).includes('Scout agent')
        ? { content: `Findings for ${subtaskOf(body)}: detailed results with sources.`, delayMs: opts.holdMs?.(subtaskOf(body)) ?? 300 }
        : undefined)
    try {
      const events = await runToEnd(mgr, { config: opts.config, pricing: opts.pricing, onEvent: (e) => { approvePlan(mgr)(e); opts.onEvent?.(e) } })
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

  it('Test B: a cap just above one worst-case reservation still lets three agents overlap, within the cap', async () => {
    // 32,768-token clamp × 1e-6 ≈ $0.033 worst case per request; cap $0.04.
    const price = { prompt: 1e-7, completion: 1e-6 }
    const pricing = { 'fake/planner': price, 'fake/worker': price, 'fake/reviewer': price, 'fake/synth': price }
    Object.assign(fake.pricing, pricing)
    try {
      const { events, windows } = await timedRun([1, 2, 3].map((n) => ({ id: `1.${n}`, label: `Look up source ${n}`, role: 'Scout', phase: 1 })), { config: baseConfig({ budgetCapUsd: 0.04 }), pricing })
      expect(windows).toHaveLength(3)
      // Phase 0 baseline was false (the first request reserved nearly the whole
      // allowance and the third waited); parallel workers now split it.
      expect(allOverlap(windows)).toBe(true)
      const terminal = events.at(-1)!
      expect(terminal.type).toBe('task_complete')
      if (terminal.type === 'task_complete') expect(terminal.totalCostUsd).toBeLessThanOrEqual(0.04)
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
    // Phase 3: what the run used is emitted right after the plan and kept in the trace.
    const planIdx = events.findIndex((e) => e.type === 'orchestrator_plan')
    expect(events[planIdx + 1]).toMatchObject({
      type: 'run_config',
      models: { orchestrator: 'fake/planner', worker: 'fake/worker', reflection: 'fake/reviewer', synthesizer: 'fake/synth' },
      sources: { orchestrator: 'saved', worker: 'saved', reflection: 'saved', synthesizer: 'saved' },
      catalogueChecked: true, maxAgents: 4, budgetCapUsd: 10, reflectionPassThreshold: 3, maxRetriesPerAgent: 2, reasoningEffort: 'medium',
    })
  }, 60_000)

  it('the model OpenRouter served reaches the events as modelServed; absent when the stream reports none', async () => {
    const plain = await timedRun([{ id: '1.1', label: 'Look up source 1', role: 'Scout', phase: 1 }])
    expect(plain.events.at(-1)?.type).toBe('task_complete')
    expect(plain.events.filter((e) => 'modelServed' in e)).toEqual([])

    const { events } = await timedRun([{ id: '1.1', label: 'Look up source 1', role: 'Scout', phase: 1 }], {
      reply: (body) => {
        const system = systemOf(body)
        if (system.includes('Scout agent')) return { content: 'Findings for 1.1: detailed results with sources.', servedModel: 'other/scout-served' }
        if (system.includes('strict reviewer')) return { content: '{"score": 5, "reason": "solid"}', servedModel: 'fake/reviewer-20260101' }
        if (system.includes('synthesize')) return { content: 'Done [1.1].', servedModel: 'other/synth-served' }
        return undefined
      },
    })
    expect(events.find((e) => e.type === 'agent_complete')).toMatchObject({ modelServed: 'other/scout-served' })
    expect(events.find((e) => e.type === 'reflection_result')).toMatchObject({ model: 'fake/reviewer', modelServed: 'fake/reviewer-20260101' })
    expect(events.find((e) => e.type === 'task_complete')).toMatchObject({ modelServed: 'other/synth-served' })
    expect(events.find((e) => e.type === 'orchestrator_plan')).not.toHaveProperty('modelServed')
  }, 60_000)

  // ── Phase 1: dependency scheduling ─────────────────────────────────────────

  it('fan-out of three plus a dependent fourth: the fourth starts when its last dependency passes, not at a phase boundary', async () => {
    const plan = [
      { id: '1.1', label: 'Look up source 1', role: 'Scout', dependsOn: [] },
      { id: '1.2', label: 'Look up source 2', role: 'Scout', dependsOn: [] },
      { id: '1.3', label: 'Look up source 3', role: 'Scout', dependsOn: [] },
      { id: '2.1', label: 'Combine sources 1 and 2', role: 'Scout', dependsOn: ['1.1', '1.2'] },
    ]
    const { events, windows } = await timedRun(plan, { holdMs: (id) => (id === '1.3' ? 2_000 : 300) })
    expect(events.at(-1)?.type).toBe('task_complete')
    const w = Object.fromEntries(windows.map((x) => [x.label, x]))
    expect(allOverlap([w['1.1'], w['1.2'], w['1.3']])).toBe(true)
    expect(w['2.1'].start).toBeGreaterThanOrEqual(Math.max(w['1.1'].end, w['1.2'].end))
    expect(w['2.1'].start).toBeLessThan(w['1.3'].end) // did not wait for the slow sibling
    // The plan event carries the graph and the derived display phase.
    const planEvent = events.find((e): e is Extract<AgentEvent, { type: 'orchestrator_plan' }> => e.type === 'orchestrator_plan')!
    expect(planEvent.steps.map((s) => [s.id, s.dependsOn, s.phase])).toEqual([['1.1', [], 1], ['1.2', [], 1], ['1.3', [], 1], ['2.1', ['1.1', '1.2'], 2]])
    // Dependants only see their dependencies' outputs.
    const fourth = fake.requests.find((r) => subtaskOf(r.body) === '2.1')!
    expect(userOf(fourth.body)).toContain('Findings for 1.1')
    expect(userOf(fourth.body)).not.toContain('Findings for 1.3')
    // Every event carries a monotonic elapsedMs for the timeline.
    events.forEach((e, i) => i && expect(e.elapsedMs!).toBeGreaterThanOrEqual(events[i - 1].elapsedMs!))
  }, 60_000)

  it('a failed dependency fails its dependants and the rest of the run continues', async () => {
    const plan = [
      { id: '1.1', label: 'Look up source 1', role: 'Scout', dependsOn: [] },
      { id: '1.2', label: 'Look up source 2', role: 'Scout', dependsOn: [] },
      { id: '2.1', label: 'Use source 1', role: 'Scout', dependsOn: ['1.1'] },
      { id: '3.1', label: 'Use step 2.1', role: 'Scout', dependsOn: ['2.1'] },
    ]
    const { events } = await timedRun(plan, {
      config: baseConfig({ maxRetriesPerAgent: 0 }),
      holdMs: () => 50,
      reply: (body) => (systemOf(body).includes('strict reviewer') && userOf(body).includes('Findings for 1.1') ? { content: '{"score": 1, "reason": "wrong"}' } : undefined),
    })
    const failed = Object.fromEntries(events.filter((e): e is Extract<AgentEvent, { type: 'agent_failed' }> => e.type === 'agent_failed').map((e) => [e.agentId, e.reason]))
    expect(failed['2.1']).toBe('dependency 1.1 failed')
    expect(failed['3.1']).toBe('dependency 2.1 failed')
    expect(events.some((e) => e.type === 'agent_start' && (e.agentId === '2.1' || e.agentId === '3.1'))).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({ type: 'reflection_result', agentId: '1.2', passed: true }))
    expect(events.at(-1)?.type).toBe('task_complete')
  }, 60_000)

  it('a pure-chain plan triggers exactly one correction request, then is accepted', async () => {
    const { events } = await timedRun([1, 2].map((n) => ({ id: `${n}.1`, label: `Step ${n}`, role: 'Scout', dependsOn: n === 2 ? ['1.1'] : [] })))
    expect(plannerCalls).toBe(2)
    const planner = fake.requests.filter((r) => systemOf(r.body).includes('orchestrator of a team'))
    expect(JSON.stringify(planner[1].body.messages)).toContain('chainReason')
    expect(events.at(-1)?.type).toBe('task_complete')
  }, 60_000)

  it('abort cancels every running agent and the run\'s threads shut down', async () => {
    const port = (mgr as unknown as { port: number }).port
    const token = (mgr as unknown as { token: string }).token
    const health = async (): Promise<{ runs: number; threads: number }> =>
      (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-di-token': token } })).json() as Promise<{ runs: number; threads: number }>
    const before = (await health()).threads
    let started = 0
    const { events } = await timedRun([1, 2, 3].map((n) => ({ id: `1.${n}`, label: `Look up source ${n}`, role: 'Scout', dependsOn: [] })), {
      holdMs: () => 1_500,
      onEvent: (e) => {
        if (e.type === 'agent_start' && ++started === 3) setTimeout(() => void mgr.abortRun(e.runId), 100)
      },
    })
    expect(events.at(-1)).toMatchObject({ type: 'task_failed', reason: 'Run aborted by user' })
    expect(events.some((e) => e.type === 'agent_complete')).toBe(false)
    const deadline = Date.now() + 5_000
    let now = await health()
    while ((now.runs > 0 || now.threads > before) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      now = await health()
    }
    expect(now.runs).toBe(0)
    expect(now.threads).toBeLessThanOrEqual(before)
  }, 60_000)

  // ── Phase 2: trace fidelity ─────────────────────────────────────────────────

  /** One Scout that reasons, makes two tool calls, then answers. */
  async function tracedRun(opts: { config?: MultiAgentConfig; noReasoning?: string[]; reply?: (body: Body) => Reply | undefined } = {}): Promise<AgentEvent[]> {
    fake.requests.length = 0
    planOverride = () => ({ content: JSON.stringify([{ id: '1.1', label: 'Check the timetable', role: 'Scout', dependsOn: [] }]) })
    replyOverride = (body) => {
      const custom = opts.reply?.(body)
      if (custom) return custom
      if (!systemOf(body).includes('Scout agent')) return undefined
      const toolResults = body.messages.filter((m) => m.role === 'tool').length
      if (toolResults === 0) {
        return {
          reasoning: 'The user needs the Christmas Eve service. I should check both timetables first.',
          toolCalls: [
            { id: 'call_a', name: 'fs__read_file', args: '{"path": "/rail.txt"}' },
            { id: 'call_b', name: 'fs__read_file', args: '{"path": "/bus.txt"}' },
          ],
        }
      }
      return { content: 'Trains run hourly on 24 December until 18:00 [unverified for buses].' }
    }
    try {
      return await runToEnd(mgr, {
        config: opts.config,
        noReasoning: opts.noReasoning,
        onEvent: (e) => {
          approvePlan(mgr)(e)
          if (e.type === 'hitl_pause' && e.serverName === 'fs') {
            const approved = (e.args as { path: string }).path === '/rail.txt'
            void mgr.respondHitl({ runId: e.runId, agentId: e.agentId, approved, result: approved ? 'Railjet hourly until 18:00' : 'not allowed' })
          }
        },
      })
    } finally {
      planOverride = null
      replyOverride = null
    }
  }

  it('streams reasoning, two tool calls and the answer in order, and keeps reasoning out of output and synthesis', async () => {
    const events = await tracedRun()
    expect(events.at(-1)?.type).toBe('task_complete')
    const traced = events.filter((e) => 'agentId' in e && e.agentId === '1.1' && !e.type.startsWith('hitl'))
    const collapsed = traced.map((e) => e.type).filter((t, i, all) => !(i > 0 && all[i - 1] === t && (t === 'agent_reasoning' || t === 'agent_token')))
    expect(collapsed).toEqual(['agent_start', 'agent_reasoning', 'tool_start', 'tool_done', 'tool_start', 'tool_done', 'agent_token', 'agent_complete', 'reflection_start', 'reflection_result'])
    for (const e of traced) expect((e as { attempt?: number }).attempt).toBe(0)

    const reasoning = events.filter((e): e is Extract<AgentEvent, { type: 'agent_reasoning' }> => e.type === 'agent_reasoning').map((e) => e.token).join('')
    expect(reasoning).toBe('The user needs the Christmas Eve service. I should check both timetables first.') // once, not doubled

    const [startA, doneA, , doneB] = traced.filter((e) => e.type === 'tool_start' || e.type === 'tool_done') as Array<Extract<AgentEvent, { type: 'tool_start' | 'tool_done' }>>
    expect(startA).toMatchObject({ callId: 'call_a', tool: 'read_file', server: 'fs', argsPreview: '{"path": "/rail.txt"}' })
    expect(doneA).toMatchObject({ callId: 'call_a', ok: true, resultChars: expect.any(Number) })
    expect((doneA as Extract<AgentEvent, { type: 'tool_done' }>).resultPreview).toContain('Railjet hourly')
    expect(doneB).toMatchObject({ callId: 'call_b', ok: false, resultPreview: expect.stringContaining('denied') })

    const output = events.find((e): e is Extract<AgentEvent, { type: 'agent_complete' }> => e.type === 'agent_complete')!.output
    expect(output).not.toContain('Christmas Eve service')
    const scout = fake.requests.filter((r) => systemOf(r.body).includes('Scout agent'))
    expect(scout[0].body.reasoning).toEqual({ effort: 'medium' })
    // reasoning_details go back with the tool results, as OpenRouter requires.
    const assistant = scout[1].body.messages.find((m) => m.role === 'assistant')!
    expect(assistant.reasoning_details).toEqual([{ type: 'reasoning.text', text: 'The user needs the Christmas Eve service. I should check both timetables first.', index: 0, format: 'unknown' }])
    const synthesis = fake.requests.find((r) => systemOf(r.body).includes('synthesize'))!
    expect(JSON.stringify(synthesis.body.messages)).not.toContain('Christmas Eve service')
    // The reviewer judged against the tool evidence and reports its rubric and model.
    const review = fake.requests.find((r) => systemOf(r.body).includes('strict reviewer'))!
    expect(userOf(review.body)).toContain('fs__read_file')
    expect(userOf(review.body)).toContain('Railjet hourly')
    expect(events.find((e) => e.type === 'reflection_result')).toMatchObject({ model: 'fake/reviewer', rubric: expect.arrayContaining([expect.stringMatching(/tool evidence/)]), attempt: 0 })
  }, 60_000)

  it('sends no reasoning parameter when the effort is off or the catalogue says the model lacks it', async () => {
    await tracedRun({ config: baseConfig({ reasoningEffort: 'off' }) })
    expect(fake.requests.every((r) => r.body.reasoning === undefined)).toBe(true)
    await tracedRun({ noReasoning: ['fake/worker'] })
    expect(fake.requests.every((r) => r.body.reasoning === undefined)).toBe(true)
  }, 60_000)

  it('a failed gate retries with its issues injected; the retry trace carries attempt 1', async () => {
    let reviews = 0
    const events = await tracedRun({
      reply: (body) =>
        systemOf(body).includes('strict reviewer')
          ? { content: ++reviews === 1 ? '{"score": 2, "reason": "bus claim unverified", "issues": ["Verify the bus timetable"]}' : '{"score": 5, "reason": "ok", "issues": []}' }
          : undefined,
    })
    expect(events.find((e) => e.type === 'reflection_result')).toMatchObject({ passed: false, issues: ['Verify the bus timetable'] })
    const retryRequest = fake.requests.filter((r) => systemOf(r.body).includes('Scout agent')).find((r) => userOf(r.body).includes('rejected by the reviewer'))!
    expect(userOf(retryRequest.body)).toContain('Verify the bus timetable')
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { attempt: number }).attempt)).toEqual([0, 0, 1, 1])
    expect(events.at(-1)?.type).toBe('task_complete')
  }, 60_000)

  it('an unparsable verdict is retried once, then fails as "gate unavailable" — never a pass', async () => {
    const events = await tracedRun({
      config: baseConfig({ maxRetriesPerAgent: 0 }),
      reply: (body) => (systemOf(body).includes('strict reviewer') ? { content: 'Looks great to me!' } : undefined),
    })
    expect(fake.requests.filter((r) => systemOf(r.body).includes('strict reviewer'))).toHaveLength(2)
    expect(events.find((e) => e.type === 'reflection_result')).toMatchObject({ passed: false, score: 0, reason: 'gate unavailable' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_failed', agentId: '1.1' }))
  }, 60_000)

  it('the deterministic precheck fails an empty, short or refusal-only answer without calling the reviewer', async () => {
    for (const content of ['Too short.', "I'm sorry, but I can't help with planning that trip."]) {
      const events = await tracedRun({
        config: baseConfig({ maxRetriesPerAgent: 0 }),
        reply: (body) => (systemOf(body).includes('Scout agent') && body.messages.some((m) => m.role === 'tool') ? { content } : undefined),
      })
      expect(fake.requests.some((r) => systemOf(r.body).includes('strict reviewer'))).toBe(false)
      expect(events.find((e) => e.type === 'reflection_result')).toMatchObject({ passed: false, model: 'deterministic precheck' })
    }
  }, 60_000)

  // ── Repetition guard: a looping worker stream is aborted and retried ─────────

  const SKELETON = 'I hope this helps! Final Answer: Your final answer here\n'
  const scoutAnswer = (body: Body): boolean => systemOf(body).includes('Scout agent') && body.messages.some((m) => m.role === 'tool')
  const scoutAttempt = (body: Body): number => (userOf(body).includes('stuck repeating') ? 1 : 0)

  it('a content loop aborts the request, fails that attempt as "repetition loop", and the retry answers', async () => {
    const events = await tracedRun({
      reply: (body) => (scoutAnswer(body) && scoutAttempt(body) === 0 ? { content: 'Trains run hourly.\n' + SKELETON.repeat(400) } : undefined),
    })
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ agentId: '1.1', attempt: 1, reason: 'repetition loop' })
    // What it produced before the loop was caught stays in the trace, under attempt 0.
    const attempt0 = events.filter((e) => e.type === 'agent_token' && e.attempt === 0).map((e) => (e as { token: string }).token).join('')
    expect(attempt0.startsWith('Trains run hourly.\n' + SKELETON.repeat(3))).toBe(true)
    expect(attempt0.length).toBeLessThan(('Trains run hourly.\n' + SKELETON.repeat(400)).length)
    // The looping attempt is never reviewed or completed; the retry is.
    expect(events.filter((e) => e.type === 'agent_complete').map((e) => (e as { attempt: number }).attempt)).toEqual([1])
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { attempt: number }).attempt)).toEqual([0, 0, 1, 1])
    expect(events.at(-1)?.type).toBe('task_complete')
  }, 60_000)

  it('a reasoning loop is caught the same way; with no retries left the agent fails with "repetition loop"', async () => {
    const events = await tracedRun({
      config: baseConfig({ maxRetriesPerAgent: 0 }),
      reply: (body) => (scoutAnswer(body) ? { reasoning: 'Let me double-check the buses. '.repeat(200), content: 'never reached' } : undefined),
    })
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(events.find((e) => e.type === 'agent_failed')).toMatchObject({ agentId: '1.1', reason: 'repetition loop', attempt: 0 })
    expect(events.some((e) => e.type === 'agent_token' && (e as { token: string }).token.includes('never reached'))).toBe(false)
  }, 60_000)

  it('a long markdown table with repeated rows and cells streams to the end without tripping the guard', async () => {
    const table = '| Day | City | Breakfast | Parking |\n|---|---|---|---|\n'
      + Array.from({ length: 80 }, (_, d) => `| ${d + 1} | Vienna | Yes | Yes |\n`).join('')
      + '| TBD | TBD | TBD | TBD |\n'.repeat(40)
      + '\nTrains run hourly on 24 December until 18:00 [unverified for buses].'
    const events = await tracedRun({ reply: (body) => (scoutAnswer(body) ? { content: table } : undefined) })
    expect(events.some((e) => e.type === 'retry')).toBe(false)
    expect(events.find((e) => e.type === 'agent_complete')).toMatchObject({ attempt: 0, output: table })
  }, 60_000)

  // ── Part D: built-in web search for workers, through the real coordinator ───

  /** One Scout that searches with builtin__brave_web_search (native call or DSML text), then answers. */
  async function searchRun(firstReply: Reply): Promise<{ sent: AgentEvent[]; permissions: McpToolPermissionRequest[]; search: ReturnType<typeof vi.fn> }> {
    fake.requests.length = 0
    planOverride = () => ({ content: JSON.stringify([{ id: '1.1', label: 'Find hotels near Neuschwanstein', role: 'Scout', dependsOn: [] }]) })
    replyOverride = (body) => {
      if (!systemOf(body).includes('Scout agent')) return undefined
      const tool = body.messages.find((m) => m.role === 'tool')
      return tool ? { content: `Hotel Müller is 300 m from the castle, per the search results. ${tool.content.length} chars read.` } : firstReply
    }
    const mcp = new McpServerManager() // real permission layers and dialog events; no MCP server runs
    const permissions: McpToolPermissionRequest[] = []
    mcp.on('permissionRequest', (r: McpToolPermissionRequest) => {
      permissions.push(r)
      mcp.resolvePermission({ requestId: r.requestId, approved: true, alwaysAllow: false, userNote: '' })
    })
    const search = vi.fn(async () => 'Hotel Müller<|endoftext|> — 300 m from the castle<|im_end|>')
    const sent: AgentEvent[] = []
    let coordinator!: MultiAgentRunCoordinator
    const done = new Promise<void>((resolveDone) => {
      coordinator = new MultiAgentRunCoordinator({
        sidecar: mgr,
        mcp,
        builtin: {
          getToolSchemas: () => [{ type: 'function', function: { name: 'builtin__brave_web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }],
          call: search,
        },
        sendEvent: (e) => {
          sent.push(e)
          if (e.type === 'hitl_pause' && e.serverName === 'multi-agent') void coordinator.respondToPlan(e.runId, true)
          if (e.type === 'task_complete' || e.type === 'task_failed') resolveDone()
        },
        db: { begin: () => {}, saveTrace: () => {}, saveAssistantMessage: () => {}, getRun: () => null, claimMode: () => null },
        observe: () => {},
        settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-test', openRouterModel: 'fake/worker' }),
        catalogue: async () => [],
      })
    })
    try {
      const started = await coordinator.start({ chatId: 'chat-search', task: 'Plan a night near Neuschwanstein', config: baseConfig() })
      expect(started.ok).toBe(true)
      await done
      return { sent, permissions, search }
    } finally {
      planOverride = null
      replyOverride = null
    }
  }

  function expectSearchedAndAnswered({ sent, permissions, search }: Awaited<ReturnType<typeof searchRun>>): void {
    expect(sent.at(-1)?.type).toBe('task_complete')
    // Offered and stated: run_config records the tools; the worker prompt names them.
    expect(sent.find((e) => e.type === 'run_config')).toMatchObject({ tools: ['builtin__brave_web_search'] })
    const workerPrompts = fake.requests.filter((r) => systemOf(r.body).includes('Scout agent'))
    expect(systemOf(workerPrompts[0].body)).toContain('Your tools: builtin__brave_web_search.')
    expect(workerPrompts[0].body.tools?.map((t) => t.function.name)).toEqual(['builtin__brave_web_search'])
    // Event order for the worker: start → tool_start → approval pause → resume → tool_done → answer.
    const order = sent.filter((e) => 'agentId' in e && e.agentId === '1.1' && e.type !== 'agent_token' && e.type !== 'agent_reasoning').map((e) => e.type)
    expect(order.slice(0, 6)).toEqual(['agent_start', 'tool_start', 'hitl_pause', 'hitl_resume', 'tool_done', 'agent_complete'])
    expect(sent.find((e) => e.type === 'tool_start')).toMatchObject({ tool: 'brave_web_search', server: 'builtin', argsPreview: '{"query": "hotels near Neuschwanstein"}' })
    expect(sent.find((e) => e.type === 'hitl_pause' && e.agentId === '1.1')).toMatchObject({ serverName: 'builtin', toolName: 'brave_web_search', args: { query: 'hotels near Neuschwanstein' } })
    // Approval path: the permission dialog carried the agent's identity; then Electron ran the search.
    expect(permissions).toHaveLength(1)
    expect(permissions[0]).toMatchObject({ serverName: 'builtin', toolName: 'brave_web_search', agent: { agentId: '1.1', role: 'Scout', model: 'fake/worker' } })
    expect(search).toHaveBeenCalledWith('brave_web_search', { query: 'hotels near Neuschwanstein' })
    // Sanitised like single chat: no EOS tokens reach the model or the trace. Since the claims contract
    // (reflection hardening Phase 3) the model's copy is headed by the call id, so the worker can cite it.
    const start = sent.find((e) => e.type === 'tool_start') as Extract<AgentEvent, { type: 'tool_start' }>
    const toolMessage = workerPrompts[1].body.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toBe(`[callId: ${start.callId}]\nHotel Müller — 300 m from the castle`)
    expect(sent.find((e) => e.type === 'tool_done')).toMatchObject({ ok: true, resultPreview: 'Hotel Müller — 300 m from the castle', resultChars: 36 })
    // The card row: the renderer pairs tool_done with tool_start by callId and attempt (MultiAgentUI.test renders it).
    expect(sent.find((e) => e.type === 'tool_done')).toMatchObject({ callId: start.callId, attempt: start.attempt, agentId: '1.1' })
  }

  it('Part D: a worker calls builtin__brave_web_search natively — approval, Electron execution, sanitised result, card row', async () => {
    const run = await searchRun({ toolCalls: [{ id: 'call_s', name: 'builtin__brave_web_search', args: '{"query": "hotels near Neuschwanstein"}' }] })
    expectSearchedAndAnswered(run)
  }, 60_000)

  it('Part D: DeepSeek DSML tool calls in content run the same way and raw DSML never reaches the card or the answer', async () => {
    const dsml = 'Let me search.<｜DSML｜tool_calls>\n<｜DSML｜invoke name="builtin__brave_web_search">\n'
      + '<｜DSML｜parameter name="query" string="true">hotels near Neuschwanstein</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>'
    const run = await searchRun({ content: dsml })
    expectSearchedAndAnswered(run)
    const streamed = run.sent.filter((e) => e.type === 'agent_token').map((e) => (e as { token: string }).token).join('')
    expect(streamed).not.toMatch(/DSML/)
    expect(streamed).toContain('Let me search.')
    expect(run.sent.find((e) => e.type === 'agent_complete')).toMatchObject({ output: expect.stringMatching(/^Hotel Müller is 300 m/) })
  }, 60_000)

  // ── Part F: output limits ───────────────────────────────────────────────────

  async function limitRun(opts: { pricing?: Record<string, { prompt: number; completion: number; contextLength?: number }>; scout?: (body: Body) => Reply; synth?: Reply }): Promise<AgentEvent[]> {
    fake.requests.length = 0
    planOverride = () => ({ content: JSON.stringify([{ id: '1.1', label: 'Draft the 12-day itinerary', role: 'Scout', dependsOn: [] }]) })
    replyOverride = (body) => {
      if (systemOf(body).includes('Scout agent')) return opts.scout?.(body) ?? { content: 'Day 1: Vienna. Day 2: Salzburg. A long itinerary follows here.' }
      if (systemOf(body).includes('synthesize') && opts.synth) return opts.synth
      return undefined
    }
    try {
      return await runToEnd(mgr, { pricing: opts.pricing as never, onEvent: approvePlan(mgr) })
    } finally {
      planOverride = null
      replyOverride = null
    }
  }
  const scoutRequests = (): Body[] => fake.requests.filter((r) => systemOf(r.body).includes('Scout agent')).map((r) => r.body)
  const synthRequest = (): Body => fake.requests.find((r) => systemOf(r.body).includes('synthesize'))!.body

  it('Part F: no fixed caps — priced requests are bounded by the remaining context window, far above 32,768 / 2,000', async () => {
    const price = { prompt: 1e-9, completion: 1e-9, contextLength: 200_000 }
    const pricing = { 'fake/planner': price, 'fake/worker': price, 'fake/reviewer': price, 'fake/synth': price }
    fake.pricing = pricing
    try {
      const events = await limitRun({ pricing })
      expect(events.at(-1)?.type).toBe('task_complete')
      // window − 1.25 × the prompt estimate (exact formula asserted in resources/python/test_plan_request.py;
      // the sidecar measures Python's json.dumps, a few chars longer than JSON.stringify).
      for (const body of [scoutRequests()[0], synthRequest()]) {
        const prompt = Math.ceil(JSON.stringify(body.messages).length / 4)
        expect(body.max_tokens!).toBeLessThanOrEqual(200_000 - Math.ceil(prompt * 1.25))
        expect(body.max_tokens!).toBeGreaterThan(200_000 - Math.ceil(prompt * 1.25) - 50)
      }
    } finally {
      fake.pricing = {}
    }
  }, 60_000)

  it('Part F: unpriced models get no max_tokens at all', async () => {
    const events = await limitRun({})
    expect(events.at(-1)?.type).toBe('task_complete')
    expect(fake.requests.length).toBeGreaterThan(3)
    expect(fake.requests.filter((r) => 'max_tokens' in r.body)).toEqual([])
  }, 60_000)

  it('Part F: finish_reason "length" marks the agent and the synthesis as cut off, saying which limit', async () => {
    const price = { prompt: 1e-6, completion: 1e-5, contextLength: 1_000_000 } // budget binds before the window
    const pricing = { 'fake/worker': price, 'fake/synth': price }
    fake.pricing = pricing
    try {
      const events = await limitRun({
        pricing,
        scout: () => ({ content: 'Day 1: Vienna. Day 2: Salzburg. Day 3: Hallst', finishReason: 'length' }),
        synth: { content: 'Itinerary: Vienna [1.1], Salzburg [1.1], Hallst', finishReason: 'length' },
      })
      expect(events.find((e) => e.type === 'agent_complete')).toMatchObject({ agentId: '1.1', truncated: 'budget' })
      expect(events.at(-1)).toMatchObject({ type: 'task_complete', truncated: 'budget' })
      // Unpriced (no max_tokens sent): the model's own window ended it.
      fake.pricing = {}
      const unpriced = await limitRun({ scout: () => ({ content: 'Day 1: Vienna. Day 2: Salzburg. Day 3: Hallst', finishReason: 'length' }) })
      expect(unpriced.find((e) => e.type === 'agent_complete')).toMatchObject({ truncated: 'context' })
      expect(unpriced.at(-1)).not.toHaveProperty('truncated')
    } finally {
      fake.pricing = {}
    }
  }, 60_000)

  it('Part F: a context-length error from the API is a clear agent failure, not a generic error', async () => {
    const events = await limitRun({
      scout: () => ({ httpError: { status: 400, message: "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens." } }),
    })
    expect(events.find((e) => e.type === 'agent_failed')).toMatchObject({
      agentId: '1.1',
      reason: "Context window exceeded for fake/worker: This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens.",
    })
    // A non-context provider error keeps the generic HTTP wording.
    const other = await limitRun({ scout: () => ({ httpError: { status: 502, message: 'upstream unavailable' } }) })
    expect(other.find((e) => e.type === 'agent_failed')).toMatchObject({ reason: 'OpenRouter HTTP 502: upstream unavailable' })
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

// ── Observability spec Phase 1: call records ────────────────────────────────

interface ObsRecord {
  kind: 'model' | 'tool'
  seq: number
  role: string
  agentId: string | null
  attempt: number
  toolRound: number
  model?: string
  request?: { messages: unknown[]; params: Record<string, unknown>; headers: Record<string, string> }
  response?: { content: string; reasoning: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; finishReason: string | null }
  usage?: { promptTokens: number; completionTokens: number; costUsd: number }
  timing: { startedAt: number; endedAt: number; ms: number }
  callId?: string
  name?: string
  args?: string
  result?: string | null
  approved?: boolean
  denied?: boolean
  error?: unknown
}

describe.skipIf(!ENABLED)('observability: sidecar call records (spec Phase 1)', () => {
  let fake: FakeOpenRouter
  let mgr: MultiAgentSidecarManager
  const records: ObsRecord[] = []

  beforeAll(async () => {
    fake = await startFakeOpenRouter(scenario)
    mgr = new MultiAgentSidecarManager({ healthIntervalMs: 60_000 })
    mgr.configure({ scriptPath: SCRIPT, workspaceDir: mkdtempSync(join(tmpdir(), 'di-sidecar-obs-')), pythonPath: PYTHON, openRouterBaseUrl: fake.url })
    mgr.on('obsRecord', ({ record }: { record: ObsRecord }) => records.push(record))
    await mgr.start()
  }, 60_000)

  afterAll(async () => {
    await mgr?.stop()
    await fake?.close()
  })

  /** The default scenario: planner, Researcher with a tool round (one allowed, one unregistered tool), Analyzer rejected once, synthesis. */
  const defaultRun = (observe: boolean): Promise<AgentEvent[]> =>
    runToEnd(mgr, {
      observe,
      onEvent: (e) => {
        approvePlan(mgr)(e)
        if (e.type === 'hitl_pause' && e.serverName === 'fs') void mgr.respondHitl({ runId: e.runId, agentId: e.agentId, approved: true, result: 'notes-content' })
      },
    })

  it('records every model call with the exact request the server received and the content it streamed', async () => {
    fake.requests.length = 0
    records.length = 0
    plannerCalls = 0
    const events = await defaultRun(true)
    expect(events.at(-1)?.type).toBe('task_complete')
    const calls = records.filter((r) => r.kind === 'model')
    expect(calls).toHaveLength(fake.requests.length)

    for (const sent of fake.requests) {
      const { messages, ...params } = sent.body as unknown as Record<string, unknown>
      // Byte-equal: same JSON text for messages and for the remaining parameters.
      const match = calls.find((c) => JSON.stringify(c.request!.messages) === JSON.stringify(messages) && JSON.stringify(c.request!.params) === JSON.stringify(params))
      expect(match, `no record for a ${String(params.model)} request`).toBeDefined()
      expect(match!.response!.content).toBe(sent.reply?.content ?? '')
      expect(match!.response!.toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.arguments }))).toEqual(sent.reply?.toolCalls ?? [])
      expect(match!.response!.finishReason).toBe(sent.reply?.toolCalls ? 'tool_calls' : 'stop')
      expect(match!.usage).toMatchObject({ promptTokens: PROMPT_TOKENS, completionTokens: COMPLETION_TOKENS, costUsd: 0.001 })
      expect(match!.request!.headers.Authorization).toBe('[redacted]')
      expect(match!.timing.endedAt).toBeGreaterThanOrEqual(match!.timing.startedAt)
    }

    // Roles and identities, one record per call (reflection retries and the Analyzer's second attempt are separate).
    const roles = calls.map((c) => c.role)
    expect(roles.filter((r) => r === 'planner')).toHaveLength(1)
    expect(roles.filter((r) => r === 'synthesis')).toHaveLength(1)
    expect(calls.filter((c) => c.role === 'worker' && c.agentId === '1.1').map((c) => c.toolRound).sort()).toEqual([0, 1])
    expect(calls.filter((c) => c.role === 'worker' && c.agentId === '1.2').map((c) => c.attempt).sort()).toEqual([0, 1])
    expect(calls.filter((c) => c.role === 'reflection' && c.agentId === '1.2').map((c) => c.attempt).sort()).toEqual([0, 1])
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i + 1))

    // Tool records: full args and result; the unregistered tool is a rejection, not a denial.
    const tools = records.filter((r) => r.kind === 'tool')
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: '1.1', callId: 'call_1', name: 'fs__read_file', args: '{"path": "/notes.txt"}', result: 'notes-content', approved: true, denied: false, error: null }),
      expect.objectContaining({ agentId: '1.1', callId: 'call_2', name: 'evil__exec', args: '{"cmd": "rm -rf /"}', approved: false, denied: false, error: expect.stringContaining('not registered') }),
    ]))

    // No credential anywhere in what was recorded.
    expect(JSON.stringify(records)).not.toContain('sk-or-test')
  }, 90_000)

  it('with observe off (the default), the sidecar records nothing', async () => {
    records.length = 0
    plannerCalls = 0
    const events = await defaultRun(false)
    expect(events.at(-1)?.type).toBe('task_complete')
    expect(records).toEqual([])
  }, 90_000)

  /** One run through the real sidecar, the real coordinator and a real run logger; returns the run directory. */
  async function loggedRun(opts: { denyTools?: boolean; toolText?: string; secrets?: string[] } = {}): Promise<{ dir: string; runMd: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'di-runlog-it-'))
    const logger = new MultiAgentRunLogger(root, { secrets: () => ['sk-or-test', ...(opts.secrets ?? [])] })
    let coordinator!: MultiAgentRunCoordinator
    fake.requests.length = 0
    plannerCalls = 0
    const done = new Promise<void>((resolveDone) => {
      coordinator = new MultiAgentRunCoordinator({
        sidecar: mgr,
        mcp: {
          getMultiAgentExclusions: () => [],
          getToolSchemasForMultiAgent: () => [{ type: 'function', function: { name: 'fs__read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } }],
          callToolForMultiAgent: async () => {
            if (opts.denyTools) throw new McpDeniedError('not now')
            return { text: opts.toolText ?? 'notes-content', images: [], userNote: '' }
          },
          callBuiltinForMultiAgent: async () => ({ text: '', images: [], userNote: '' }),
          clearRunTrust: () => {},
          cancelRunPermissions: () => {},
        } as unknown as ConstructorParameters<typeof MultiAgentRunCoordinator>[0]['mcp'],
        builtin: { getToolSchemas: () => [], call: async () => '' },
        sendEvent: (e) => {
          if (e.type === 'hitl_pause' && e.serverName === 'multi-agent') void coordinator.respondToPlan(e.runId, true)
          if (e.type === 'task_complete' || e.type === 'task_failed') resolveDone()
        },
        db: { begin: () => {}, saveTrace: () => {}, saveAssistantMessage: () => {}, getRun: () => null, claimMode: () => null },
        observe: (_chat, e) => logger.event(e),
        runLog: { enabled: () => true, begin: (run) => logger.begin({ ...run, chatTitle: 'IT chat' }), record: (runId, r) => logger.record(runId, r as CallRecord) },
        settings: () => ({ backendProvider: 'openrouter', openRouterApiKey: 'sk-or-test', openRouterModel: 'fake/worker' }),
        catalogue: async () => [],
      })
    })
    const started = await coordinator.start({ chatId: 'chat-obs', task: 'Explain X', config: baseConfig() })
    expect(started.ok).toBe(true)
    await done
    const dir = logger.runDir('chat-obs', started.ok ? started.runId : '')
    const end = Date.now() + 10_000
    while (!(JSON.parse(readFileSync(join(dir, 'run.meta.json'), 'utf8')) as RunLogMeta).summary && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    return { dir, root, runMd: readFileSync(join(dir, 'run.md'), 'utf8') }
  }

  /** The bullet lines of run.md's Anomalies section. */
  const anomaliesOf = (runMd: string): string[] => runMd.split('## Anomalies')[1].split('## Files')[0].split('\n').filter((l) => l.startsWith('- '))

  it('Phase 2: real sidecar → real coordinator → real run logger produces the section 4 tree with every call', async () => {
    const { dir, root } = await loggedRun()
    expect(readdirSync(dir).sort()).toEqual([
      'agent-1.1.jsonl', 'agent-1.1.md', 'agent-1.2.jsonl', 'agent-1.2.md', 'events.jsonl',
      'planner.jsonl', 'planner.md', 'run.md', 'run.meta.json', 'synthesis.jsonl', 'synthesis.md',
    ])
    const { meta, records } = await readRun(dir)
    expect(meta.status).toBe('completed')
    expect(records.filter((r) => r.kind === 'model')).toHaveLength(fake.requests.length)
    expect(records.filter((r) => r.kind === 'tool').map((r) => r.result)).toContain('notes-content')
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('sk-or-test')
    const synthesis = readFileSync(join(dir, 'synthesis.md'), 'utf8')
    expect(synthesis).toContain('The topic is X [1.1] and it implies Y [1.2].') // raw answer
    expect(synthesis).toContain('Analysis v2') // the prompt carries every agent output as received
    rmSync(root, { recursive: true, force: true })
  }, 90_000)

  // ── Phase 3: seeded faults each appear in run.md's anomalies; totals reconcile ──

  it('Phase 3: the default run reconciles, and its retry and rejected tool are anomalies', async () => {
    const { runMd, root } = await loggedRun()
    const anomalies = anomaliesOf(runMd)
    expect(anomalies.some((l) => l.includes('**retry**') && l.includes('agent 1.2 retried'))).toBe(true)
    expect(anomalies.some((l) => l.includes('**tool_rejected**') && l.includes('evil__exec'))).toBe(true)
    expect(anomalies.some((l) => l.includes('**reconciliation**'))).toBe(false)
    expect(runMd).toContain('Reconciled with the run\'s own totals.')
    rmSync(root, { recursive: true, force: true })
  }, 90_000)

  it('Phase 3: forced finish_reason "length" on the synthesis is an anomaly', async () => {
    replyOverride = (body) => (systemOf(body).includes('synthesize') ? { content: 'Cut short', finishReason: 'length' } : undefined)
    try {
      const { runMd, root } = await loggedRun()
      expect(anomaliesOf(runMd).some((l) => l.includes('**length**') && l.includes('synthesis') && l.includes('synthesis.md#call-'))).toBe(true)
      rmSync(root, { recursive: true, force: true })
    } finally {
      replyOverride = null
    }
  }, 90_000)

  it('Phase 3: forced fallback — OpenRouter serves a different model than requested — is an anomaly', async () => {
    replyOverride = (body) => (systemOf(body).includes('Analyzer agent') ? { content: 'Analysis v2 — thorough, covering second-order effects.', servedModel: 'other/served-instead' } : undefined)
    try {
      const { runMd, root } = await loggedRun()
      expect(anomaliesOf(runMd).some((l) => l.includes('**served_model_differs**') && l.includes('`fake/worker`') && l.includes('`other/served-instead`'))).toBe(true)
      rmSync(root, { recursive: true, force: true })
    } finally {
      replyOverride = null
    }
  }, 90_000)

  it('Phase 3: forced fallback plan — the planner never returns a usable plan — is an anomaly, with each re-ask', async () => {
    planOverride = () => ({ content: 'no plan here' })
    try {
      const { runMd, root } = await loggedRun()
      const anomalies = anomaliesOf(runMd)
      expect(anomalies.some((l) => l.includes('**fallback_plan**'))).toBe(true)
      expect(anomalies.filter((l) => l.includes('planner re-asked'))).toHaveLength(3)
      rmSync(root, { recursive: true, force: true })
    } finally {
      planOverride = null
    }
  }, 90_000)

  it('Phase 3: forced repetition loop and a denied tool are anomalies', async () => {
    replyOverride = (body) => (systemOf(body).includes('Analyzer agent') && !userOf(body).includes('stuck') ? { content: 'Start.\n' + 'Final Answer: Your final answer here\n'.repeat(50) } : undefined)
    try {
      const { runMd, root } = await loggedRun({ denyTools: true })
      const anomalies = anomaliesOf(runMd)
      expect(anomalies.some((l) => l.includes('**repetition**') && l.includes('worker 1.2 attempt 0'))).toBe(true)
      expect(anomalies.some((l) => l.includes('**tool_denied**') && l.includes('fs__read_file'))).toBe(true)
      rmSync(root, { recursive: true, force: true })
    } finally {
      replyOverride = null
    }
  }, 90_000)

  // ── Phase 5: the audit repeated end to end ──

  it('Phase 5: a scripted run passes the checker — every timeline call has a full record, links resolve, totals reconcile, no key anywhere', async () => {
    const braveKey = 'BSA-test-brave-key-0123456789'
    const { dir, root } = await loggedRun({ toolText: `notes-content (fetched with ${braveKey})`, secrets: [braveKey] })
    expect(await verifyRunDir(dir, ['sk-or-test', braveKey])).toEqual([])
    // The whole log tree, not just this run's files.
    const grep = spawnSync('grep', ['-rl', '-e', 'sk-or-test', '-e', braveKey, root], { encoding: 'utf8' })
    expect([grep.status, grep.stdout]).toEqual([1, '']) // grep: 1 = searched everything, no match
    rmSync(root, { recursive: true, force: true })
  }, 90_000)

  it('an HTTP error is recorded with its status and finish reason "error"', async () => {
    records.length = 0
    replyOverride = (body) => (systemOf(body).includes('synthesize') ? { httpError: { status: 500, message: 'upstream down' } } : undefined)
    try {
      plannerCalls = 0
      await defaultRun(true)
    } finally {
      replyOverride = null
    }
    const synth = records.find((r) => r.kind === 'model' && r.role === 'synthesis')!
    expect(synth.response!.finishReason).toBe('error')
    expect(synth.error).toMatchObject({ httpStatus: 500, message: expect.stringContaining('upstream down') })
    expect(synth.request!.messages.length).toBeGreaterThan(0)
  }, 90_000)
})
