// Spec B 7c (design 13): where a run's time went, from its timing events (RunView.timing). Pure.
//
// A worker's tool call is a sidecar pause: Electron asks for approval (when it must) and runs the tool, and the
// sidecar resumes with the result. With spec A Phase 9's waitMs/toolMs the pause splits into the person's wait and the
// tool's own time; older runs logged neither, so the whole pause counts as the wait ("pause to resume").

import type { RunView, TimingEvent } from './multiAgentRunState'

export type SegmentKind = 'model' | 'tool' | 'wait' | 'judge' | 'repair'

export interface Segment {
  kind: SegmentKind
  start: number
  /** null: still running (an in-progress run is drawn to "now"). */
  end: number | null
  attempt: number
  tool?: string
  /** 1-based tool call number in this agent's run, for "First tool call". */
  callIndex?: number
  approvalMode?: 'trusted' | 'asked' | 'auto'
  /** Logged by Electron (spec A Phase 9); absent on older runs. */
  waitMs?: number
  toolMs?: number
}

export interface Lane {
  id: string
  label: string
  segments: Segment[]
}

export interface Gantt {
  lanes: Lane[]
  t0: number
  end: number
}

function laneBuilder() {
  const segments: Segment[] = []
  let open: Segment | null = null
  const close = (ts: number): void => {
    if (!open) return
    open.end = Math.max(ts, open.start)
    if (open.end > open.start) segments.push(open)
    open = null
  }
  const start = (kind: SegmentKind, ts: number, extra: Partial<Segment> = {}): void => {
    close(ts)
    open = { kind, start: ts, end: null, attempt: 0, ...extra }
  }
  const finish = (): Segment[] => (open && open.end === null ? [...segments, open] : segments)
  return { segments, start, close, finish, get open() { return open } }
}

function agentLane(id: string, label: string, events: TimingEvent[]): Lane {
  const b = laneBuilder()
  let attempt = 0
  let calls = 0
  let call: Partial<Segment> = {}
  const work = (): SegmentKind => (attempt > 0 ? 'repair' : 'model')
  for (const e of events) {
    switch (e.type) {
      case 'agent_start': attempt = e.attempt ?? 0; b.start(work(), e.ts, { attempt }); break
      case 'tool_start': call = { tool: e.tool, callIndex: ++calls, attempt }; b.start('tool', e.ts, call); break
      case 'hitl_pause':
        // The pause follows tool_start within a millisecond or two: the wait starts with the call.
        if (b.open?.kind === 'tool' && b.open.callIndex === call.callIndex) b.open.kind = 'wait'
        else b.start('wait', e.ts, call)
        break
      case 'hitl_resume': b.start('tool', e.ts, call); break
      case 'tool_done': {
        const meta = { ...(e.approvalMode && { approvalMode: e.approvalMode }), ...(e.waitMs !== undefined && { waitMs: e.waitMs }), ...(e.toolMs !== undefined && { toolMs: e.toolMs }) }
        const wait = b.segments.findLast((x) => x.kind === 'wait' && x.callIndex === call.callIndex)
        if (wait && e.waitMs !== undefined && wait.end !== null) {
          // The pause was the person's wait and then the tool: split it where Electron says the wait ended.
          const split = Math.min(wait.start + e.waitMs, wait.end)
          const after: Segment = { ...wait, ...meta, kind: 'tool', start: split }
          wait.end = split
          Object.assign(wait, meta)
          if (after.end! > after.start) b.segments.splice(b.segments.indexOf(wait) + 1, 0, after)
        } else if (wait) Object.assign(wait, meta)
        if (b.open) Object.assign(b.open, meta)
        b.start(work(), e.ts, { attempt })
        break
      }
      case 'agent_complete': b.close(e.ts); break
      case 'reflection_start': b.start('judge', e.ts, { attempt }); break
      case 'reflection_result': b.close(e.ts); break
      case 'retry': attempt = e.attempt ?? attempt + 1; b.start(work(), e.ts, { attempt }); break
      case 'agent_failed': case 'agent_degraded': case 'agent_skipped': case 'task_failed': b.close(e.ts); break
    }
  }
  return { id, label, segments: mergeAdjacent(b.finish()) }
}

const SEAM_MS = 5

/** One segment for back-to-back pieces of the same kind and call, and a seam of a few milliseconds between two events
 *  (resume → tool_done) folded into the segment before it. */
function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segments) {
    const prev = out.at(-1)
    if (prev && prev.end !== null && s.end !== null && s.end - s.start <= SEAM_MS && s.start - prev.end <= SEAM_MS) {
      out[out.length - 1] = { ...prev, end: s.end }
      continue
    }
    if (prev && prev.kind === s.kind && prev.callIndex === s.callIndex && prev.attempt === s.attempt && prev.end !== null && s.start - prev.end <= 5) {
      out[out.length - 1] = { ...prev, ...s, start: prev.start, end: s.end }
    } else out.push(s)
  }
  return out
}

function spanLane(id: string, label: string, kind: SegmentKind, starts: TimingEvent[], ends: TimingEvent[]): Lane | null {
  if (!starts.length) return null
  const segments: Segment[] = starts.map((s) => {
    const end = ends.find((e) => e.ts >= s.ts)
    return { kind, start: s.ts, end: end ? end.ts : null, attempt: 0 }
  })
  return { id, label, segments }
}

