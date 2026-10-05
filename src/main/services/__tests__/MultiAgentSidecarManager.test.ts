import { EventEmitter } from 'events'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { findFreePort, MultiAgentSidecarManager } from '../MultiAgentSidecarManager'
import type { RunStartRequest } from '../MultiAgentSidecarManager'
import { DEFAULT_MULTI_AGENT_CONFIG } from '../../../shared/types'
import type { AgentEvent } from '../../../shared/types'
import type { SandboxRunSpec } from '../sandbox/types'

// Unit level: fake sandbox spawn + fake HTTP. The real process/sandbox path is
// covered by MultiAgentSidecar.integration.test.ts.

const request: RunStartRequest = {
  chatId: 'chat-1', task: 'Summarise', config: DEFAULT_MULTI_AGENT_CONFIG, tools: [], openRouterApiKey: 'sk-or-test', currentDateTime: 'Current date and time: x.',
}

interface FakeChild extends EventEmitter {
  pid: number
  exitCode: number | null
  signalCode: string | null
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
  exit: (code?: number | null) => void
}

function fakeChild(pid = 4242): FakeChild {
  const proc = new EventEmitter() as FakeChild
  proc.pid = pid
  proc.exitCode = null
  proc.signalCode = null
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { end: vi.fn(), destroy: vi.fn() }
  proc.exit = (code = 0) => {
    proc.exitCode = code
    proc.emit('exit', code, null)
  }
  proc.kill = vi.fn(() => queueMicrotask(() => proc.exit(null)))
  return proc
}

