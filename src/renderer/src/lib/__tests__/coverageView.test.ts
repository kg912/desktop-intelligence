// Spec B 7b: the coverage matrix and the assess card's view-model. Matrix snapshot on the Istanbul fixture's real ledger.
import { describe, it, expect } from 'vitest'
import { coverageMatrix, ledgerChips, stopRules, timelineStrip, stepBadge } from '../coverageView'
import { reduceRunEvents } from '../multiAgentRunState'
import type { AgentEvent } from '../../../../shared/types'
import FIXTURE from './fixtures/istanbul-ledger.json'

const ev = (seq: number, e: Record<string, unknown>) => ({ runId: 'r', seq, ts: seq * 1000, ...e }) as unknown as AgentEvent
const plan = ev(1, { type: 'orchestrator_plan', steps: FIXTURE.steps, checklist: FIXTURE.checklist })
const ledger = ev(2, { type: 'ledger_update', ledger: FIXTURE.ledger, counts: FIXTURE.counts })

describe('coverage matrix (spec B 7b)', () => {
  it('Istanbul fixture: requirement topics × leg steps, cells from the ledger', () => {
    const m = coverageMatrix(reduceRunEvents('r', [plan, ledger]))!
    expect(m.title).toBe('Acceptance checklist: 18 requirements')
    const text = [`| ${['Requirement', ...m.columns.map((c) => `${c.label} ${c.scope}`)].join(' | ')} |`,
      ...m.rows.map((r) => `| ${[r.topic, ...m.columns.map((c) => r.cells[c.scope]?.label ?? '')].join(' | ')} |`)].join('\n')
    expect(text).toMatchInlineSnapshot(`
      "| Requirement | Leg 1 schedule and ground-transfer researcher 1.1 | Leg 2 schedule and feasibility researcher 1.2 | Leg 3 schedule and connection researcher 1.3 |
      | Airlines operating | ✓ 1.1 1.5 | ✓ 1.2 1.5 | ✓ 1.3 |
      | Days of operation | ✓ 1.1 | ⚡ 1.2 vs 1.5 | ✓ 1.3 |
      | Exact-date departure times | ? 1.1 | ? 1.2 | ? 1.3 |
      | Baggage allowance | ⚡ 1.1 vs 1.4 | ✓ 1.2 1.4 | ⚡ 1.3 vs 1.4 |
      | Airport transfer | ✓ 1.1 1.5 | ✓ 1.2 1.5 | ✓ 1.3 1.5 |
      | Risk / fallback | ✓ 1.1 1.5 | ✓ 1.5 | ✓ 1.3 |"
    `)
    expect(ledgerChips(FIXTURE.counts)).toEqual([
      { tone: 'ok', text: '12 verified' }, { tone: 'warn', text: '3 unverified' }, { tone: 'bad', text: '3 conflicted' }, { tone: 'neutral', text: '0 missing' }])
    // A conflict cell carries both claims for the drawer, and says "possible" until the assess call confirms it.
    const days2 = m.rows[1].cells['1.2']!
    expect(days2).toMatchObject({ itemId: 'days-2', tone: 'bad', refs: ['1.2 c2', '1.5 c16'], title: 'Days of operation, leg 2, and whether it runs in December: possible conflict' })
  })

  it('no checklist → no matrix; a requirement with no topic is its own row; pending and missing cells', () => {
    expect(coverageMatrix(reduceRunEvents('r', [ev(1, { type: 'orchestrator_plan', steps: FIXTURE.steps })]))).toBeNull()
    const v = reduceRunEvents('r', [
      ev(1, { type: 'orchestrator_plan', steps: [FIXTURE.steps[0]], checklist: [{ id: 'a', text: 'Budget under 2,000 EUR', scope: 'global' }, { id: 'b', text: 'Leg 1 airlines', scope: '1.1' }] }),
      ev(2, { type: 'ledger_update', ledger: { a: { status: 'missing', claimIds: [] }, b: { status: 'pending', claimIds: [] } }, counts: { verified: 0, unverified: 0, conflicted: 0, missing: 1, pending: 1 } }),
    ])
    const m = coverageMatrix(v)!
    expect(m.columns.map((c) => c.scope)).toEqual(['1.1', 'global'])
    expect(m.rows.map((r) => [r.topic, r.cells['1.1']?.label ?? '', r.cells.global?.label ?? ''])).toEqual([['Budget under 2,000 EUR', '', '· missing'], ['Leg 1 airlines', '· pending', '']])
  })
})

const RULES = { checklist: { open: 7, total: 18 }, waves: { used: 1, max: 2 }, budget: { spentUsd: 0.63, capUsd: 1 }, progress: 'first', tools: 'partly' }

describe('assess card view-model (spec B 7b)', () => {
  it('stop-rule table as design 12 words it', () => {
    expect(stopRules(RULES as never)).toEqual([
      { label: 'Checklist complete', value: 'no · 7 open', tone: 'bad' },
      { label: 'Wave cap', value: '1 of 2 used', tone: 'mono' },
      { label: 'Budget', value: '0.63 of 1.00 USD', tone: 'mono' },
      { label: 'Progress since last wave', value: 'n/a (first)', tone: 'ok' },
      { label: 'A tool can close the gap', value: 'partly', tone: 'warn' },
    ])
    expect(stopRules({ ...RULES, checklist: { open: 0, total: 18 }, progress: 'none', tools: 'none' } as never).map((r) => [r.value, r.tone]))
      .toEqual([['yes', 'ok'], ['1 of 2 used', 'mono'], ['0.63 of 1.00 USD', 'mono'], ['none', 'bad'], ['none', 'bad']])
  })

  it('a follow-up step\'s badge says what it closes, from the ledger', () => {
    const v = reduceRunEvents('r', [plan, ledger])
    expect(stepBadge(v, { covers: ['days-2', 'bag-1'] })).toBe('resolves 2 conflicts')
    expect(stepBadge(v, { covers: ['times-1'] })).toBe('checks 1 unverified')
    expect(stepBadge(v, { covers: [] })).toBe('')
  })

  it('the run timeline strip: plan → workers → assess: follow_up → wave 2 → assess: done → synthesize', () => {
    const decision = (seq: number, wave: number, decision: string) =>
      ev(seq, { type: 'assess_decision', wave, decision, reason: '', steps: [], unclosable: [], costUsd: 0, durationMs: 0, model: '', rules: RULES })
    const v = reduceRunEvents('r', [plan, decision(3, 1, 'follow_up'), ev(4, { type: 'wave_start', n: 2, steps: [] }), decision(5, 2, 'done'), ev(6, { type: 'synthesis_start' })])
    expect(timelineStrip(v)).toEqual([
      { text: 'plan', tone: 'neutral' }, { text: 'workers', tone: 'neutral' }, { text: 'assess: follow_up', tone: 'bad' }, { text: 'wave 2', tone: 'neutral' },
      { text: 'assess: done', tone: 'bad' }, { text: 'synthesize', tone: 'neutral' }])
  })
})
