/**
 * Owns the trusted, loopback-only multi-agent sidecar. The sidecar may reason
 * and emit requests, but never receives a host shell or an MCP transport.
 * Electron is the authority for tools, permissions, persistence and UI.
 */
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { quote } from 'shell-quote'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { AgentEvent, HitlResponse, MultiAgentStartPayload, SidecarStatus, StartRunResult } from '../../shared/types'
import { parseAgentEvent } from '../../shared/agentEvents'
import { sandboxService } from './sandbox/sandboxServiceInstance'

const DEFAULT_PORT = 7823
const HEALTH_INTERVAL_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
const RESTART_DELAY_MS = 2_000

export interface SidecarLaunchConfig {
  scriptPath: string
  workspaceDir: string
  openRouterApiKey: string
  port?: number
}

type FetchFn = typeof fetch
type SpawnFn = typeof sandboxService.spawnPersistent

export interface MultiAgentSidecarManagerOptions {
  fetchFn?: FetchFn
  spawnPersistent?: SpawnFn
  healthIntervalMs?: number
}

export class MultiAgentSidecarManager extends EventEmitter {
  private status: SidecarStatus = 'stopped'
  private process: ChildProcessWithoutNullStreams | null = null
  private launchConfig: SidecarLaunchConfig | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly streams = new Map<string, AbortController>()
  private readonly runChats = new Map<string, string>()
  private stopping = false
  private readonly fetchFn: FetchFn
  private readonly spawnPersistent: SpawnFn
  private readonly healthIntervalMs: number

  constructor(options: MultiAgentSidecarManagerOptions = {}) {
    super()
    this.fetchFn = options.fetchFn ?? fetch
    this.spawnPersistent = options.spawnPersistent ?? sandboxService.spawnPersistent.bind(sandboxService)
    this.healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS
  }

  configure(config: SidecarLaunchConfig): void {
    this.launchConfig = { ...config, port: config.port ?? DEFAULT_PORT }
  }

  getStatus(): SidecarStatus {
    return this.status
  }

  getChatId(runId: string): string | undefined {
    return this.runChats.get(runId)
  }

  private setStatus(next: SidecarStatus): void {
    if (this.status === next) return
    this.status = next
    this.emit('status', next)
  }

  private baseUrl(): string {
    const port = this.launchConfig?.port ?? DEFAULT_PORT
    return `http://127.0.0.1:${port}`
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return
    if (!this.launchConfig) throw new Error('Multi-agent sidecar has not been configured')
    if (!this.launchConfig.openRouterApiKey) throw new Error('OpenRouter API key is required for multi-agent mode')

    this.stopping = false
    this.setStatus('starting')
    mkdirSync(this.launchConfig.workspaceDir, { recursive: true })
    const command = quote(['python3', this.launchConfig.scriptPath])

    try {
      this.process = await this.spawnPersistent({
        workspaceDir: this.launchConfig.workspaceDir,
        command,
        executionProfile: 'lightweight',
        allowedDomains: ['openrouter.ai'],
        allowWrite: [this.launchConfig.workspaceDir],
        denyRead: [],
        callerLabel: 'multi-agent-sidecar',
        env: {
          OPENROUTER_API_KEY: this.launchConfig.openRouterApiKey,
          DI_MULTI_AGENT_PORT: String(this.launchConfig.port ?? DEFAULT_PORT),
          DI_MULTI_AGENT_WORKSPACE: this.launchConfig.workspaceDir,
        },
        timeoutMs: 0,
        maxRssMb: 768,
      })
      this.process.stdout.on('data', (chunk: Buffer) => console.log(`[Sidecar] ${chunk.toString().trimEnd()}`))
      this.process.stderr.on('data', (chunk: Buffer) => console.warn(`[Sidecar] ${chunk.toString().trimEnd()}`))
      this.process.once('exit', (code) => this.handleExit(code))
      await this.waitForHealth()
      this.setStatus('running')
      this.startHealthLoop()
    } catch (err) {
      this.setStatus('error')
      throw err
    }
  }

