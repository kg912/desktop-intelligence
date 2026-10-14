// Pure, incremental view-model for one multi-agent run (MULTI_AGENT_SPEC.html
// §08 Frontend). applyAgentEvent() touches only what an event changes, so a
// token stream costs O(1) per token instead of re-reducing the whole trace.

import type { AgentEvent, AgentStep, AssessDecisionEvent, ChecklistItem, ClaimView, HitlPauseEvent, LedgerEntry, LedgerStatus, OutputLimit, PlanStage, PlanSubtaskAddedEvent, RunConfigEvent, RunTotals } from '../../../shared/types'

export type AgentStatus = 'queued' | 'running' | 'paused' | 'reflecting' | 'retrying' | 'done' | 'failed' | 'cancelled' | 'skipped'

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
  claimFailureClasses?: Record<string, string>
  /** Spec B 7a: the attempt's claims, for chips and the evidence drawer. */
  claims?: ClaimView[]
}

/** Retries ran out and the best attempt was passed on with its open issues (or accepted unreviewed). */
export interface DegradedView {
  attempt: number
  score: number
  issues: string[]
  claimStatuses: Record<string, string>
  claimFailureClasses?: Record<string, string>
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
  /** Spec B Phase 3: why a conditional step was not run. */
  skipReason?: string
  /** Spec B Phase 5: a step it depends on was re-run; this output is built on the earlier one. */
  stale?: string
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

export interface RunLogEntry { ts: number; agentId?: string; tone: 'info' | 'ok' | 'wait' | 'fail'; text: string }
export const RUN_LOG_MAX = 300

/** One line for the run log, or null for token streams and other noise. */
export function runLogLine(e: AgentEvent): RunLogEntry | null {
  const at = (tone: RunLogEntry['tone'], text: string, agentId?: string): RunLogEntry => ({ ts: e.ts, tone, text, ...(agentId && { agentId }) })
  switch (e.type) {
    case 'plan_started': return at('info', `Planning started (up to ${e.maxAgents} agents)`)
    case 'ledger_update': {
      const total = Object.keys(e.ledger).length
      const parts = [`${e.counts.verified} of ${total} verified`,
        ...(e.counts.unverified ? [`${e.counts.unverified} unverified`] : []),
        ...(e.counts.conflicted ? [`${e.counts.conflicted} possible conflict${e.counts.conflicted === 1 ? '' : 's'}`] : []),
        ...(e.counts.missing ? [`${e.counts.missing} missing`] : [])]
      return at(e.counts.conflicted || e.counts.missing ? 'wait' : 'info', `Coverage: ${parts.join(', ')}`)
    }
    case 'assess_start': return at('info', `Assessing wave ${e.wave}: ${e.open} requirement${e.open === 1 ? '' : 's'} open`)
    case 'assess_decision': {
      const gaps = e.unclosable.length ? `; ${e.unclosable.length} gap${e.unclosable.length === 1 ? '' : 's'} no tool can close` : ''
      if (e.decision === 'follow_up') {
        return at('wait', `Assess: follow-up, ${e.steps.length} step${e.steps.length === 1 ? '' : 's'} (${e.autoRun ? 'auto-run' : 'needs your approval'}${e.estimatedUsd !== undefined ? `, est. $${e.estimatedUsd.toFixed(2)}` : ''})${gaps}`)
      }
      if (e.decision === 'ask_user') return at('wait', `Assess asks: ${e.question ?? e.reason}`)
      return at('ok', `Assess: done${e.forced ? ` (${e.forced.replace(/_/g, ' ')})` : ''}${gaps}`)
    }
    case 'wave_start': return at('info', `Wave ${e.n} started: ${e.steps.map((s) => s.id).join(', ')}`)
    case 'orchestrator_plan': return e.fallback ? at('wait', `Fallback plan: ${e.fallbackReason ?? 'no usable plan'}`) : at('ok', `Plan: ${e.steps.length} agent${e.steps.length === 1 ? '' : 's'}`)
    case 'hitl_pause': return e.serverName === 'multi-agent' ? at('wait', 'Waiting for plan approval') : at('wait', `${e.agentId} asks to run ${e.toolName}`, e.agentId)
    case 'hitl_resume': return e.agentId === 'orchestrator' ? at(e.approved ? 'ok' : 'fail', e.approved ? 'Plan approved' : 'Plan not approved')
      : at(e.approved ? 'ok' : 'fail', `${e.agentId} ${e.approved ? 'allowed' : 'denied'}`, e.agentId)
    case 'agent_start': return at('info', `${e.agentId} started`, e.agentId)
    case 'tool_start': return at('info', `${e.agentId} → ${e.tool}`, e.agentId)
    case 'tool_done': return e.ok ? null : at('fail', `${e.agentId} tool call not run`, e.agentId)
    case 'agent_complete': return at('info', `${e.agentId} answered`, e.agentId)
    case 'reflection_result': return at(e.passed ? 'ok' : 'fail', `${e.agentId} review ${e.score}/5${e.passed ? ' passed' : `: ${e.reason}`}`, e.agentId)
    case 'retry': return at('wait', `${e.agentId} retry ${e.attempt}: ${e.reason}`, e.agentId)
    case 'agent_degraded': return at('wait', `${e.agentId} accepted with caveats`, e.agentId)
    case 'agent_failed': return at('fail', `${e.agentId} failed: ${e.reason}`, e.agentId)
    case 'agent_skipped': return at('info', `${e.agentId} skipped: ${e.reason}`, e.agentId)
    case 'run_resumed': return at('info', `Run resumed: ${e.finishedSteps.join(', ') || 'no step'} kept; unfinished steps start again`)
    case 'rerun_start': return at('info', `Re-running ${e.steps.join(', ')}${e.model ? ` on ${e.model}` : ''}${e.stale.length ? `; ${e.stale.join(', ')} now stale` : ''}`)
    case 'agent_stale': return at('wait', `${e.agentId} is stale: ${e.reason}`, e.agentId)
    case 'synthesis_start': return at('info', 'Final synthesis started')
    case 'task_complete': return at('ok', 'Run complete')
    case 'task_failed': return at('fail', `Run failed: ${e.reason}`)
    default: return null
  }
}

export const PLAN_STAGES: PlanStage[] = ['reading', 'splitting', 'assigning', 'wiring']

/** The orchestrator's plan while it is being written (UI Goal 5). */
export interface PlanningView {
  /** When the plan_started event arrived; the run's start before that. */
  startedAt: number
  maxAgents?: number
  stage: PlanStage
  /** When each stage was reached. */
  stageAt: Partial<Record<PlanStage, number>>
  /** Planner attempt the draft belongs to; a re-plan starts a new draft. */
  attempt: number
  /** Subtasks written so far (draft; the final plan is RunView.steps). */
  draft: PlanSubtaskAddedEvent['step'][]
  reasoning: string
  /** Characters streamed (reasoning + draft), for the live token estimate. */
  streamedChars: number
  /** Set by orchestrator_plan when the fallback plan was used, and why. */
  fallbackReason?: string
}

/** One assessment after a wave (spec B Phase 2). startedAt from assess_start; the rest from assess_decision. */
export type AssessView = Omit<AssessDecisionEvent, 'type' | 'runId' | 'seq' | 'ts' | 'elapsedMs' | 'runTotals'> & { startedAt?: number; decidedAt: number }

export interface RunView {
  runId: string
  phase: RunPhase
  steps: AgentStep[]
  agents: Record<string, AgentView>
  planPause?: HitlPauseEvent
  planning: PlanningView
  /** Significant events, oldest first, capped at RUN_LOG_MAX (the graph inspector's Run log). */
  log: RunLogEntry[]
  /** What the run actually used (models per role and their source). */
  runConfig?: RunConfigEvent
  /** Spec B Phase 1: the planner's acceptance checklist and the latest coverage ledger. Absent on runs without a checklist. */
  checklist?: ChecklistItem[]
  ledger?: Record<string, LedgerEntry>
  ledgerCounts?: Record<LedgerStatus, number>
  /** Spec B Phase 2: the research wave in progress (1 = the plan's steps), each assessment in order, and a pending
   *  assess question or follow-up approval (agentId "assess"; never the plan pre-flight). */
  wave: number
  assess: AssessView[]
  assessPause?: HitlPauseEvent
  assessStartedAt?: number
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
    wave: 1,
    assess: [],
    totals: { costUsd: 0, tokens: 0, budgetReached: false },
    planning: { startedAt, stage: 'reading', stageAt: { reading: startedAt }, attempt: 0, draft: [], reasoning: '', streamedChars: 0 },
    log: [],
    startedAt,
    lastSeq: 0,
  }
}

