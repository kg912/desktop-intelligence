// Rectification R4: the blank claims drawer, from the run in the bug report. Run 0f11f3fd (chat 236ba2f3, the
// istanbul-3leg fixture) was recorded on 2026-10-13, before spec B 7a (2026-10-15) put the claims on reflection_result:
// step 1.3 "Leg 3 schedule and connection researcher" (deepseek-v4.1-flash, 15 tool calls, 5/5) passed with 28 claim
// statuses and no claims, so the drawer read nothing. The claims and the tool results are in the run's own log.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { AgentEvent, MultiAgentRunRecord } from '../../shared/types'
import { reduceRunEvents } from '../../renderer/src/lib/multiAgentRunState'
import { acceptedClaims, findQuoteRanges } from '../../renderer/src/lib/claimsView'
import { claimsFromReply, evidenceFromLog, withRecoveredClaims } from '../../main/services/multiAgentClaimRecovery'

const DIR = join(__dirname, '../../../resources/python/tests/fixtures/runs/istanbul-3leg')
const EVENTS = readFileSync(join(DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AgentEvent)
const RUN = EVENTS[0].runId
const record = (): MultiAgentRunRecord => ({ mode: 'multi-agent', runStatus: 'completed', agentGraph: [], executionTrace: EVENTS.map((e) => ({ ...e })), runId: RUN, runIds: [RUN] })

describe('the reported run, step 1.3', () => {
  it('is the run in the screenshot, and its trace carries statuses but no claims (the cause)', () => {
    expect(RUN).toBe('0f11f3fd-5cd6-4c0b-911b-738014c9a10a')
    const view = reduceRunEvents(RUN, EVENTS)
    const agent = view.agents['1.3']
    expect(agent.step.role).toBe('Leg 3 schedule and connection researcher')
    expect(agent.step.model).toBe('deepseek/deepseek-v4.1-flash')
    expect(EVENTS.filter((e) => e.type === 'tool_start' && e.agentId === '1.3')).toHaveLength(15)
    const passing = agent.reflections.at(-1)!
    expect([passing.passed, passing.score, Object.keys(passing.claimStatuses ?? {}).length, passing.claims]).toEqual([true, 5, 28, undefined])
    expect(acceptedClaims(view, '1.3')).toBeNull()  // what the drawer showed: "No claims", all 0
  })

  it('loading the run fills each gate\'s claims from the run log: 1.3 lists its 28 claims with their statuses', async () => {
    const fixed = await withRecoveredClaims(record(), DIR)
    const accepted = acceptedClaims(reduceRunEvents(RUN, fixed.executionTrace), '1.3')!
    expect(accepted.attempt).toBe(2)
    expect(accepted.score).toBe(5)
    expect(accepted.claims).toHaveLength(28)
    expect(accepted.claims.filter((c) => c.status === 'unknown')).toEqual([])
    expect(accepted.claims.filter((c) => c.status === 'unverified_declared').map((c) => c.id)).toEqual(['c23', 'c24b', 'c25'])
    expect(accepted.claims[0]).toMatchObject({
      ref: '1.3 c1', status: 'verified', claim: 'ADB-IST is operated non-stop by Turkish Airlines and Pegasus', callId: 'call_01a130fb277f760b92f0a0b6',
    })
    // Every agent of the run gets its accepted claims, the degraded one included.
    const view = reduceRunEvents(RUN, fixed.executionTrace)
    for (const id of ['1.1', '1.2', '1.3', '1.4', '1.5', '2.1']) expect(acceptedClaims(view, id)?.claims.length, id).toBeGreaterThan(0)
    // Nothing else in the trace changes: same events, same order, only `claims` added to gates that had none.
    expect(fixed.executionTrace.map((e) => [e.seq, e.type])).toEqual(EVENTS.map((e) => [e.seq, e.type]))
    expect(fixed.executionTrace.filter((e, i) => JSON.stringify({ ...e, claims: undefined }) !== JSON.stringify({ ...EVENTS[i], claims: undefined }))).toEqual([])
  })

  it('the cited tool result comes from the run log, and the quote is found in it', async () => {
    const fixed = await withRecoveredClaims(record(), DIR)
    const c1 = acceptedClaims(reduceRunEvents(RUN, fixed.executionTrace), '1.3')!.claims[0]
    const evidence = (await evidenceFromLog(DIR, '1.3', c1.callId!))!
    expect(evidence).toMatchObject({ agentId: '1.3', callId: c1.callId, name: 'builtin__brave_web_search', ok: true })
    expect(findQuoteRanges(evidence.result, c1.quote!).length).toBeGreaterThan(0)
    expect(await evidenceFromLog(DIR, '1.3', 'call_nope')).toBeNull()
    expect(await evidenceFromLog(join(DIR, 'missing'), '1.3', c1.callId!)).toBeNull()
  })

  it('a run with its claims already on the gates, or without a log, is returned as it is', async () => {
    const plain = record()
    expect(await withRecoveredClaims(plain, join(DIR, 'missing'))).toBe(plain)
    const current = { ...record(), executionTrace: [{ runId: 'r', seq: 1, ts: 1, type: 'reflection_result', agentId: '1.1', attempt: 0, score: 5, passed: true, reason: 'ok', claims: [] }] as unknown as AgentEvent[] }
    expect(await withRecoveredClaims(current, DIR)).toBe(current)
  })
})

describe('claimsFromReply (the sidecar\'s block rules)', () => {
  it('reads the last ```claims block; applies a ```claims_patch to the previous claims (drop = unverified)', () => {
    const prev = claimsFromReply('Report.\n```claims\n[{"id": "c1", "claim": "A", "callId": "x", "quote": "a quote long enough"}, {"id": "c2", "claim": "B", "unverified": true}]\n```')!
    expect(prev).toEqual([{ id: 'c1', claim: 'A', callId: 'x', quote: 'a quote long enough' }, { id: 'c2', claim: 'B', unverified: true }])
    expect(claimsFromReply('```claims_patch\n{"replace": [{"id": "c2", "claim": "B2", "snippets": ["S1.1"]}, {"id": "c3", "claim": "C", "source": "1.1"}], "drop": ["c1"]}\n```', prev)).toEqual([
      { id: 'c1', claim: 'A', unverified: true }, { id: 'c2', claim: 'B2', snippets: ['S1.1'] }, { id: 'c3', claim: 'C', source: '1.1' },
    ])
    expect(claimsFromReply('no block')).toBeNull()
    expect(claimsFromReply('```claims\nnot json\n```')).toBeNull()
  })
})
