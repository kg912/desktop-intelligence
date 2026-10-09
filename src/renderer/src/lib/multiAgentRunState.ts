// Pure, incremental view-model for one multi-agent run (MULTI_AGENT_SPEC.html
// §08 Frontend). applyAgentEvent() touches only what an event changes, so a
// token stream costs O(1) per token instead of re-reducing the whole trace.

import type { AgentEvent, AgentStep, HitlPauseEvent, OutputLimit, RunConfigEvent, RunTotals } from '../../../shared/types'

export type AgentStatus = 'queued' | 'running' | 'paused' | 'reflecting' | 'retrying' | 'done' | 'failed' | 'cancelled'

export interface ReflectionView {
  attempt: number
  score: number
  passed: boolean
  reason: string
  /** Judge model id, or "deterministic precheck". Absent on older traces. */
  model?: string
  issues?: string[]
  /** What OpenRouter actually answered with, when it said. */
  modelServed?: string
  evidenceMode?: 'full' | 'excerpts'
  judgeInputChars?: number
  claimsChecked?: number
  claimsFailed?: number
  claimStatuses?: Record<string, string>
}

/** Retries ran out and the best attempt was passed on with its open issues (or accepted unreviewed). */
export interface DegradedView {
  attempt: number
  score: number
  issues: string[]
  claimStatuses: Record<string, string>
  reason?: string
  unreviewed?: boolean
}

/** One entry of an agent's trace, in arrival order. Attempts are 0-based. */
export type TimelineItem =
  | { kind: 'reasoning'; attempt: number; text: string; startedAt: number; endedAt: number }
  | {
      kind: 'tool'; attempt: number; callId: string; tool: string; server: string; argsPreview: string; startedAt: number
      done?: { ok: boolean; durationMs: number; resultPreview: string; resultChars: number }
    }
  | { kind: 'output'; attempt: number; text: string }
  | ({ kind: 'gate' } & ReflectionView)

export interface AgentView {
  step: AgentStep
  status: AgentStatus
  /** Text streamed during the current attempt. */
  liveText: string
  /** Approximate streamed-token count for the live counter (exact figures arrive with agent_complete). */
  streamedTokens: number
  output?: string
  tokenCount: number
  costUsd: number
  attempt: number
  reflections: ReflectionView[]
  timeline: TimelineItem[]
  failure?: string
  pause?: HitlPauseEvent
  /** The answer hit an output limit. */
  truncated?: OutputLimit
  /** The answer came from the forced wrap-up round after maxToolRounds. */
  stoppedAtToolLimit?: boolean
  /** Model OpenRouter actually served for the accepted answer, when it said. */
  modelServed?: string
  /** Accepted with caveats: shown amber, never as failed. */
  degraded?: DegradedView
  /** History compacted to fit the context window: events and tool results stubbed in total. */
  compacted?: { events: number; stubbed: number; tokensFreed: number }
  startedAt?: number
  endedAt?: number
}

export type RunPhase = 'planning' | 'preflight' | 'running' | 'synthesizing' | 'complete' | 'failed'

export interface RunView {
  runId: string
  phase: RunPhase
  steps: AgentStep[]
  agents: Record<string, AgentView>
  planPause?: HitlPauseEvent
  /** What the run actually used (models per role and their source). */
  runConfig?: RunConfigEvent
  synthesis: string
  finalOutput?: string
  synthesisTruncated?: OutputLimit
  failureReason?: string
  /** Models OpenRouter actually served the planner and the synthesis, when it said. */
  served: { orchestrator?: string; synthesizer?: string }
  totals: RunTotals
  startedAt: number
  endedAt?: number
  lastSeq: number
}

export function emptyRunView(runId: string, startedAt = Date.now()): RunView {
  return {
    runId,
    phase: 'planning',
    steps: [],
    agents: {},
    synthesis: '',
    served: {},
    totals: { costUsd: 0, tokens: 0, budgetReached: false },
    startedAt,
    lastSeq: 0,
  }
}

const isFinished = (status: AgentStatus): boolean => status === 'done' || status === 'failed' || status === 'cancelled'

function updateAgent(view: RunView, id: string, patch: (agent: AgentView) => Partial<AgentView>): RunView {
  const agent = view.agents[id]
  if (!agent) return view
  return { ...view, agents: { ...view.agents, [id]: { ...agent, ...patch(agent) } } }
}