const isFinished = (status: AgentStatus): boolean => status === 'done' || status === 'failed' || status === 'cancelled' || status === 'skipped'

function updateAgent(view: RunView, id: string, patch: (agent: AgentView) => Partial<AgentView>): RunView {
  const agent = view.agents[id]
  if (!agent) return view
  return { ...view, agents: { ...view.agents, [id]: { ...agent, ...patch(agent) } } }
}

export function applyAgentEvent(view: RunView, event: AgentEvent): RunView {
  const next = applyEvent(view, event)
  if (next === view) return view
  const line = runLogLine(event)
  return line ? { ...next, log: next.log.length >= RUN_LOG_MAX ? [...next.log.slice(1 - RUN_LOG_MAX), line] : [...next.log, line] } : next
}

function applyEvent(view: RunView, event: AgentEvent): RunView {
  if (event.runId !== view.runId || event.seq <= view.lastSeq) return view
  let next: RunView = { ...view, lastSeq: event.seq }
  if (event.runTotals) next.totals = event.runTotals

  switch (event.type) {
    case 'plan_started':
      return { ...next, planning: { ...next.planning, startedAt: event.ts, maxAgents: event.maxAgents, stageAt: { reading: event.ts } } }
    case 'plan_stage_changed': {
      const p = next.planning
      const restart = event.attempt !== p.attempt && event.stage === 'splitting'
      return { ...next, planning: { ...p, stage: event.stage, stageAt: { ...p.stageAt, [event.stage]: p.stageAt[event.stage] ?? event.ts },
        ...(restart && { attempt: event.attempt, draft: [] }) } }
    }
    case 'plan_subtask_added': {
      const p = next.planning
      const draft = event.attempt === p.attempt ? [...p.draft] : []
      draft[event.index] = event.step
      return { ...next, planning: { ...p, attempt: event.attempt, draft, streamedChars: p.streamedChars + event.step.label.length + 40 } }
    }
    case 'plan_reasoning':
      return { ...next, planning: { ...next.planning, reasoning: next.planning.reasoning + event.token, streamedChars: next.planning.streamedChars + event.token.length } }
    case 'orchestrator_plan': {
      const agents: Record<string, AgentView> = {}
      for (const step of event.steps) {
        agents[step.id] = {
          step, status: 'queued', liveText: '', streamedTokens: 0, tokenCount: 0, costUsd: 0, attempt: 0, reflections: [], timeline: [],
        }
      }
      const planning = { ...next.planning, stage: 'wiring' as const, stageAt: { ...next.planning.stageAt, wiring: next.planning.stageAt.wiring ?? event.ts },
        ...(event.fallback && { fallbackReason: event.fallbackReason ?? 'The planner never returned a usable plan.' }) }
      return { ...next, steps: event.steps, agents, planning, ...(event.modelServed && { served: { ...next.served, orchestrator: event.modelServed } }),
        ...(event.checklist?.length && { checklist: event.checklist }) }
    }
    case 'ledger_update':
      return { ...next, ledger: event.ledger, ledgerCounts: event.counts }
    case 'assess_start':
      return { ...next, assessStartedAt: event.ts }
    case 'assess_decision': {
      const { type: _t, runId: _r, seq: _s, ts, elapsedMs: _e, runTotals: _rt, ...decision } = event
      // An ask_user or an approval may be followed by a second decision for the same wave: it replaces the first.
      const assess = [...next.assess.filter((a) => a.wave !== event.wave), { ...decision, decidedAt: ts, startedAt: next.assessStartedAt }]
      return { ...next, assess }
    }
    case 'wave_start': {
      const agents = { ...next.agents }
      for (const step of event.steps) {
        agents[step.id] ??= { step, status: 'queued', liveText: '', streamedTokens: 0, tokenCount: 0, costUsd: 0, attempt: 0, reflections: [], timeline: [] }
      }
      const known = new Set(next.steps.map((s) => s.id))
      return { ...next, wave: event.n, agents, steps: [...next.steps, ...event.steps.filter((s) => !known.has(s.id))] }
    }
    case 'run_config':
      return { ...next, runConfig: event }
    case 'hitl_pause':
      if (event.serverName === 'multi-agent' && event.agentId === 'assess') return { ...next, assessPause: event }
      if (event.serverName === 'multi-agent') return { ...next, phase: 'preflight', planPause: event }
      return updateAgent(next, event.agentId, () => ({ status: 'paused', pause: event }))
    case 'hitl_resume':
      if (event.agentId === 'orchestrator') {
        return { ...next, planPause: undefined, phase: event.approved ? 'running' : next.phase }
      }
      if (event.agentId === 'assess') return { ...next, assessPause: undefined }
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
          ...(event.claimFailureClasses !== undefined && { claimFailureClasses: event.claimFailureClasses }),
          ...(event.claims !== undefined && { claims: event.claims }),
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
    case 'run_resumed': {
      // The interrupted run is live again: steps that had not finished start over.
      const agents = { ...next.agents }
      const kept = new Set(event.finishedSteps)
      for (const [id, agent] of Object.entries(agents)) {
        if (!kept.has(id)) agents[id] = freshAgent(agent.step)
      }
      return { ...next, agents, phase: 'running', failureReason: undefined, endedAt: undefined, finalOutput: undefined, synthesis: '' }
    }
    case 'rerun_start': {
      const agents = { ...next.agents }
      for (const id of event.steps) {
        const step = agents[id]?.step
        if (step) agents[id] = freshAgent(id === event.stepId && event.model ? { ...step, model: event.model } : step)
      }
      return { ...next, agents, phase: 'running', failureReason: undefined, endedAt: undefined, finalOutput: undefined, synthesis: '', synthesisTruncated: undefined }
    }
    case 'agent_stale':
      return updateAgent(next, event.agentId, () => ({ stale: event.reason }))
    case 'agent_skipped':
      return updateAgent(next, event.agentId, () => ({ status: 'skipped', skipReason: event.reason, pause: undefined, endedAt: event.ts }))
    case 'agent_failed':
      return updateAgent(next, event.agentId, () => ({ status: 'failed', failure: event.reason, pause: undefined, endedAt: event.ts }))
    case 'agent_degraded':
      return updateAgent(next, event.agentId, (a) => ({
        status: 'done', endedAt: event.ts,
        // The answer passed on is the chosen attempt's, which may be earlier than the last one shown.
        output: a.timeline.find((t): t is Extract<TimelineItem, { kind: 'output' }> => t.kind === 'output' && t.attempt === event.attempt)?.text ?? a.output,
        degraded: {
          attempt: event.attempt, score: event.score, issues: event.issues, claimStatuses: event.claimStatuses,
          ...(event.claimFailureClasses !== undefined && { claimFailureClasses: event.claimFailureClasses }),
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
      next = { ...next, assessPause: undefined }
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

function freshAgent(step: AgentStep): AgentView {
  return { step, status: 'queued', liveText: '', streamedTokens: 0, tokenCount: 0, costUsd: 0, attempt: 0, reflections: [], timeline: [] }
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
  max_tokens: 'Cut off: output cap',
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
