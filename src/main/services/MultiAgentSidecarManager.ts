/**
 * Owns the multi-agent sidecar process (MULTI_AGENT_SPEC.html §03, §08
 * "Sidecar Lifecycle"). The sidecar reasons and emits AgentEvents; it never
 * receives a host shell or an MCP transport — Electron is the authority for
 * tools, permissions, persistence and UI.
 *
 * Reliability contract:
 *  - launched through SandboxService (only openrouter.ai reachable, loopback
 *    bind allowed) with a per-launch auth token, so a stale or foreign
 *    process on the port can never be mistaken for ours;
 *  - port conflicts fall back to a free port;
 *  - health-checked every 10 s; crashes and hung processes are killed and
 *    restarted with backoff;
 *  - every run ALWAYS ends with exactly one terminal event (task_complete /
 *    task_failed) — synthesized here when the sidecar or its stream dies;
 *  - the sidecar exits on stdin EOF, so it cannot outlive Electron (DoD D8).
 */
import { EventEmitter } from 'events'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'
import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { quote } from 'shell-quote'
import type {
  AgentEvent,
  HitlResponse,
  MultiAgentStartPayload,
  SidecarStatus,
  StartRunResult,
  TaskFailedEvent,
} from '../../shared/types'
import type { ModelPricing } from '../../shared/multiAgentModels'
import { isTerminalAgentEvent, parseAgentEvent } from '../../shared/agentEvents'
import type { SandboxRunSpec } from './sandbox/types'
import { memoryWatch } from './sandbox/ResourceGovernor'

export const DEFAULT_SIDECAR_PORT = 7823
const HEALTH_INTERVAL_MS = 10_000
const HEALTH_FAILURES_BEFORE_RESTART = 2
const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000
const ABORT_GRACE_MS = 5_000
const STREAM_LOSS_GRACE_MS = 250
const KILL_GRACE_MS = 3_000
const RESTART_BASE_DELAY_MS = 2_000
const RESTART_MAX_DELAY_MS = 30_000
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000
const SIDECAR_MAX_RSS_MB = 1024
const OPENROUTER_DOMAIN = 'openrouter.ai'

export interface SidecarLaunchConfig {
  scriptPath: string
  workspaceDir: string
  /** Packaged pinned requirements; enables the private userData venv. */
  requirementsPath?: string
  /** Preferred port (spec default 7823); a busy port falls back to a free one. */
  port?: number
  /** Test-only: point the sidecar at a local OpenRouter fake. */
  openRouterBaseUrl?: string
  /** Explicit interpreter with the requirements installed (tests/dev); skips the venv bootstrap. */
  pythonPath?: string
}

export interface RunStartRequest extends MultiAgentStartPayload {
  openRouterApiKey: string
  pricing?: Record<string, ModelPricing>
}

type FetchFn = typeof fetch
export type SidecarSpawnFn = (spec: SandboxRunSpec) => Promise<ChildProcessWithoutNullStreams>

export interface MultiAgentSidecarManagerOptions {
  fetchFn?: FetchFn
  /** Defaults to SandboxService.spawnPersistent — the sidecar always runs sandboxed. */
  spawnSidecar?: SidecarSpawnFn
  healthIntervalMs?: number
  findPort?: (preferred: number) => Promise<number>
  /** RSS watchdog registration (ResourceGovernor.memoryWatch in production). */
  watchMemory?: (pid: number, maxRssMb: number, onExceeded: () => void) => () => void
}

interface RunState {
  chatId: string
  lastSeq: number
  terminal: boolean
  aborting: boolean
  controller: AbortController
  awaitingPlanApproval: boolean
}

/** First free port, preferring `preferred`. */
export function findFreePort(preferred: number): Promise<number> {
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer()
      server.unref()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const bound = typeof address === 'object' && address ? address.port : port
        server.close(() => resolve(bound))
      })
    })
  return tryListen(preferred).catch(() => tryListen(0))
}

export class MultiAgentSidecarManager extends EventEmitter {
  private status: SidecarStatus = 'stopped'
  private process: ChildProcessWithoutNullStreams | null = null
  private stopMemoryWatch: (() => void) | null = null
  private launchConfig: SidecarLaunchConfig | null = null
  private port = DEFAULT_SIDECAR_PORT
  private token = ''
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private healthFailures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAttempts = 0
  private startPromise: Promise<void> | null = null
  private runtimeSetup: Promise<string> | null = null
  private stopping = false
  private readonly runs = new Map<string, RunState>()
  private readonly fetchFn: FetchFn
  private readonly spawnSidecar: SidecarSpawnFn
  private readonly healthIntervalMs: number
  private readonly findPort: (preferred: number) => Promise<number>
  private readonly watchMemory: NonNullable<MultiAgentSidecarManagerOptions['watchMemory']>

