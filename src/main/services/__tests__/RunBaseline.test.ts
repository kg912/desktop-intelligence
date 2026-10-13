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
    expect(s.calls).toEqual({ planner: 1, worker: 40, judge: 6, synthesizer: 1 })
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