/** An SSE response whose frames the test pushes. */
function sseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c } })
  const enc = new TextEncoder()
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (event: Partial<AgentEvent> & { type: string; seq: number }) =>
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ runId: 'run-x', ts: 1, ...event })}\n\n`)),
    raw: (text: string) => controller.enqueue(enc.encode(text)),
    close: () => controller.close(),
    error: () => controller.error(new Error('socket reset')),
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Harness {
  mgr: MultiAgentSidecarManager
  child: FakeChild
  spawn: ReturnType<typeof vi.fn>
  fetchFn: ReturnType<typeof vi.fn>
  stream: ReturnType<typeof sseStream>
  events: AgentEvent[]
  calls: Array<{ url: string; init: RequestInit }>
}

function harness(): Harness {
  const child = fakeChild()
  const spawn = vi.fn(async (_spec: SandboxRunSpec) => child)
  const stream = sseStream()
  const calls: Harness['calls'] = []
  const fetchFn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const path = new URL(url).pathname
    if (path === '/health') return json({ ok: true })
    if (path === '/run' && init.method === 'POST') return json({ runId: JSON.parse(String(init.body)).runId })
    if (path.endsWith('/stream')) return stream.response
    if (path.endsWith('/hitl')) return json({ ok: true })
    if (init.method === 'DELETE') return json({ ok: true })
    return json({}, 404)
  })
  const mgr = new MultiAgentSidecarManager({
    fetchFn: fetchFn as unknown as typeof fetch,
    spawnSidecar: spawn as never,
    findPort: async (p) => p,
    watchMemory: () => () => {},
    healthIntervalMs: 60_000,
  })
  mgr.configure({ scriptPath: '/app/multi_agent_sidecar.py', workspaceDir: mkdtempSync(join(tmpdir(), 'ma-mgr-')), pythonPath: '/venv/bin/python' })
  const events: AgentEvent[] = []
  mgr.on('event', (e: AgentEvent) => events.push(e))
  return { mgr, child, spawn, fetchFn, stream, events, calls }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** Start a run and rewrite streamed frames to its real run id. */
async function startRun(h: Harness): Promise<string> {
  const result = await h.mgr.startRun(request)
  if (!result.ok) throw new Error(result.reason)
  const push = h.stream.push
  h.stream.push = (e) => push({ ...e, runId: result.runId } as never)
  return result.runId
}

describe('MultiAgentSidecarManager — launch', () => {
  it('launches through the sandbox: fixed command, OpenRouter-only network, loopback bind, token env', async () => {
    const h = harness()
    await h.mgr.start()
    const spec = h.spawn.mock.calls[0][0] as SandboxRunSpec
    expect(spec.command).toBe("/venv/bin/python -u /app/multi_agent_sidecar.py")
    expect(spec.allowedDomains).toEqual(['openrouter.ai'])
    expect(spec.allowLocalBinding).toBe(true)
    expect(spec.executionProfile).toBe('lightweight')
    expect(spec.env).toMatchObject({ DI_MULTI_AGENT_PORT: '7823', PYTHONDONTWRITEBYTECODE: '1' })
    expect(spec.env!.DI_MULTI_AGENT_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    // The API key is never part of the launch environment.
    expect(JSON.stringify(spec)).not.toContain('sk-or')
    // Health checks carry the token.
    const health = h.calls.find((c) => c.url.endsWith('/health'))!
    expect((health.init.headers as Record<string, string>)['x-di-token']).toBe(spec.env!.DI_MULTI_AGENT_TOKEN)
    expect(h.mgr.getStatus()).toBe('running')
    await h.mgr.stop()
  })

  it('deduplicates concurrent starts', async () => {
    const h = harness()
    await Promise.all([h.mgr.start(), h.mgr.start(), h.mgr.start()])
    expect(h.spawn).toHaveBeenCalledTimes(1)
    await h.mgr.stop()
  })

  it('fails fast (status error) when the process exits during startup', async () => {
    const h = harness()
    h.fetchFn.mockImplementation(async () => { throw new Error('ECONNREFUSED') })
    h.spawn.mockImplementation(async () => {
      queueMicrotask(() => h.child.exit(1))
      return h.child
    })
    await expect(h.mgr.start()).rejects.toThrow(/exited during startup/)
    expect(h.mgr.getStatus()).toBe('error')
  })

  it('refuses a run without an OpenRouter key and never starts the sidecar for it', async () => {
    const h = harness()
    const result = await h.mgr.startRun({ ...request, openRouterApiKey: '' })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/API key/) })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('passes the key and pricing per run in the POST body', async () => {
    const h = harness()
    await h.mgr.startRun({ ...request, pricing: { 'm/x': { prompt: 1e-6, completion: 2e-6 } } })
    const post = h.calls.find((c) => c.url.endsWith('/run'))!
    expect(JSON.parse(String(post.init.body))).toMatchObject({ openRouterApiKey: 'sk-or-test', pricing: { 'm/x': { prompt: 1e-6, completion: 2e-6 } } })
    await h.mgr.stop()
  })
})

describe('MultiAgentSidecarManager — event stream', () => {
  let h: Harness
  beforeEach(() => { h = harness() })
  afterEach(async () => { await h.mgr.stop() })

  it('delivers validated events in order, drops invalid and duplicate frames', async () => {
    const runId = await startRun(h)
    h.stream.push({ type: 'agent_start', seq: 1, agentId: '1.1', role: 'R', model: 'm' } as never)
    h.stream.raw('data: {"not":"an event"}\n\n')
    h.stream.push({ type: 'agent_start', seq: 1, agentId: '1.1', role: 'R', model: 'm' } as never) // duplicate seq
    h.stream.push({ type: 'agent_token', seq: 2, agentId: '1.1', token: 'hi' } as never)
    await tick(20)
    expect(h.events.map((e) => [e.runId, e.type, e.seq])).toEqual([[runId, 'agent_start', 1], [runId, 'agent_token', 2]])
    expect(h.mgr.getChatId(runId)).toBe('chat-1')
  })

  it('tracks the pending plan approval so only it can be answered by the renderer', async () => {
    const runId = await startRun(h)
    expect(h.mgr.isAwaitingPlanApproval(runId)).toBe(false)
    h.stream.push({ type: 'hitl_pause', seq: 1, agentId: 'orchestrator', role: 'Orchestrator', toolName: 'approve_plan', serverName: 'multi-agent', args: {} } as never)
    await tick(20)
    expect(h.mgr.isAwaitingPlanApproval(runId)).toBe(true)
    h.stream.push({ type: 'hitl_resume', seq: 2, agentId: 'orchestrator', approved: true } as never)
    await tick(20)
    expect(h.mgr.isAwaitingPlanApproval(runId)).toBe(false)
  })

  it('forgets a run after its terminal event', async () => {
    const runId = await startRun(h)
    h.stream.push({ type: 'task_complete', seq: 1, finalOutput: 'x', totalCostUsd: 0, totalTokens: 0 } as never)
    await tick(20)
    expect(h.events.at(-1)?.type).toBe('task_complete')
    expect(h.mgr.getChatId(runId)).toBeUndefined()
  })

  it('synthesizes exactly one task_failed when the stream drops without a terminal event', async () => {
    const runId = await startRun(h)
    h.stream.push({ type: 'agent_start', seq: 4, agentId: '1.1', role: 'R', model: 'm' } as never)
    await tick(10)
    h.stream.error()
    await tick(400)
    const terminal = h.events.filter((e) => e.type === 'task_failed')
    expect(terminal).toHaveLength(1)
    expect(terminal[0]).toMatchObject({ runId, seq: 5, reason: 'Lost connection to the multi-agent sidecar' })
  })

  it('reports a process crash (not a stream loss) and schedules a restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const runId = await startRun(h)
      h.child.exit(137)
      await vi.advanceTimersByTimeAsync(10)
      expect(h.events.filter((e) => e.type === 'task_failed')).toEqual([
        expect.objectContaining({ runId, reason: 'The multi-agent sidecar stopped unexpectedly' }),
      ])
      expect(h.mgr.getStatus()).toBe('error')
      expect(h.child.stdin.destroy).toHaveBeenCalled()

      const replacement = fakeChild(5151)
      h.spawn.mockResolvedValue(replacement)
      await vi.advanceTimersByTimeAsync(2_500)
      expect(h.spawn).toHaveBeenCalledTimes(2)
      expect(h.mgr.getStatus()).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts after two consecutive failed health checks, killing the hung process first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const hung = harness()
    try {
      ;(hung.mgr as unknown as { healthIntervalMs: number }).healthIntervalMs = 1_000
      await hung.mgr.start()
      hung.fetchFn.mockImplementation(async (url: string) => {
        if (url.endsWith('/health')) throw new Error('timeout')
        return json({})
      })
      await vi.advanceTimersByTimeAsync(2_100)
      expect(hung.child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(hung.child.stdin.end).toHaveBeenCalled()
      expect(hung.mgr.getStatus()).toBe('error')
    } finally {
      await hung.mgr.stop()
      vi.useRealTimers()
    }
  })

  it('abort: DELETE is sent and the sidecar-delivered terminal event is used', async () => {
    const runId = await startRun(h)
    await h.mgr.abortRun(runId)
    expect(h.calls.some((c) => c.init.method === 'DELETE' && c.url.endsWith(`/run/${runId}`))).toBe(true)
    h.stream.push({ type: 'task_failed', seq: 1, reason: 'Run aborted by user' } as never)
    await tick(20)
    expect(h.events.filter((e) => e.type === 'task_failed')).toHaveLength(1)
  })

  it('abort: falls back to a local terminal event when the sidecar cannot be reached', async () => {
    const runId = await startRun(h)
    h.fetchFn.mockImplementation(async (_url: string, init: RequestInit = {}) => {
      if (init.method === 'DELETE') throw new Error('ECONNREFUSED')
      return json({})
    })
    await h.mgr.abortRun(runId)
    expect(h.events).toEqual([expect.objectContaining({ type: 'task_failed', reason: 'Run aborted by user' })])
  })

  it('stop() fails active runs and terminates the process via stdin EOF + SIGTERM', async () => {
    const runId = await startRun(h)
    await h.mgr.stop()
    expect(h.events).toEqual([expect.objectContaining({ runId, type: 'task_failed', reason: 'Desktop Intelligence is shutting down' })])
    expect(h.child.stdin.end).toHaveBeenCalled()
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(h.mgr.getStatus()).toBe('stopped')
  })
})

describe('findFreePort', () => {
  it('returns the preferred port when free and another port when it is taken', async () => {
    const { createServer } = await import('net')
    const preferred = await findFreePort(0)
    expect(await findFreePort(preferred)).toBe(preferred)
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(preferred, '127.0.0.1', () => r()))
    try {
      const other = await findFreePort(preferred)
      expect(other).not.toBe(preferred)
      expect(other).toBeGreaterThan(0)
    } finally {
      blocker.close()
    }
  })
})
