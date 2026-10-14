/**
 * Spec A (multi-agent-reliability-and-cost.md) Phase 0: summariseRun on the recorded Istanbul → Cappadocia → İzmir run.
 * Every number in the spec's §0 table must come out of the fixture.
 */
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { findAnomalies, readRun, summariseRun } from '../MultiAgentRunLogger'

const FIXTURE = join(__dirname, '../../../../resources/python/tests/fixtures/runs/istanbul-3leg')
const within = (actual: number, expected: number, pct = 1): void => {
  expect(Math.abs(actual - expected) / expected, `${actual} vs ${expected}`).toBeLessThanOrEqual(pct / 100)
}

describe('summariseRun on the istanbul-3leg fixture', async () => {
  const s = summariseRun(await readRun(FIXTURE))

  it('cost: total, by role, and the judge outspending the workers', () => {
    expect(s.costUsd).toBeCloseTo(0.63, 2)
    expect(s.calls).toEqual({ planner: 1, worker: 40, judge: 6, assess: 0, synthesizer: 1 })
    expect(s.costByRole.judge).toBeCloseTo(0.33, 2)
    expect(s.costByRole.worker).toBeCloseTo(0.29, 2)
    expect(s.costByRole.synthesizer).toBeCloseTo(0.009, 3)
    within(s.costByRole.planner + s.costByRole.worker + s.costByRole.judge + s.costByRole.synthesizer, s.costUsd, 0.0001)
  })

  it('retries: 8, costing 0.11 USD (18% of spend)', () => {
    expect(s.retries).toBe(8)
    expect(s.retryCostUsd).toBeCloseTo(0.11, 2)
    expect(Math.round((100 * s.retryCostUsd) / s.costUsd)).toBe(18)
    expect(s.agents['1.1'].attempts).toBe(2)
    expect(s.agents['1.2'].attempts).toBe(3)
  })

  it('judge: 30–128k-token inputs (spec §0 says 64–129k), ~92% of its output is reasoning', () => {
    expect(s.judge.calls).toBe(6)
    expect(Math.min(...s.judge.inputTokensPerCall)).toBeGreaterThanOrEqual(25_000)
    expect(Math.max(...s.judge.inputTokensPerCall)).toBeLessThanOrEqual(129_000 * 1.01)
    expect(Math.round((100 * s.judge.reasoningTokens) / s.judge.outputTokens)).toBe(92)
  })

  it('claims: 24 failing at attempt 0, no agent but the merge step passing', () => {
    expect(s.claims.attempt0.failing).toBe(24)
    expect(s.claims.attempt0.byFailureClass).toEqual({ mismatch: 24 })
    expect(s.claims.attempt0.agentsPassed).toEqual(['2.1'])
    expect(s.claims.attempt0.agents).toBe(6)
  })

  it('context: 1.77M worker prompt tokens for ~250k of unique tool text (about 7x)', () => {
    within(s.workerPromptTokens, 1_770_000)
    within(s.uniqueToolTokens, 250_000, 1.5)
    expect(s.amplification).toBeCloseTo(7, 0)
    expect(s.cachedTokens).toBeNull() // not logged before Phase 8
  })

  it('tool results: 89 calls, median 12.8 KB', () => {
    expect(s.toolResults.count).toBe(89)
    within(s.toolResults.medianChars, 12_800)
  })

  it('time: about 7 minutes, 1.2 the straggler on the critical path into the merge step', () => {
    within(s.wallMs!, 7 * 60_000, 2)
    expect(s.criticalPath).toEqual(['1.2', '2.1'])
    expect(s.removedSteps).toEqual([]) // the recorded run kept its merge step (spec A Phase 4 drops it)
    within(s.agents['1.2'].endMs, 268_000)
    for (const id of ['1.1', '1.3', '1.4', '1.5']) expect(s.agents[id].endMs).toBeLessThanOrEqual(186_000)
    within(s.agents['2.1'].endMs - s.agents['1.2'].endMs, 99_000)
  })

  it('approvals: the longest wait (45.7 s) sat on the critical path; plan approval counted apart', () => {
    expect(s.approvals.count).toBe(89)
    within(s.approvals.maxWaitMs, 45_700)
    expect(s.approvals.maxWaitAgent).toBe('2.1')
    within(s.approvals.planWaitMs, 38_100)
  })

  it('p90 agent cost is tracked next to the mean', () => {
    expect(s.p90AgentCostUsd).toBeGreaterThan(s.meanAgentCostUsd)
  })
})

describe('summariseRun claim classes (spec A Phase 1)', () => {
  it('uses the sidecar failure classes when sent, and counts every verified_* status as passing', () => {
    const meta = { schema: 1, runId: 'r', chatId: 'c', chatTitle: '', task: '', startedAt: 0, endedAt: 10, status: 'completed', config: {} } as never
    const gate = (agentId: string, claimStatuses: Record<string, string>, claimFailureClasses?: Record<string, string>) =>
      ({ type: 'reflection_result', runId: 'r', seq: 1, ts: 5, agentId, attempt: 0, score: 1, passed: false, reason: '', claimStatuses, claimFailureClasses }) as never
    const s = summariseRun({ meta, records: [], events: [
      gate('1.1', { c1: 'verified_fragments', c2: 'verified_repointed', c3: 'verified_fragments_repointed' }),
      gate('1.2', { c1: 'quote_not_found', c2: 'quote_found_elsewhere' }, { c1: 'ellipsis_fragment_missing', c2: 'wrong_call' }),
    ] })
    expect(s.claims.attempt0.agentsPassed).toEqual(['1.1'])
    expect(s.claims.attempt0.byFailureClass).toEqual({ ellipsis_fragment_missing: 1, wrong_call: 1 })
  })
})

