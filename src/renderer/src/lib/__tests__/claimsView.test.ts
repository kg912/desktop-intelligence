// Spec B 7a: claim chips and the evidence drawer's view-model. Chips never imply a status the verifier did not compute.
import { describe, it, expect } from 'vitest'
import { acceptedClaims, claimLabel, claimTone, findQuoteRanges, linkClaims, answerCounts, noClaimsReason } from '../claimsView'
import { reduceRunEvents } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...e }) as unknown as AgentEvent
const step = (id: string) => ({ id, label: `Step ${id}`, stage: 'worker', role: id === '1.2' ? 'Flights' : 'R', model: 'm', phase: 1, dependsOn: [] })
const CLAIMS_12 = [
  { id: 'c1', claim: 'ASR-IST has 8+ daily flights', snippets: ['S1.1'], callId: 'call_a', quote: 'eight or more daily flights' },
  { id: 'c3', claim: 'Direct ASR-ADB flights Tue / Thu / Sat', snippets: ['S17.3'], callId: 'call_q', quote: 'operate on Tuesday, Thursday and Saturday' },
  { id: 'c5', claim: 'Exact departure times for the chosen date', unverified: true },
  { id: 'c6', claim: 'A figure with a bad quote', callId: 'call_x', quote: 'not there' },
]
export const VIEW_EVENTS = [
  ev(1, { type: 'orchestrator_plan', steps: [step('1.2'), step('2.1')], checklist: [{ id: 'r1', text: 'Days', scope: '1.2' }] }),
  ev(2, { type: 'reflection_result', agentId: '1.2', attempt: 0, score: 2, passed: false, reason: 'x', claimStatuses: { c1: 'quote_not_found' }, claims: [CLAIMS_12[0]] }),
  ev(3, { type: 'reflection_result', agentId: '1.2', attempt: 1, score: 4, passed: true, reason: 'ok',
    claimStatuses: { c1: 'verified_repointed', c3: 'verified', c5: 'unverified_declared', c6: 'quote_not_found' }, claims: CLAIMS_12 }),
  ev(4, { type: 'reflection_result', agentId: '2.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: { c4: 'verified' },
    claims: [{ id: 'c4', claim: 'No scheduled direct flight between ASR and ADB that week', snippets: ['S9.1'], callId: 'call_9', quote: 'no direct flight' }] }),
  ev(5, { type: 'ledger_update', ledger: { r1: { status: 'conflicted', claimIds: ['1.2 c3', '2.1 c4'], conflict: { claimIds: ['1.2 c3', '2.1 c4'], confirmed: false } } },
    counts: { verified: 0, unverified: 0, conflicted: 1, missing: 0, pending: 0 } }),
]