export function applyAgentEvent(view: RunView, event: AgentEvent): RunView {
  if (event.runId !== view.runId || event.seq <= view.lastSeq) return view
  let next: RunView = { ...view, lastSeq: event.seq }
  if (event.runTotals) next.totals = event.runTotals

  switch (event.type) {
    case 'orchestrator_plan': {
      const agents: Record<string, AgentView> = {}
      for (const step of event.steps) {
        agents[step.id] = {
          step, status: 'queued', liveText: '', streamedTokens: 0, tokenCount: 0, costUsd: 0, attempt: 0, reflections: [], timeline: [],
        }
      }
      return { ...next, steps: event.steps, agents, ...(event.modelServed && { served: { ...next.served, orchestrator: event.modelServed } }) }
    }
    case 'run_config':
      return { ...next, runConfig: event }
    case 'hitl_pause':
      if (event.serverName === 'multi-agent') return { ...next, phase: 'preflight', planPause: event }
      return updateAgent(next, event.agentId, () => ({ status: 'paused', pause: event }))
    case 'hitl_resume':
      if (event.agentId === 'orchestrator') {
        return { ...next, planPause: undefined, phase: event.approved ? 'running' : next.phase }
      }
      return updateAgent(next, event.agentId, (a) => ({ pause: undefined, status: a.status === 'paused' ? 'running' : a.status }))
    case 'agent_start':
      return updateAgent({ ...next, phase: 'running' }, event.agentId, () => ({
        status: 'running', attempt: 1, startedAt: event.ts,
      }))
    case 'agent_token':
      return updateAgent(next, event.agentId, (a) => ({
        liveText: a.liveText + event.token,
        streamedTokens: a.streamedTokens + 1,
        status: a.status === 'retrying' || a.status === 'queued' ? 'running' : a.status,
        timeline: appendText(a.timeline, 'output', event.attempt ?? a.attempt - 1, event.token, event.ts),
      }))
    case 'agent_reasoning':
      return updateAgent(next, event.agentId, (a) => ({
        status: a.status === 'retrying' || a.status === 'queued' ? 'running' : a.status,
        timeline: appendText(a.timeline, 'reasoning', event.attempt, event.token, event.ts),
      }))
    case 'tool_start':
      return updateAgent(next, event.agentId, (a) => ({
        timeline: [...a.timeline, {
          kind: 'tool', attempt: event.attempt, callId: event.callId, tool: event.tool, server: event.server,
          argsPreview: event.argsPreview, startedAt: event.ts,
        }],
      }))
    case 'tool_done':
      return updateAgent(next, event.agentId, (a) => ({
        timeline: a.timeline.map((item) =>
          item.kind === 'tool' && item.callId === event.callId && item.attempt === event.attempt
            ? { ...item, done: { ok: event.ok, durationMs: event.durationMs, resultPreview: event.resultPreview, resultChars: event.resultChars } }
            : item
        ),
      }))
    case 'agent_complete':
      return updateAgent(next, event.agentId, () => ({
        output: event.output, tokenCount: event.tokenCount, costUsd: event.costUsd, status: 'done', endedAt: event.ts, truncated: event.truncated,
        stoppedAtToolLimit: event.stoppedAtToolLimit, modelServed: event.modelServed,
      }))
    case 'reflection_start':
      return updateAgent(next, event.agentId, () => ({ status: 'reflecting' }))
    case 'reflection_result':
      return updateAgent(next, event.agentId, (a) => {
        const gate: ReflectionView = {
          attempt: a.attempt, score: event.score, passed: event.passed, reason: event.reason,
          ...(event.model !== undefined && { model: event.model }),
          ...(event.issues !== undefined && { issues: event.issues }),
          ...(event.modelServed !== undefined && { modelServed: event.modelServed }),
          ...(event.evidenceMode !== undefined && { evidenceMode: event.evidenceMode }),
          ...(event.judgeInputChars !== undefined && { judgeInputChars: event.judgeInputChars }),
          ...(event.claimsChecked !== undefined && { claimsChecked: event.claimsChecked }),
          ...(event.claimsFailed !== undefined && { claimsFailed: event.claimsFailed }),
          ...(event.claimStatuses !== undefined && { claimStatuses: event.claimStatuses }),
        }
        return {
          reflections: [...a.reflections, gate],
          timeline: [...a.timeline, { kind: 'gate', ...gate, attempt: event.attempt ?? a.attempt - 1 }],
          status: event.passed ? 'done' : 'retrying',
          endedAt: event.ts,
        }
      })
    case 'retry':
      return updateAgent(next, event.agentId, (a) => ({
        // The rejected attempt's output must not linger as if it were the answer.
        status: 'retrying', attempt: a.attempt + 1, liveText: '', streamedTokens: 0, output: undefined, endedAt: undefined, truncated: undefined, stoppedAtToolLimit: undefined,
      }))
    case 'agent_failed':
      return updateAgent(next, event.agentId, () => ({ status: 'failed', failure: event.reason, pause: undefined, endedAt: event.ts }))
    case 'agent_degraded':
      return updateAgent(next, event.agentId, (a) => ({
        status: 'done', endedAt: event.ts,
        // The answer passed on is the chosen attempt's, which may be earlier than the last one shown.
        output: a.timeline.find((t): t is Extract<TimelineItem, { kind: 'output' }> => t.kind === 'output' && t.attempt === event.attempt)?.text ?? a.output,
        degraded: {
          attempt: event.attempt, score: event.score, issues: event.issues, claimStatuses: event.claimStatuses,
          ...(event.reason !== undefined && { reason: event.reason }), ...(event.unreviewed && { unreviewed: true }),
        },
      }))
    case 'context_compacted':
      return updateAgent(next, event.agentId, (a) => ({
        compacted: {
          events: (a.compacted?.events ?? 0) + 1,
          stubbed: (a.compacted?.stubbed ?? 0) + event.stubbed,
          tokensFreed: (a.compacted?.tokensFreed ?? 0) + event.tokensFreed,
        },
      }))
    case 'synthesis_start':
      return { ...next, phase: 'synthesizing' }
    case 'synthesis_token':
      return { ...next, synthesis: next.synthesis + event.token }
    case 'task_complete':
      return {
        ...next,
        phase: 'complete',
        finalOutput: event.finalOutput,
        synthesis: event.finalOutput,
        synthesisTruncated: event.truncated,
        ...(event.modelServed && { served: { ...next.served, synthesizer: event.modelServed } }),
        totals: { ...next.totals, costUsd: event.totalCostUsd, tokens: event.totalTokens },
        endedAt: event.ts,
      }
    case 'task_failed': {
      const agents = { ...next.agents }
      for (const [id, agent] of Object.entries(agents)) {
        if (!isFinished(agent.status)) agents[id] = { ...agent, status: 'cancelled', pause: undefined, endedAt: event.ts }
      }
      return { ...next, agents, phase: 'failed', failureReason: event.reason, planPause: undefined, endedAt: event.ts }
    }
    default:
      return next
  }
}

