// Spec B 7a: claim chips and the evidence drawer's view-model. Chips never imply a status the verifier did not compute.
import { describe, it, expect } from 'vitest'
import { acceptedClaims, claimLabel, claimTone, findQuoteRanges, linkClaims, answerCounts } from '../claimsView'
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