describe('claims view-model', () => {
  const view = reduceRunEvents('r', VIEW_EVENTS)

  it('takes the accepted attempt\'s claims and statuses, with conflicts from the ledger', () => {
    const accepted = acceptedClaims(view, '1.2')!
    expect(accepted).toMatchObject({ attempt: 1, attempts: 2, score: 4 })
    expect(accepted.claims.map((c) => [c.ref, c.status, c.conflictWith ?? null])).toEqual([
      ['1.2 c1', 'verified_repointed', null], ['1.2 c3', 'verified', ['2.1 c4']], ['1.2 c5', 'unverified_declared', null], ['1.2 c6', 'quote_not_found', null],
    ])
    expect(acceptedClaims(view, '9.9')).toBeNull()
  })

  it('tones and labels follow the computed status only', () => {
    expect(claimTone('verified', false)).toBe('ok')
    expect(claimTone('verified_fragments_repointed', false)).toBe('ok')
    expect(claimTone('unverified_declared', false)).toBe('warn')
    expect(claimTone('verified', true)).toBe('bad')
    expect(claimTone('quote_not_found', false)).toBe('neutral')  // a failed check is never shown as verified or unverified
    const [c1, c3, c5, c6] = acceptedClaims(view, '1.2')!.claims
    expect([claimLabel(c1), claimLabel(c3), claimLabel(c5), claimLabel(c6)]).toEqual(['verified · re-pointed', 'possible conflict', 'unverified · declared', 'failed check'])
  })

  it('links agent and claim markers as status-coloured chips', () => {
    const ids = new Set(['1.2', '2.1'])
    expect(linkClaims('Direct [1.2] flights [1.2 c3], no service [2.1]. Bags [1.2 c5]. Odd [1.2 c6]. Not an id [3.3].', ids, view)).toBe(
      'Direct [1.2](#agent-1.2) flights [1.2 c3 · possible conflict](#claim-bad-1.2~c3), no service [2.1](#agent-2.1). ' +
      'Bags [1.2 c5 · unverified](#claim-warn-1.2~c5). Odd [1.2 c6](#claim-neutral-1.2~c6). Not an id [3.3].')
    // Inside an agent's own report, [c1] is that agent's claim.
    expect(linkClaims('Daily [c1].', ids, view, '1.2')).toBe('Daily [1.2 c1](#claim-ok-1.2~c1).')
    // A claim with no computed status (none known) is a plain chip, not green.
    expect(linkClaims('[2.1 c9]', ids, view)).toBe('[2.1 c9](#claim-neutral-2.1~c9)')
  })

  it('counts the answer\'s claims for the header chips', () => {
    expect(answerCounts(view)).toEqual({ verified: 1, unverified: 1, conflicted: 2 })  // c6 failed its check: not counted
  })
})

describe('findQuoteRanges: highlight maps back to the original text', () => {
  it('exact', () => {
    const text = '[S17.3] Kayseri (ASR) to Izmir\n…schedules change. Flights from Kayseri operate on Tuesday, Thursday and Saturday in summer.'
    const [[start, end]] = findQuoteRanges(text, 'operate on Tuesday, Thursday and Saturday')
    expect(text.slice(start, end)).toBe('operate on Tuesday, Thursday and Saturday')
  })

  it('after normalise_quote differences: case, curly quotes, dashes, emphasis, thousands separators, whitespace, entities', () => {
    const text = 'Taxi:   the **“door‑to‑door”** fare is 1,400 TRY &amp; up\n to   2,100 TRY.'
    const ranges = findQuoteRanges(text, 'the "door-to-door" fare is 1400 try & up to 2100 TRY')
    expect(ranges).toHaveLength(1)
    const [start, end] = ranges[0]
    expect(text.slice(start, end)).toBe('the **“door‑to‑door”** fare is 1,400 TRY &amp; up\n to   2,100 TRY')
  })

  it('a character that lengthens when lower-cased does not shift the highlight', () => {
    const text = 'İzmir (ADB): Flights operate daily.'
    const [[start, end]] = findQuoteRanges(text, 'flights operate daily')
    expect(text.slice(start, end)).toBe('Flights operate daily')
  })

  it('a "..."-stitched quote highlights each fragment in order; a missing quote highlights nothing', () => {
    const text = 'Pegasus flies daily. Unrelated text here. SunExpress flies on Mondays.'
    const ranges = findQuoteRanges(text, 'Pegasus flies daily ... SunExpress flies on Mondays')
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(['Pegasus flies daily', 'SunExpress flies on Mondays'])
    expect(findQuoteRanges(text, 'not in the text at all')).toEqual([])
    expect(findQuoteRanges(text, 'SunExpress flies on Mondays ... Pegasus flies daily')).toEqual([])  // out of order
  })
})

