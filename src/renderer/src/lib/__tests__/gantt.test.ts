// Spec B 7c: Gantt segments and the critical path, on the recorded Istanbul run.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { buildSegments, criticalPath, ganttFooter } from '../gantt'
import { reduceRunEvents } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

const EVENTS = readFileSync(join(__dirname, '../../../../../resources/python/tests/fixtures/runs/istanbul-3leg/events.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
const RUN = EVENTS[0].runId
const s = (ms: number): number => Math.round(ms / 100) / 10

describe('buildSegments on the Istanbul fixture', () => {
  const view = reduceRunEvents(RUN, EVENTS)
  const gantt = buildSegments(view)

  it('lanes: plan, approve, each agent, synthesize', () => {
    expect(gantt.lanes.map((l) => l.id)).toEqual(['plan', 'approve', '1.1', '1.2', '1.3', '1.4', '1.5', '2.1', 'synth'])
    expect(s(gantt.end - gantt.t0)).toBe(426.7)
    const plan = gantt.lanes[0].segments
    expect(plan.map((x) => [x.kind, s(x.end! - x.start)])).toEqual([['model', 5.6]])
    expect(gantt.lanes[1].segments.map((x) => [x.kind, s(x.end! - x.start)])).toEqual([['wait', 38.1]])  // the plan approval
  })

  it('an agent: model, tool and the approval wait before each tool (pause to resume when no waitMs was logged), judge, repair', () => {
    const lane = gantt.lanes.find((l) => l.id === '2.1')!
    // This run predates spec A Phase 9: a tool call is one pause with no logged split, so it is all "approval wait".
    const kinds = [...new Set(lane.segments.map((x) => x.kind))]
    expect(kinds.sort()).toEqual(['judge', 'model', 'wait'])
    const firstWait = lane.segments.find((x) => x.kind === 'wait')!
    expect(s(firstWait.end! - firstWait.start)).toBe(45.7)  // 2.1's approval wait (spec A Phase 9's anomaly)
    expect(firstWait).toMatchObject({ tool: 'brave_web_search', callIndex: 1 })
    const lane12 = gantt.lanes.find((l) => l.id === '1.2')!
    expect(lane12.segments.some((x) => x.kind === 'repair')).toBe(true)  // attempts 1 and 2 of 1.2
    // 1.2's first two gates were the mechanical claims check (no judge call, no time); its third went to the judge.
    expect(lane12.segments.filter((x) => x.kind === 'judge').length).toBe(1)
    // Segments of a lane never overlap and never run backwards.
    for (const l of gantt.lanes) {
      for (let i = 0; i < l.segments.length; i++) {
        const x = l.segments[i]
        expect(x.end! >= x.start).toBe(true)
        if (i) expect(x.start >= l.segments[i - 1].end!).toBe(true)
      }
    }
  })

  it('critical path 1.2 → 2.1 → synth, and the footer totals', () => {
    expect(criticalPath(view)).toEqual(['1.2', '2.1', 'synth'])
    const footer = ganttFooter(view, gantt)
    expect(footer.criticalPath).toBe('1.2 → 2.1 → synth')
    expect(footer.retryMs).toBeGreaterThan(0)
    expect(s(footer.approvalWaitMs)).toBeGreaterThan(45.7)
    expect(footer.judgeMs).toBeGreaterThan(0)
  })
})

describe('a run still in progress', () => {
  it('renders open-ended segments (end null) for what has not finished', () => {
    const cut = EVENTS.findIndex((e) => e.type === 'tool_start' && (e as { agentId?: string }).agentId === '1.3')
    const view = reduceRunEvents(RUN, EVENTS.slice(0, cut + 1))
    const gantt = buildSegments(view, EVENTS[cut].ts + 5_000)
    const lane = gantt.lanes.find((l) => l.id === '1.3')!
    expect(lane.segments.at(-1)).toMatchObject({ kind: 'tool', end: null })
    expect(gantt.lanes.some((l) => l.id === 'synth')).toBe(false)
    expect(gantt.end).toBe(EVENTS[cut].ts + 5_000)
    expect(criticalPath(view)).toEqual([])  // nothing has finished on a path to the answer yet
  })
})

describe('a tool call with spec A Phase 9 timing', () => {
  it('splits the pause into the person\'s wait and the tool\'s own time', () => {
    const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...e }) as unknown as AgentEvent
    const steps = [{ id: '1.1', label: 'x', stage: 'worker', role: 'R', model: 'm', phase: 1, dependsOn: [] }]
    const view = reduceRunEvents('r', [
      ev(1_000, { type: 'orchestrator_plan', steps }), ev(2_000, { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 }),
      ev(5_000, { type: 'tool_start', agentId: '1.1', attempt: 0, callId: 'c1', tool: 'brave_search', server: 'builtin', argsPreview: '' }),
      ev(5_001, { type: 'hitl_pause', agentId: '1.1', role: 'R', toolName: 'brave_search', serverName: 'builtin', args: {} }),
      ev(52_801, { type: 'hitl_resume', agentId: '1.1', approved: true, approvalMode: 'asked', waitMs: 45_700, toolMs: 2_100 }),
      ev(52_802, { type: 'tool_done', agentId: '1.1', attempt: 0, callId: 'c1', ok: true, durationMs: 47_802, resultPreview: '', resultChars: 1, approvalMode: 'asked', waitMs: 45_700, toolMs: 2_100 }),
      ev(60_000, { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'o', tokenCount: 1, costUsd: 0 }),
    ])
    const lane = buildSegments(view, 61_000).lanes.find((l) => l.id === '1.1')!
    // The tool segment is Electron's 2,100 ms plus the sidecar's 2 ms around the pause.
    expect(lane.segments.map((x) => [x.kind, x.end! - x.start])).toEqual([['model', 3_000], ['wait', 45_700], ['tool', 2_102], ['model', 7_198]])
    expect(lane.segments[1]).toMatchObject({ approvalMode: 'asked', waitMs: 45_700, toolMs: 2_100, tool: 'brave_search', callIndex: 1 })
  })
})
