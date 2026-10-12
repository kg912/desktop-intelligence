// Graph nodes for AgentGraphCanvas, from the planning draft (Goal 5) or the run (Goal 6).
// Both start with the orchestrator and end with the final synthesis, so the layout of a plan
// is the same before and after it lands.

import type { AgentView, PlanningView, RunView } from './multiAgentRunState'

export type NodeState = 'done' | 'run' | 'approval' | 'wait' | 'fail' | 'draft' | 'ghost'
export type EdgeKind = 'done' | 'live' | 'hold' | 'idle'

export interface GraphNode {
  id: string
  /** Shown in the card's first line ("orch", "1.4", "out"). */
  label: string
  title: string
  meta: string
  state: NodeState
  /** Text at the right of the first line ("running", "approval", "waiting"…). */
  stateText?: string
  dependsOn: string[]
  /** Pending approvals, as a yellow count badge. */
  badge?: number
}

export const ORCH_ID = 'orch'
export const OUT_ID = 'out'
/** Edge look from the state of the node the data comes from (and goes to). */
export function edgeKind(from: NodeState, to: NodeState): EdgeKind {
  if (to === 'ghost' || from === 'ghost' || from === 'draft' || to === 'draft') return 'idle'
  if (from === 'done') return 'done'
  if (from === 'approval') return 'hold'
  if (from === 'run' && to !== 'done') return 'live'
  return 'idle'
}

const short = (id: string): string => id.split('/').pop() || id
const tokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const GHOST_NEXT = '__next'

/** Steps nothing depends on feed the final synthesis. */
function leaves(steps: Array<{ id: string; dependsOn?: string[] }>): string[] {
  const used = new Set(steps.flatMap((s) => s.dependsOn ?? []))
  return steps.filter((s) => !used.has(s.id)).map((s) => s.id)
}

export function planningNodes(planning: PlanningView, orchestratorModel: string): GraphNode[] {
  const ids = new Set(planning.draft.filter(Boolean).map((s) => s.id))
  const draft = planning.draft.filter(Boolean).map((s): GraphNode => {
    const deps = s.dependsOn.filter((d) => ids.has(d) && d !== s.id)
    return { id: s.id, label: s.id, title: s.label, meta: s.role || 'role pending', state: 'draft', dependsOn: deps.length ? deps : [ORCH_ID] }
  })
  const writing = planning.stage === 'reading' || planning.stage === 'splitting'
  const more = writing && (planning.maxAgents === undefined || draft.length < planning.maxAgents)
  const ghost: GraphNode[] = more ? [{ id: GHOST_NEXT, label: '', title: '', meta: '', state: 'ghost', dependsOn: [ORCH_ID] }] : []
  // The ghost synthesis sits after the subtasks (or after the ghost one, before any exist).
  const feeding = draft.length ? leaves(draft) : ghost.length ? [GHOST_NEXT] : [ORCH_ID]
  return [
    { id: ORCH_ID, label: 'orch', title: 'Orchestrator · plan', meta: short(orchestratorModel) || 'orchestrator', state: 'run', stateText: 'planning', dependsOn: [] },
    ...draft,
    ...ghost,
    { id: OUT_ID, label: 'out', title: 'Final synthesis', meta: '', state: 'ghost', dependsOn: feeding },
  ]
}

function agentState(agent: AgentView, pending: number): { state: NodeState; stateText: string } {
  if (pending > 0 || agent.status === 'paused') return { state: 'approval', stateText: 'approval' }
  switch (agent.status) {
    case 'running': case 'retrying': return { state: 'run', stateText: agent.status === 'retrying' ? 'retrying' : 'running' }
    case 'reflecting': return { state: 'run', stateText: 'reviewing' }
    case 'done': return { state: 'done', stateText: agent.degraded ? 'caveats' : 'done' }
    case 'failed': case 'cancelled': return { state: 'fail', stateText: agent.status === 'failed' ? 'failed' : 'stopped' }
    default: return { state: 'wait', stateText: 'waiting' }
  }
}

export function runGraphNodes(view: RunView, pending: Map<string, number>, models: { orchestrator: string; synthesizer: string }): GraphNode[] {
  const steps = view.steps.map((s): GraphNode => {
    const agent = view.agents[s.id]
    const deps = s.dependsOn ?? []
    const waitingOn = deps.filter((d) => view.agents[d]?.status !== 'done')
    const { state, stateText } = agent ? agentState(agent, pending.get(s.id) ?? 0) : { state: 'wait' as const, stateText: 'waiting' }
    const used = agent ? agent.tokenCount || agent.streamedTokens : 0
    return {
      id: s.id, label: s.id, title: s.label, state, stateText, badge: pending.get(s.id) || undefined,
      meta: agent?.status === 'queued' && waitingOn.length ? `waits on ${waitingOn.join(' ')}` : `${s.role}${used ? ` · ${tokens(used)}` : ''}`,
      dependsOn: deps.length ? deps : [ORCH_ID],
    }
  })
  const out: NodeState = view.phase === 'complete' ? 'done' : view.phase === 'synthesizing' ? 'run' : view.phase === 'failed' ? 'fail' : 'wait'
  const feeding = leaves(view.steps)
  return [
    { id: ORCH_ID, label: 'orch', title: 'Orchestrator · plan', meta: short(models.orchestrator), state: view.steps.length ? 'done' : 'run',
      stateText: view.steps.length ? 'done' : 'planning', dependsOn: [] },
    ...steps,
    { id: OUT_ID, label: 'out', title: 'Final synthesis', meta: short(models.synthesizer), state: out,
      stateText: { done: 'done', run: 'running', fail: 'failed', wait: 'waiting' }[out as 'done'], dependsOn: feeding.length ? feeding : [ORCH_ID] },
  ]
}

/** "PLAN", "PHASE 1 · PARALLEL WORKERS", "PHASE 2", …, "OUTPUT" for the layout's columns. */
export function columnLabels(columns: string[][]): string[] {
  return columns.map((col, c) => {
    if (c === 0) return 'PLAN'
    if (c === columns.length - 1 && col.includes(OUT_ID)) return 'OUTPUT'
    return `PHASE ${c}${col.length > 1 ? ' · PARALLEL WORKERS' : ''}`
  })
}