// Rectification R4: claims come from agent_complete when no gate carries them; when there are none, say why.
describe('acceptedClaims fallback and the empty state', () => {
  const e = (seq: number, x: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq, ...x }) as unknown as AgentEvent
  const plan = e(1, { type: 'orchestrator_plan', steps: [{ id: '1.1', label: 'Leg 1', stage: 'worker', role: 'Leg', model: 'm', phase: 1, dependsOn: [] }] })
  const start = e(2, { type: 'agent_start', agentId: '1.1', role: 'Leg', model: 'm', attempt: 0 })
  const CLAIMS = [{ id: 'c1', claim: 'A', callId: 'x', quote: 'a quote long enough' }, { id: 'c2', claim: 'B', unverified: true }]
  const done = (seq: number, attempt: number, extra: Record<string, unknown> = {}) =>
    e(seq, { type: 'agent_complete', agentId: '1.1', attempt, output: 'o', tokenCount: 1, costUsd: 0.1, ...extra })

  it('budget reached right after the answer: no gate, the answer\'s claims and statuses are used', () => {
    const view = reduceRunEvents('r', [plan, start, done(3, 0, { claims: CLAIMS, claimStatuses: { c1: 'verified', c2: 'unverified_declared' }, runTotals: { costUsd: 1, tokens: 1, budgetReached: true } })])
    const accepted = acceptedClaims(view, '1.1')!
    expect(accepted.claims.map((c) => [c.ref, c.status])).toEqual([['1.1 c1', 'verified'], ['1.1 c2', 'unverified_declared']])
    expect([accepted.attempt, accepted.attempts, accepted.score]).toEqual([0, 1, 0])
  })

  it('a gate without claims (an older sidecar) falls back to that attempt\'s answer, statuses from the gate', () => {
    const view = reduceRunEvents('r', [plan, start, done(3, 0, { claims: CLAIMS }),
      e(4, { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: { c1: 'verified_repointed', c2: 'unverified_declared' } })])
    expect(acceptedClaims(view, '1.1')!.claims.map((c) => c.status)).toEqual(['verified_repointed', 'unverified_declared'])
  })

  it('a retry\'s answer is matched to its own gate, not the first one', () => {
    const view = reduceRunEvents('r', [plan, start, done(3, 0, { claims: [CLAIMS[0]], claimStatuses: { c1: 'quote_not_found' } }),
      e(4, { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 1, passed: false, reason: 'x', claimStatuses: { c1: 'quote_not_found' } }),
      e(5, { type: 'retry', agentId: '1.1', attempt: 1, reason: 'x' }), done(6, 1, { claims: CLAIMS }),
      e(7, { type: 'reflection_result', agentId: '1.1', attempt: 1, score: 5, passed: true, reason: 'ok', claimStatuses: { c1: 'verified', c2: 'unverified_declared' } })])
    const accepted = acceptedClaims(view, '1.1')!
    expect(accepted.claims.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect([accepted.attempt, accepted.attempts]).toEqual([1, 2])
  })

  it('says why there are no claims', () => {
    const noBlock = reduceRunEvents('r', [plan, start, done(3, 0, { runTotals: { costUsd: 1, tokens: 1, budgetReached: true } })])
    expect(noClaimsReason(noBlock, '1.1')).toBe('This step ended without a claims check (budget reached).')
    const none = reduceRunEvents('r', [plan, start, done(3, 0, { claims: [], claimStatuses: {} }),
      e(4, { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: {}, claims: [] })])
    expect(acceptedClaims(none, '1.1')!.claims).toEqual([])
    expect(noClaimsReason(none, '1.1')).toBe('This step produced no claims.')
    const old = reduceRunEvents('r', [plan, start, done(3, 0), e(4, { type: 'reflection_result', agentId: '1.1', attempt: 0, score: 5, passed: true, reason: 'ok', claimStatuses: { c1: 'verified' } })])
    expect(noClaimsReason(old, '1.1')).toBe('This run was saved before claims were recorded, and its log is not available, so they cannot be shown.')
    expect(noClaimsReason(reduceRunEvents('r', [plan]), '1.1')).toBe('This step has not finished yet.')
    expect(noClaimsReason(reduceRunEvents('r', [plan, start, e(3, { type: 'agent_failed', agentId: '1.1', reason: 'x' })]), '1.1')).toBe('This step failed, so no answer was accepted.')
    expect(noClaimsReason(reduceRunEvents('r', [plan, e(3, { type: 'agent_skipped', agentId: '1.1', reason: 'condition not met', condition: 'c', basis: '' })]), '1.1')).toBe('This step was skipped, so it made no claims.')
  })
})
