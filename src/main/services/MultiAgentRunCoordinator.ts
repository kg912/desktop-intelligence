/**
 * Electron-side owner of multi-agent runs (MULTI_AGENT_SPEC.html §03, §07, §08).
 *
 *  - start: resolves role models against the live OpenRouter catalogue
 *    (empty → the active OpenRouter model; unknown → the run does not start), supplies per-token
 *    pricing so the sidecar can enforce the budget cap, and passes only the
 *    currently running MCP tool schemas.
 *  - events: forwarded to the renderer; worker tool pauses are executed here
 *    through McpServerManager (→ SandboxService) with the agent's identity and
 *    the run's HITL settings — the sidecar never touches a tool.
 *  - persistence: traces are buffered in memory and written in one statement
 *    at meaningful boundaries; consecutive token events are coalesced (their
 *    text is kept, per-token granularity is not — it is fully recoverable
 *    from agent_complete/task_complete).
 *  - termination: exactly once per run — final answer saved to the chat,
 *    pending approvals cancelled, run-scoped agent trust dropped.
 */
import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AgentStep,
  MultiAgentConfig,
  MultiAgentRunRecord,
  MultiAgentStartPayload,
  RunStatus,
  StartRunResult,
} from '../../shared/types'
import { isTerminalAgentEvent } from '../../shared/agentEvents'
import { MODEL_ROLES, resolveRoleModels } from '../../shared/multiAgentModels'
import type { ModelPricing, ModelRole, OpenRouterModelInfo } from '../../shared/multiAgentModels'
import type { RunStartRequest } from './MultiAgentSidecarManager'
import { McpDeniedError, buildApprovedToolResult } from './McpServerManager'
import type { LMStudioTool, McpToolResult, MultiAgentToolContext } from './McpServerManager'

type TokenEvent = Extract<AgentEvent, { type: 'agent_token' | 'agent_reasoning' | 'synthesis_token' }>

/** Stored token/reasoning events are coalesced per agent and attempt into one per window. */
export const COALESCE_WINDOW_MS = 250

export interface CoordinatorDeps {
  sidecar: {
    on(event: 'event', listener: (event: AgentEvent) => void): unknown
    on(event: 'runStarted', listener: (info: { runId: string; chatId: string }) => void): unknown
    startRun(request: RunStartRequest): Promise<StartRunResult>
    respondHitl(response: { runId: string; agentId: string; approved: boolean; result?: string }): Promise<void>
    abortRun(runId: string): Promise<void>
    isAwaitingPlanApproval(runId: string): boolean
  }
  mcp: {
    getToolSchemas(): LMStudioTool[]
    callToolForMultiAgent(
      serverName: string,
      toolName: string,
      args: Record<string, unknown>,
      ctx: MultiAgentToolContext
    ): Promise<McpToolResult>
    clearRunTrust(runId: string): void
    cancelRunPermissions(runId: string): void
  }
  /** Push to the renderer (MULTI_AGENT_EVENT). */
  sendEvent(event: AgentEvent): void
  db: {
    begin(chatId: string): void
    saveTrace(chatId: string, trace: AgentEvent[], status: RunStatus, steps?: AgentStep[]): void
    saveAssistantMessage(chatId: string, id: string, content: string): void
    getRun(chatId: string): MultiAgentRunRecord | null
  }
  observe(chatId: string, event: AgentEvent): void
  settings(): { backendProvider: string; openRouterApiKey: string; openRouterModel: string }
  catalogue(apiKey: string): Promise<OpenRouterModelInfo[]>
  flushDelayMs?: number
}

interface RunContext {
  runId: string
  chatId: string
  config: MultiAgentConfig
  trace: AgentEvent[]
  pendingTokens: Map<string, TokenEvent>
  steps?: AgentStep[]
  openPauses: number
  flushTimer: ReturnType<typeof setTimeout> | null
}

export class MultiAgentRunCoordinator {
  private readonly runs = new Map<string, RunContext>()
  /** chatId → config for a run whose id the sidecar has not assigned yet. */
  private readonly starting = new Map<string, MultiAgentConfig>()
  private readonly flushDelayMs: number

  constructor(private readonly deps: CoordinatorDeps) {
    this.flushDelayMs = deps.flushDelayMs ?? 500
    // runStarted is emitted synchronously inside startRun, before any event
    // can stream — so a run's context always exists before its first event.
    deps.sidecar.on('runStarted', ({ runId, chatId }) => {
      const config = this.starting.get(chatId)
      if (!config) return
      this.starting.delete(chatId)
      this.runs.set(runId, {
        runId, chatId, config, trace: [], pendingTokens: new Map(), openPauses: 0, flushTimer: null,
      })
      deps.db.begin(chatId)
    })
    deps.sidecar.on('event', (event) => this.onEvent(event))
  }