  constructor(options: MultiAgentSidecarManagerOptions = {}) {
    super()
    this.fetchFn = options.fetchFn ?? fetch
    this.spawnSidecar =
      options.spawnSidecar ??
      (async (spec) => (await import('./sandbox/sandboxServiceInstance')).sandboxService.spawnPersistent(spec))
    this.healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS
    this.findPort = options.findPort ?? findFreePort
    this.watchMemory = options.watchMemory ?? memoryWatch
  }

  configure(config: SidecarLaunchConfig): void {
    this.launchConfig = { ...config, port: config.port ?? DEFAULT_SIDECAR_PORT }
  }

  getStatus(): SidecarStatus {
    return this.status
  }

  getChatId(runId: string): string | undefined {
    return this.runs.get(runId)?.chatId
  }

  /** Only the renderer's pre-flight screen may answer the plan-approval pause. */
  isAwaitingPlanApproval(runId: string): boolean {
    return this.runs.get(runId)?.awaitingPlanApproval === true
  }

  private setStatus(next: SidecarStatus): void {
    if (this.status === next) return
    this.status = next
    this.emit('status', next)
  }

  // ── Process lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.status === 'running' && this.process) return
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null
      })
    }
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    if (!this.launchConfig) throw new Error('Multi-agent sidecar has not been configured')
    this.stopping = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.setStatus('starting')
    const config = this.launchConfig
    try {
      mkdirSync(config.workspaceDir, { recursive: true })
      const python = await this.ensurePythonRuntime()
      this.port = await this.findPort(config.port ?? DEFAULT_SIDECAR_PORT)
      if (this.port !== config.port) {
        console.warn(`[Sidecar] port ${config.port} is in use — using ${this.port}`)
      }
      this.token = randomBytes(32).toString('hex')
      const proc = await this.spawnSidecar({
        workspaceDir: config.workspaceDir,
        // Fixed, app-controlled paths only (sandbox spec §08).
        command: quote([python, '-u', config.scriptPath]),
        executionProfile: 'lightweight',
        allowedDomains: [OPENROUTER_DOMAIN],
        allowLocalBinding: true,
        allowWrite: [config.workspaceDir],
        denyRead: [],
        callerLabel: 'multi-agent-sidecar',
        env: {
          DI_MULTI_AGENT_PORT: String(this.port),
          DI_MULTI_AGENT_TOKEN: this.token,
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUNBUFFERED: '1',
          ...(config.openRouterBaseUrl ? { DI_OPENROUTER_BASE_URL: config.openRouterBaseUrl } : {}),
        },
        timeoutMs: 0,
        maxRssMb: SIDECAR_MAX_RSS_MB,
      })
      this.process = proc
      proc.stdout.on('data', (chunk: Buffer) => console.log(`[Sidecar] ${chunk.toString().trimEnd()}`))
      proc.stderr.on('data', (chunk: Buffer) => console.warn(`[Sidecar] ${chunk.toString().trimEnd()}`))
      proc.once('exit', (code, signal) => this.handleExit(proc, code, signal))
      if (proc.pid) {
        this.stopMemoryWatch = this.watchMemory(proc.pid, SIDECAR_MAX_RSS_MB, () => {
          console.warn(`[Sidecar] RSS exceeded ${SIDECAR_MAX_RSS_MB} MB — restarting`)
          void this.recover('Multi-agent sidecar exceeded its memory limit and was restarted')
        })
      }
      await this.waitForHealth(proc)
      this.healthFailures = 0
      this.restartAttempts = 0
      this.setStatus('running')
      this.startHealthLoop()
    } catch (err) {
      await this.killProcess()
      this.setStatus('error')
      throw err
    }
  }

  /**
   * A packaged app cannot assume FastAPI/LangGraph are installed globally.
   * Build a private venv in the sidecar workspace without touching the
   * system interpreter. A stamp of the requirements' hash is written only
   * after a successful install, so an interrupted or outdated venv is
   * (re)installed instead of failing at every launch.
   */
  private ensurePythonRuntime(): Promise<string> {
    if (this.launchConfig?.pythonPath) return Promise.resolve(this.launchConfig.pythonPath)
    const requirementsPath = this.launchConfig?.requirementsPath
    if (!requirementsPath) return Promise.resolve('python3')
    if (!this.runtimeSetup) {
      this.runtimeSetup = this.createPythonRuntime(requirementsPath).catch((err) => {
        this.runtimeSetup = null // allow a retry on the next start
        throw err
      })
    }
    return this.runtimeSetup
  }

  private async createPythonRuntime(requirementsPath: string): Promise<string> {
    const venvDir = join(this.launchConfig!.workspaceDir, 'venv')
    const python = join(venvDir, 'bin', 'python')
    const stampPath = join(venvDir, '.requirements-sha256')
    const wanted = createHash('sha256').update(readFileSync(requirementsPath)).digest('hex')
    const stamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : ''
    if (existsSync(python) && stamp === wanted) return python

    console.log('[Sidecar] preparing private Python runtime (first multi-agent run only)…')
    if (!existsSync(python)) await this.runBootstrapCommand('python3', ['-m', 'venv', venvDir])
    await this.runBootstrapCommand(python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', requirementsPath,
    ])
    writeFileSync(stampPath, wanted)
    return python
  }

  // Package names are app-pinned constants, not model output — outside the
  // sandbox threat model (same boundary as the Python worker's yfinance install).
  private runBootstrapCommand(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'pipe' })
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`Multi-agent runtime setup timed out: ${command} ${args.join(' ')}`))
      }, BOOTSTRAP_TIMEOUT_MS)
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`Multi-agent runtime setup failed (${code ?? 'signal'}): ${stderr.trim().slice(-600)}`))
      })
    })
  }

  private async waitForHealth(proc: ChildProcessWithoutNullStreams): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    let lastError: unknown
    while (Date.now() < deadline) {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`Multi-agent sidecar exited during startup (${proc.exitCode ?? proc.signalCode})`)
      }
      try {
        const response = await this.request('/health', { method: 'GET' })
        if (response.ok) return
        lastError = new Error(`HTTP ${response.status}`)
      } catch (err) {
        lastError = err
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(
      `Multi-agent sidecar health check timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`
    )
  }

  private startHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => {
      this.request('/health', { method: 'GET' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          this.healthFailures = 0
        })
        .catch((err) => {
          this.healthFailures++
          console.warn(`[Sidecar] health check failed (${this.healthFailures}):`, err)
          if (this.healthFailures >= HEALTH_FAILURES_BEFORE_RESTART) {
            void this.recover('Multi-agent sidecar stopped responding and was restarted')
          }
        })
    }, this.healthIntervalMs)
    this.healthTimer.unref?.()
  }

  private handleExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (proc !== this.process) return // an old, already-replaced process
    this.process = null
    proc.stdin.destroy() // close our end so nothing can hold the pipe open
    this.clearProcessWatchers()
    if (this.stopping) return
    console.warn(`[Sidecar] exited unexpectedly (${code ?? signal})`)
    this.failActiveRuns('The multi-agent sidecar stopped unexpectedly')
    this.setStatus('error')
    this.scheduleRestart()
  }

  /** Kill a crashed/hung/oversized sidecar, fail its runs, restart with backoff. */
  private async recover(reason: string): Promise<void> {
    if (this.stopping) return
    this.failActiveRuns(reason)
    this.setStatus('error')
    await this.killProcess()
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return
    const delay = Math.min(RESTART_MAX_DELAY_MS, RESTART_BASE_DELAY_MS * 2 ** this.restartAttempts)
    this.restartAttempts++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch((err) => {
        console.warn('[Sidecar] restart failed:', err)
        this.scheduleRestart()
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearProcessWatchers(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    this.stopMemoryWatch?.()
    this.stopMemoryWatch = null
  }

  private async killProcess(): Promise<void> {
    const proc = this.process
    this.process = null
    this.clearProcessWatchers()
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        proc.kill('SIGKILL')
        resolve()
      }, KILL_GRACE_MS)
      proc.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      proc.stdin.end() // the sidecar's watchdog exits on EOF, even through the sandbox wrapper
      proc.kill('SIGTERM')
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.failActiveRuns('Desktop Intelligence is shutting down')
    await this.killProcess()
    this.setStatus('stopped')
  }

  // ── Runs ────────────────────────────────────────────────────────────────

  async startRun(request: RunStartRequest): Promise<StartRunResult> {
    if (!request.openRouterApiKey) {
      return { ok: false, reason: 'OpenRouter API key is not configured — add it in Settings → Backend' }
    }
    try {
      await this.start()
    } catch (err) {
      return { ok: false, reason: `Multi-agent sidecar unavailable: ${err instanceof Error ? err.message : String(err)}` }
    }
    const runId = randomUUID()
    try {
      const response = await this.request('/run', {
        method: 'POST',
        body: JSON.stringify({ runId, ...request, pricing: request.pricing ?? {} }),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return { ok: false, reason: `Sidecar rejected the run (HTTP ${response.status}) ${detail.slice(0, 200)}`.trim() }
      }
    } catch (err) {
      return { ok: false, reason: `Could not reach the multi-agent sidecar: ${err instanceof Error ? err.message : String(err)}` }
    }
    this.runs.set(runId, {
      chatId: request.chatId,
      lastSeq: 0,
      terminal: false,
      aborting: false,
      controller: new AbortController(),
      awaitingPlanApproval: false,
    })
    this.emit('runStarted', { runId, chatId: request.chatId })
    void this.streamRun(runId)
    return { ok: true, runId }
  }

  async respondHitl(response: HitlResponse): Promise<void> {
    const result = await this.request(`/run/${encodeURIComponent(response.runId)}/hitl`, {
      method: 'POST',
      body: JSON.stringify(response),
    })
    if (!result.ok) throw new Error(`Sidecar HITL response failed (${result.status})`)
  }

  async abortRun(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run || run.terminal) return
    run.aborting = true
    const fallback = setTimeout(() => this.finishRun(runId, 'Run aborted by user'), ABORT_GRACE_MS)
    fallback.unref?.()
    try {
      const result = await this.request(`/run/${encodeURIComponent(runId)}`, { method: 'DELETE' })
      if (!result.ok) this.finishRun(runId, 'Run aborted by user')
    } catch {
      this.finishRun(runId, 'Run aborted by user')
    }
  }

  private async streamRun(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (!run) return
    try {
      const response = await this.fetchFn(`${this.baseUrl()}/run/${encodeURIComponent(runId)}/stream`, {
        headers: { accept: 'text/event-stream', 'x-di-token': this.token },
        signal: run.controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`event stream failed (HTTP ${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        pending += decoder.decode(next.value, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() ?? ''
        for (const frame of frames) this.handleSseFrame(runId, frame)
      }
    } catch (err) {
      if (!run.controller.signal.aborted) console.warn(`[Sidecar] event stream ${runId} failed:`, err)
    } finally {
      if (!run.terminal) {
        if (run.aborting) this.finishRun(runId, 'Run aborted by user')
        // A dying process usually drops the socket just before its 'exit'
        // event; give handleExit() the chance to report the real cause.
        else setTimeout(() => this.finishRun(runId, 'Lost connection to the multi-agent sidecar'), STREAM_LOSS_GRACE_MS).unref?.()
      }
    }
  }

  private handleSseFrame(runId: string, frame: string): void {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data) return
    let event: AgentEvent
    try {
      event = parseAgentEvent(JSON.parse(data))
    } catch (err) {
      console.warn('[Sidecar] dropped invalid SSE AgentEvent:', err)
      return
    }
    this.deliver(runId, event)
  }

  private deliver(runId: string, event: AgentEvent): void {
    const run = this.runs.get(runId)
    if (!run || run.terminal || event.runId !== runId || event.seq <= run.lastSeq) return
    run.lastSeq = event.seq
    if (event.type === 'hitl_pause' && event.serverName === 'multi-agent') run.awaitingPlanApproval = true
    if ((event.type === 'hitl_resume' && event.agentId === 'orchestrator') || isTerminalAgentEvent(event)) {
      run.awaitingPlanApproval = false
    }
    if (isTerminalAgentEvent(event)) run.terminal = true
    this.emit('event', event)
    if (run.terminal) {
      run.controller.abort()
      this.runs.delete(runId)
    }
  }

  /** Emit a synthetic terminal event for a run the sidecar can no longer finish. */
  private finishRun(runId: string, reason: string): void {
    const run = this.runs.get(runId)
    if (!run || run.terminal) return
    const event: TaskFailedEvent = {
      runId,
      seq: run.lastSeq + 1,
      ts: Date.now(),
      type: 'task_failed',
      reason,
      partialOutputs: {},
    }
    this.deliver(runId, event)
  }

  private failActiveRuns(reason: string): void {
    for (const runId of [...this.runs.keys()]) this.finishRun(runId, reason)
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await this.fetchFn(`${this.baseUrl()}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-di-token': this.token, ...(init.headers ?? {}) },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

export const multiAgentSidecar = new MultiAgentSidecarManager()