  async startRun(payload: MultiAgentStartPayload): Promise<StartRunResult> {
    try {
      await this.start()
      if (this.status !== 'running') return { ok: false, reason: 'sidecar_unavailable' }
      const runId = randomUUID()
      const response = await this.request(`/run`, {
        method: 'POST',
        body: JSON.stringify({ runId, ...payload }),
      })
      if (!response.ok) return { ok: false, reason: `sidecar_error:${response.status}` }
      const body = await response.json() as { runId?: string }
      const actualRunId = body.runId ?? runId
      this.runChats.set(actualRunId, payload.chatId)
      this.emit('runStarted', { runId: actualRunId, chatId: payload.chatId })
      void this.streamRun(actualRunId)
      return { ok: true, runId: actualRunId }
    } catch (err) {
      console.warn('[Sidecar] startRun failed:', err)
      return { ok: false, reason: err instanceof Error ? err.message : 'sidecar_unavailable' }
    }
  }

  async respondHitl(response: HitlResponse): Promise<void> {
    const result = await this.request(`/run/${encodeURIComponent(response.runId)}/hitl`, {
      method: 'POST', body: JSON.stringify(response),
    })
    if (!result.ok) throw new Error(`Sidecar HITL response failed (${result.status})`)
  }

  async abortRun(runId: string): Promise<void> {
    this.streams.get(runId)?.abort()
    this.streams.delete(runId)
    this.runChats.delete(runId)
    const result = await this.request(`/run/${encodeURIComponent(runId)}`, { method: 'DELETE' })
    if (!result.ok && result.status !== 404) throw new Error(`Sidecar abort failed (${result.status})`)
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    for (const stream of this.streams.values()) stream.abort()
    this.streams.clear()
    const proc = this.process
    this.process = null
    if (proc && !proc.killed) proc.kill()
    this.setStatus('stopped')
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      return await this.fetchFn(`${this.baseUrl()}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const response = await this.request('/health', { method: 'GET' })
        if (response.ok) return
      } catch (err) { lastError = err }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`Multi-agent sidecar health check timed out${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
  }

  private startHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = setInterval(() => {
      this.request('/health', { method: 'GET' })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`) })
        .catch((err) => {
          console.warn('[Sidecar] health check failed:', err)
          this.setStatus('error')
          this.scheduleRestart()
        })
    }, this.healthIntervalMs)
  }

  private async streamRun(runId: string): Promise<void> {
    const controller = new AbortController()
    this.streams.set(runId, controller)
    try {
      const response = await this.fetchFn(`${this.baseUrl()}/run/${encodeURIComponent(runId)}/stream`, {
        headers: { accept: 'text/event-stream' }, signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`Sidecar event stream failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        pending += decoder.decode(next.value, { stream: true })
        const frames = pending.split('\n\n')
        pending = frames.pop() ?? ''
        for (const frame of frames) this.handleSseFrame(frame)
      }
    } catch (err) {
      if (!controller.signal.aborted) console.warn(`[Sidecar] event stream ${runId} failed:`, err)
    } finally {
      this.streams.delete(runId)
    }
  }

  private handleSseFrame(frame: string): void {
    const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim()
    if (!data) return
    try {
      const event = parseAgentEvent(JSON.parse(data))
      this.emit('event', event as AgentEvent)
    } catch (err) {
      console.warn('[Sidecar] dropped invalid SSE AgentEvent:', err)
    }
  }

  private handleExit(code: number | null): void {
    this.process = null
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
    if (this.stopping) return
    console.warn(`[Sidecar] exited unexpectedly (${code ?? 'signal'})`)
    this.setStatus('error')
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer || !this.launchConfig?.openRouterApiKey) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch((err) => {
        console.warn('[Sidecar] restart failed:', err)
        this.scheduleRestart()
      })
    }, RESTART_DELAY_MS)
  }
}

export const multiAgentSidecar = new MultiAgentSidecarManager()