  async start(payload: MultiAgentStartPayload): Promise<StartRunResult> {
    const { backendProvider, openRouterApiKey, openRouterModel } = this.deps.settings()
    if (backendProvider !== 'openrouter') {
      return { ok: false, reason: 'Multi-agent mode requires the OpenRouter backend (Settings → Backend)' }
    }
    if (!openRouterApiKey) {
      return { ok: false, reason: 'OpenRouter API key is not configured — add it in Settings → Backend' }
    }
    if ([...this.runs.values()].some((r) => r.chatId === payload.chatId) || this.starting.has(payload.chatId)) {
      return { ok: false, reason: 'A multi-agent run is already in progress for this chat' }
    }

    let catalogue: OpenRouterModelInfo[] = []
    try {
      catalogue = await this.deps.catalogue(openRouterApiKey)
    } catch (err) {
      console.warn('[MultiAgent] catalogue unavailable — using configured model ids as-is:', err)
    }
    const known = new Map(catalogue.map((m) => [m.id, m]))
    const catalogueChecked = known.size > 0
    const resolved = resolveRoleModels(payload.config.models, openRouterModel, catalogueChecked ? new Set(known.keys()) : null)
    // No silent swap: a configured model the catalogue does not list stops the run.
    const notListed = MODEL_ROLES.filter((role) => resolved[role].source === 'missing')
    if (notListed.length) {
      const which = notListed.map((role) => `${role} model "${resolved[role].model}"`).join(', ')
      return { ok: false, reason: `Not in the OpenRouter catalogue: ${which} — choose another in Settings → Multi-Agent` }
    }
    const models = Object.fromEntries(MODEL_ROLES.map((role) => [role, resolved[role].model])) as MultiAgentConfig['models']
    const missing = MODEL_ROLES.filter((role) => !models[role])
    if (missing.length) {
      return { ok: false, reason: `No OpenRouter model for: ${missing.join(', ')} — choose one in Settings` }
    }
    if (!catalogueChecked) console.warn('[MultiAgent] catalogue unavailable — configured model ids are used unverified')

    const pricing: Record<string, ModelPricing> = {}
    for (const model of new Set(Object.values(models))) {
      const info = known.get(model)
      if (info?.promptPrice != null && info.completionPrice != null) {
        pricing[model] = { prompt: info.promptPrice, completion: info.completionPrice, contextLength: info.contextLength }
      }
    }

    const config: MultiAgentConfig = { ...payload.config, models }
    this.starting.set(payload.chatId, config)
    try {
      const result = await this.deps.sidecar.startRun({
        chatId: payload.chatId,
        task: payload.task,
        config,
        tools: this.deps.mcp.getToolSchemas().map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters as unknown as Record<string, unknown>,
        })),
        openRouterApiKey,
        pricing,
        noReasoning: [...new Set(Object.values(models))].filter((m) => known.get(m)?.supportsReasoning === false),
        modelSources: Object.fromEntries(MODEL_ROLES.map((role) => [role, resolved[role].source])) as Record<ModelRole, 'saved' | 'default' | 'active'>,
        catalogueChecked,
      })
      return result.ok ? { ...result, config } : result
    } finally {
      this.starting.delete(payload.chatId)
    }
  }

  /** Renderer-owned pre-flight answer. Tool pauses can never be answered from the renderer. */
  async respondToPlan(runId: string, approved: boolean): Promise<void> {
    if (!this.deps.sidecar.isAwaitingPlanApproval(runId)) {
      throw new Error('This run is not waiting for plan approval')
    }
    await this.deps.sidecar.respondHitl({ runId, agentId: 'orchestrator', approved })
  }

  abort(runId: string): Promise<void> {
    return this.deps.sidecar.abortRun(runId)
  }

  getRun(chatId: string): MultiAgentRunRecord | null {
    const live = [...this.runs.values()].find((r) => r.chatId === chatId)
    if (live) {
      return { mode: 'multi-agent', runStatus: this.status(live), agentGraph: live.steps ?? [], executionTrace: this.snapshot(live) }
    }
    return this.deps.db.getRun(chatId)
  }

  /** Ids of runs still in flight — e.g. to warn before quitting. */
  activeRunIds(): string[] {
    return [...this.runs.keys()]
  }

  // ── Event handling ──────────────────────────────────────────────────────

  private onEvent(event: AgentEvent): void {
    const run = this.runs.get(event.runId)
    if (!run) return
    this.deps.sendEvent(event)

    if (event.type === 'agent_token' || event.type === 'agent_reasoning' || event.type === 'synthesis_token') {
      const key = event.type === 'synthesis_token' ? 'synthesis' : `${event.type}:${event.agentId}:${event.attempt ?? 0}`
      const pending = run.pendingTokens.get(key)
      if (pending && event.ts - pending.ts < COALESCE_WINDOW_MS) {
        run.pendingTokens.set(key, { ...pending, token: pending.token + event.token })
      } else {
        if (pending) this.record(run, pending)
        run.pendingTokens.set(key, event)
      }
      return
    }

    this.flushTokens(run)
    this.record(run, event)
    if (event.type === 'orchestrator_plan') run.steps = event.steps
    if (event.type === 'hitl_pause') run.openPauses++
    if (event.type === 'hitl_resume') run.openPauses = Math.max(0, run.openPauses - 1)

    if (event.type === 'hitl_pause' && event.serverName !== 'multi-agent') {
      void this.proxyToolCall(run, event)
    }

    if (isTerminalAgentEvent(event)) {
      this.finish(run, event)
      return
    }
    // Pauses and the plan must be durable immediately; the rest is debounced.
    if (event.type === 'hitl_pause' || event.type === 'orchestrator_plan') this.flush(run)
    else this.scheduleFlush(run)
  }

  private record(run: RunContext, event: AgentEvent): void {
    run.trace.push(event)
    this.deps.observe(run.chatId, event)
  }

  private flushTokens(run: RunContext): void {
    for (const token of run.pendingTokens.values()) this.record(run, token)
    run.pendingTokens.clear()
  }

  private snapshot(run: RunContext): AgentEvent[] {
    return [...run.trace, ...run.pendingTokens.values()].sort((a, b) => a.seq - b.seq)
  }

  private status(run: RunContext): RunStatus {
    const last = run.trace.at(-1)
    if (last?.type === 'task_complete') return 'completed'
    if (last?.type === 'task_failed') return 'failed'
    return run.openPauses > 0 ? 'paused_hitl' : 'running'
  }

  private scheduleFlush(run: RunContext): void {
    if (run.flushTimer) return
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null
      this.flush(run)
    }, this.flushDelayMs)
    run.flushTimer.unref?.()
  }

  private flush(run: RunContext): void {
    if (run.flushTimer) clearTimeout(run.flushTimer)
    run.flushTimer = null
    try {
      this.deps.db.saveTrace(run.chatId, this.snapshot(run), this.status(run), run.steps)
    } catch (err) {
      console.warn('[MultiAgent] trace persistence failed:', err)
    }
  }

  private async proxyToolCall(run: RunContext, pause: Extract<AgentEvent, { type: 'hitl_pause' }>): Promise<void> {
    const reply = (approved: boolean, result: string): Promise<void> =>
      this.deps.sidecar
        .respondHitl({ runId: run.runId, agentId: pause.agentId, approved, result })
        .catch((err) => console.warn(`[MultiAgent] ${pause.agentId} moved on before its tool result arrived:`, err))
    try {
      const result = await this.deps.mcp.callToolForMultiAgent(pause.serverName, pause.toolName, pause.args, {
        chatId: run.chatId,
        runId: run.runId,
        agentId: pause.agentId,
        role: pause.role,
        model: pause.model ?? '',
        requirePermissions: run.config.requirePermissions,
        hitlTimeoutMs: run.config.hitlTimeoutMs,
      })
      await reply(true, buildApprovedToolResult(result.text, result.userNote))
    } catch (err) {
      const reason =
        err instanceof McpDeniedError
          ? err.userNote || 'denied by user'
          : err instanceof Error ? err.message : 'MCP tool execution failed'
      await reply(false, reason)
    }
  }

  private finish(run: RunContext, terminal: Extract<AgentEvent, { type: 'task_complete' | 'task_failed' }>): void {
    this.flush(run)
    this.runs.delete(run.runId)
    this.deps.mcp.cancelRunPermissions(run.runId)
    this.deps.mcp.clearRunTrust(run.runId)
    try {
      this.deps.db.saveAssistantMessage(run.chatId, randomUUID(), this.finalMessage(run, terminal))
    } catch (err) {
      console.warn('[MultiAgent] could not save the final message:', err)
    }
  }

  private finalMessage(run: RunContext, terminal: Extract<AgentEvent, { type: 'task_complete' | 'task_failed' }>): string {
    if (terminal.type === 'task_complete') return terminal.finalOutput
    const outputs = new Map<string, string>()
    for (const e of run.trace) if (e.type === 'agent_complete') outputs.set(e.agentId, e.output)
    const partial = [...outputs].map(([id, text]) => `**[${id}]** ${text}`).join('\n\n')
    return `**Multi-agent run failed:** ${terminal.reason}` + (partial ? `\n\nPartial results:\n\n${partial}` : '')
  }
}