/** Lanes: plan, approve, each agent (plan order), assess (when it ran), synthesize. `now` ends a live run. */
export function buildSegments(view: RunView, now?: number): Gantt {
  const t = view.timing
  const of = (...types: TimingEvent['type'][]): TimingEvent[] => t.filter((e) => types.includes(e.type))
  const orch = (type: TimingEvent['type']): TimingEvent[] => t.filter((e) => e.type === type && e.agentId === 'orchestrator')
  const assessPause = (type: TimingEvent['type']): TimingEvent[] => t.filter((e) => e.type === type && e.agentId === 'assess')
  const terminal = of('task_complete', 'task_failed')
  const planStart = of('plan_started')
  const lanes = [
    spanLane('plan', 'plan', 'model', planStart.length ? planStart : [{ type: 'plan_started', ts: view.startedAt }], [...of('orchestrator_plan'), ...terminal]),
    spanLane('approve', 'approve', 'wait', orch('hitl_pause'), [...orch('hitl_resume'), ...terminal]),
    ...view.steps.map((s) => agentLane(s.id, `${s.id} ${s.role}`, t.filter((e) => e.agentId === s.id || e.type === 'task_failed'))),
    (() => {
      const lane = spanLane('assess', 'assess', 'judge', of('assess_start'), [...of('assess_decision'), ...terminal])
      const waits = spanLane('assess', 'assess', 'wait', assessPause('hitl_pause'), [...assessPause('hitl_resume'), ...terminal])
      return lane ? { ...lane, segments: [...lane.segments, ...(waits?.segments ?? [])].sort((a, b) => a.start - b.start) } : null
    })(),
    spanLane('synth', 'synthesize', 'model', of('synthesis_start'), terminal),
  ].filter((l): l is Lane => !!l && (l.segments.length > 0))
  const last = Math.max(view.startedAt, ...t.map((e) => e.ts))
  return { lanes, t0: Math.min(view.startedAt, ...t.map((e) => e.ts)), end: terminal.length ? terminal.at(-1)!.ts : now ?? last }
}

/** The chain of finished steps the answer waited on: from the step that finished last, back through the dependency
 *  that finished last, then the synthesis when it ran. [] until a step has finished. */
export function criticalPath(view: RunView): string[] {
  const ended = (id: string): number | undefined => {
    const a = view.agents[id]
    return a && a.endedAt && ['done', 'failed', 'skipped'].includes(a.status) ? a.endedAt : undefined
  }
  const finished = view.steps.filter((s) => ended(s.id) !== undefined)
  if (!finished.length) return []
  const path: string[] = []
  let at: string | undefined = finished.reduce((a, b) => (ended(b.id)! > ended(a.id)! ? b : a)).id
  while (at) {
    path.unshift(at)
    const deps: string[] = (view.steps.find((s) => s.id === at)?.dependsOn ?? []).filter((d) => ended(d) !== undefined)
    at = deps.length ? deps.reduce((a, b) => (ended(b)! > ended(a)! ? b : a)) : undefined
  }
  return view.timing.some((e) => e.type === 'synthesis_start') ? [...path, 'synth'] : path
}

const dur = (s: Segment, end: number): number => (s.end ?? end) - s.start

export function ganttFooter(view: RunView, gantt: Gantt): { criticalPath: string; retryMs: number; approvalWaitMs: number; judgeMs: number } {
  const all = gantt.lanes.flatMap((l) => l.segments)
  const sum = (kind: SegmentKind): number => all.filter((s) => s.kind === kind).reduce((n, s) => n + dur(s, gantt.end), 0)
  return { criticalPath: criticalPath(view).join(' → '), retryMs: sum('repair'), approvalWaitMs: sum('wait'), judgeMs: sum('judge') }
}

export const SEGMENT_LABEL: Record<SegmentKind, string> = { model: 'model', tool: 'tool', wait: 'approval wait', judge: 'judge', repair: 'repair attempt' }

/** The popover's lines for a segment (design 13). */
export function segmentDetails(lane: Lane, seg: Segment, onPath: boolean, end: number): string[] {
  const ms = dur(seg, end)
  const lines: string[] = []
  if (seg.tool) lines.push(`${seg.callIndex === 1 ? 'First tool call' : `Tool call ${seg.callIndex}`}, ${seg.tool}`)
  if (seg.kind === 'wait' && lane.id !== 'approve' && lane.id !== 'assess') {
    lines.push(seg.approvalMode ? `Approval mode: ${seg.approvalMode}${seg.approvalMode === 'asked' ? ' · decided by you' : ''}`
      : 'Pause to resume: no separate wait was logged (an older run), so this includes the tool')
  }
  if (seg.toolMs !== undefined) lines.push(`Tool execution: ${(seg.toolMs / 1000).toFixed(1)} s (wait excluded)`)
  if (seg.end === null) lines.push('Still running')
  lines.push(`On the critical path: ${onPath ? `yes, +${Math.round(ms / 1000)} s` : 'no'}`)
  return lines
}