describe('plan_step_removed (spec A Phase 4)', () => {
  it('is listed in the summary and as a run anomaly', () => {
    const meta = { schema: 1, runId: 'r', chatId: 'c', chatTitle: '', task: '', startedAt: 0, endedAt: 10, status: 'completed', config: {} } as never
    const removed = { type: 'plan_step_removed', runId: 'r', seq: 1, ts: 1, stepId: '2.1', label: 'Merge all findings', reason: 'a final merge step: the synthesizer merges every step\'s output' } as never
    expect(summariseRun({ meta, events: [removed], records: [] }).removedSteps).toEqual(['2.1'])
    expect(findAnomalies(meta, [removed], [], 0, 0)).toEqual([{ kind: 'plan_step_removed', message: 'plan step 2.1 ("Merge all findings") removed: a final merge step: the synthesizer merges every step\'s output', ref: 'planner.md' }])
  })
})

describe('cache figures (spec A Phase 8)', () => {
  it('sums cached tokens and gives each agent its cache hit rate; older records leave them null', () => {
    const meta = { schema: 1, runId: 'r', chatId: 'c', chatTitle: '', task: '', startedAt: 0, endedAt: 10, status: 'completed', config: {} } as never
    const call = (seq: number, agentId: string, prompt: number, cached: number | undefined) => ({
      schema: 1, runId: 'r', chatId: 'c', seq, kind: 'model', role: 'worker', agentId, attempt: 0, timing: { startedAt: 1, endedAt: 2, ms: 1 },
      usage: { promptTokens: prompt, completionTokens: 1, reasoningTokens: null, costUsd: 0, generationId: null, ...(cached !== undefined && { cachedTokens: cached }) },
    }) as never
    const start = (agentId: string) => ({ type: 'agent_start', runId: 'r', seq: 1, ts: 1, agentId, role: 'R', model: 'm', attempt: 0 }) as never
    const s = summariseRun({ meta, events: [start('1.1'), start('1.2')], records: [call(1, '1.1', 1000, 0), call(2, '1.1', 3000, 3000), call(3, '1.2', 500, undefined)] })
    expect(s.cachedTokens).toBe(3000)
    expect(s.agents['1.1']).toMatchObject({ cachedTokens: 3000, cacheHitRate: 0.75 })
    expect(s.agents['1.2']).toMatchObject({ cachedTokens: null, cacheHitRate: null })
  })
})

describe('approval observability (spec A Phase 9)', () => {
  it('the fixture: the 45.7 s wait on 2.1 (critical path) is flagged; shorter or off-path pauses are not', async () => {
    const run = await readRun(FIXTURE)
    const flagged = findAnomalies(run.meta, run.events, run.records, 0, 0).filter((a) => a.kind === 'approval_wait')
    expect(flagged).toEqual([{ kind: 'approval_wait', message: 'agent 2.1 waited 45.7 s for approval of brave_web_search on the critical path (pause to resume; no separate wait was logged)', ref: 'agent-2.1.md' }])
  })

  it('uses the logged wait (not tool time) when Electron reported it, and splits the summary by mode', () => {
    const meta = { schema: 1, runId: 'r', chatId: 'c', chatTitle: '', task: '', startedAt: 0, endedAt: 100_000, status: 'completed', config: {} } as never
    const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq * 1000, ...e }) as never
    const events = [
      ev(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'A', role: 'R', dependsOn: [] }] }),
      ev(2, { type: 'agent_start', agentId: '1.1', role: 'R', model: 'm', attempt: 0 }),
      ev(3, { type: 'hitl_pause', agentId: '1.1', role: 'R', toolName: 'brave_web_search', serverName: 'builtin', args: {} }),
      ev(60, { type: 'hitl_resume', agentId: '1.1', approved: true, approvalMode: 'asked', waitMs: 50_000, toolMs: 7_000 }),
      ev(61, { type: 'tool_done', agentId: '1.1', callId: 'a', ok: true, durationMs: 57_000, resultPreview: '', resultChars: 1, approvalMode: 'asked', waitMs: 50_000, toolMs: 7_000 }),
      ev(62, { type: 'hitl_pause', agentId: '1.1', role: 'R', toolName: 'brave_web_search', serverName: 'builtin', args: {} }),
      ev(92, { type: 'hitl_resume', agentId: '1.1', approved: true, approvalMode: 'trusted', waitMs: 0, toolMs: 30_000 }),
      ev(93, { type: 'tool_done', agentId: '1.1', callId: 'b', ok: true, durationMs: 30_000, resultPreview: '', resultChars: 1, approvalMode: 'trusted', waitMs: 0, toolMs: 30_000 }),
      ev(94, { type: 'agent_complete', agentId: '1.1', attempt: 0, output: 'x', tokenCount: 1, costUsd: 0 }),
    ]
    // A 30 s TOOL is not an approval wait; the 50 s person wait is.
    expect(findAnomalies(meta, events, [], 0, 0).filter((a) => a.kind === 'approval_wait').map((a) => a.message))
      .toEqual(['agent 1.1 waited 50.0 s for approval of brave_web_search on the critical path'])
    expect(summariseRun({ meta, events, records: [] }).approvals).toMatchObject({ count: 2, waitMs: 50_000, toolMs: 37_000, byMode: { asked: 1, trusted: 1 }, maxWaitMs: 50_000, maxWaitAgent: '1.1' })
  })
})