/** Extend the last item if it is the same kind and attempt, else start a new one. */
function appendText(timeline: TimelineItem[], kind: 'reasoning' | 'output', attempt: number, text: string, ts: number): TimelineItem[] {
  const last = timeline.at(-1)
  if (last && last.kind === kind && last.attempt === attempt) {
    const merged: TimelineItem = last.kind === 'reasoning' ? { ...last, text: last.text + text, endedAt: ts } : { ...last, text: last.text + text }
    return [...timeline.slice(0, -1), merged]
  }
  return [...timeline, kind === 'reasoning' ? { kind, attempt, text, startedAt: ts, endedAt: ts } : { kind, attempt, text }]
}

export function reduceRunEvents(runId: string, events: AgentEvent[], startedAt?: number): RunView {
  const sorted = [...events].sort((a, b) => a.seq - b.seq)
  return sorted.reduce(applyAgentEvent, emptyRunView(runId, startedAt ?? sorted[0]?.ts ?? Date.now()))
}

// ── Derived selectors ─────────────────────────────────────────────────────────

export const isRunActive = (view: RunView): boolean => view.phase !== 'complete' && view.phase !== 'failed'

export function pausedAgents(view: RunView): AgentView[] {
  return view.steps.map((s) => view.agents[s.id]).filter((a): a is AgentView => !!a?.pause)
}

/** Spec §08 Input Bar column of the layout state machine. */
export function inputLockMessage(view: RunView): string | null {
  if (view.phase === 'planning') return 'Orchestrator is planning…'
  if (view.phase === 'preflight') return 'Review the plan — approve or cancel to continue'
  if (!isRunActive(view)) return null
  const paused = pausedAgents(view)
  if (paused.length === 1) return `${paused[0].step.role} Agent needs your approval`
  if (paused.length > 1) return `${paused.length} agents need your approval`
  return view.phase === 'synthesizing' ? 'Synthesizing the final answer…' : 'Agents running…'
}

/** OpenRouter served another model than the one requested. A dated or variant id of the same model ("<id>-20240620") is not a different model — the run log's rule. */
export const servedDiffers = (requested: string, served: string | undefined): served is string =>
  !!served && !!requested && !served.startsWith(requested)

export const CUT_OFF_LABEL: Record<OutputLimit, string> = {
  budget:  'Cut off: budget cap',
  context: 'Cut off: context window',
}

export function elapsedMs(agent: AgentView, now: number): number | null {
  if (!agent.startedAt) return null
  // Both ends are event timestamps except `now` (a 1 s tick that can lag the first event): never negative.
  return Math.max(0, (agent.endedAt ?? now) - agent.startedAt)
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Provenance markers like [1.1] → in-page links the synthesis view turns into chips. */
export function linkProvenance(text: string, agentIds: Set<string>): string {
  return text.replace(/\[(\d+(?:\.\d+)*[a-z]?)\](?!\()/g, (match, id: string) =>
    agentIds.has(id) ? `[${id}](#agent-${id})` : match
  )
}
