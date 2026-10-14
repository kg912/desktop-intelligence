// Spec B 7b (design 12): the coverage matrix and the assess card's view-model (pure).
import type { AgentStep, AssessRules, LedgerStatus } from '../../../shared/types'
import type { ChipTone } from './claimsView'
import type { RunView } from './multiAgentRunState'

export interface MatrixCell {
  itemId: string
  status: LedgerStatus
  /** "✓ 1.1 1.5" · "? 1.2" · "⚡ 1.2 vs 1.5" · "· missing" · "· pending" */
  label: string
  tone: ChipTone
  /** The claims behind the cell, for the evidence drawer. */
  refs: string[]
  title: string
}

export interface CoverageMatrix {
  title: string
  columns: Array<{ scope: string; label: string }>
  rows: Array<{ topic: string; cells: Record<string, MatrixCell | undefined> }>
}

const agentsOf = (refs: string[]): string[] => [...new Set(refs.map((r) => r.split(' ')[0]))]

/** Rows: requirement topics (the item's text when it has none), in checklist order. Columns: the scopes in plan order,
 *  then "global". Null when the run has no checklist. */
export function coverageMatrix(view: RunView): CoverageMatrix | null {
  const checklist = view.checklist
  if (!checklist?.length) return null
  const stepOf = new Map(view.steps.map((s) => [s.id, s]))
  const scopes = [...new Set(checklist.map((c) => c.scope))].sort((a, b) =>
    (a === 'global' ? 1 : 0) - (b === 'global' ? 1 : 0) || view.steps.findIndex((s) => s.id === a) - view.steps.findIndex((s) => s.id === b))
  const columns = scopes.map((scope) => ({ scope, label: scope === 'global' ? 'Whole task' : stepOf.get(scope)?.role ?? scope }))
  const rows: CoverageMatrix['rows'] = []
  for (const item of checklist) {
    const topic = item.topic ?? item.text
    let row = rows.find((r) => r.topic === topic)
    if (!row) rows.push(row = { topic, cells: {} })
    const entry = view.ledger?.[item.id] ?? { status: 'pending' as const, claimIds: [] }
    const conflict = entry.status === 'conflicted' ? entry.conflict : undefined
    const refs = conflict?.claimIds ?? entry.claimIds
    const label = entry.status === 'verified' ? `✓ ${agentsOf(refs).join(' ')}`
      : entry.status === 'unverified' ? `? ${agentsOf(refs).join(' ')}`
      : entry.status === 'conflicted' ? `⚡ ${agentsOf(refs).join(' vs ')}`
      : `· ${entry.status}`
    const tone: ChipTone = entry.status === 'verified' ? 'ok' : entry.status === 'unverified' ? 'warn' : entry.status === 'conflicted' ? 'bad' : 'neutral'
    const state = conflict ? (conflict.confirmed ? 'conflict' : 'possible conflict') : entry.status
    row.cells[item.scope] = { itemId: item.id, status: entry.status, label, tone, refs, title: `${item.text}: ${state}` }
  }
  return { title: `Acceptance checklist: ${checklist.length} requirement${checklist.length === 1 ? '' : 's'}`, columns, rows }
}

export function ledgerChips(counts: Record<LedgerStatus, number>): Array<{ tone: ChipTone; text: string }> {
  return [
    { tone: 'ok', text: `${counts.verified} verified` }, { tone: 'warn', text: `${counts.unverified} unverified` },
    { tone: 'bad', text: `${counts.conflicted} conflicted` }, { tone: 'neutral', text: `${counts.missing} missing` },
    ...(counts.pending ? [{ tone: 'neutral' as const, text: `${counts.pending} pending` }] : []),
  ]
}

export type RuleTone = 'ok' | 'warn' | 'bad' | 'mono'

/** The stop-rule table of the assess card (design 12 wording). */
export function stopRules(rules: AssessRules): Array<{ label: string; value: string; tone: RuleTone }> {
  return [
    { label: 'Checklist complete', ...(rules.checklist.open ? { value: `no · ${rules.checklist.open} open`, tone: 'bad' as const } : { value: 'yes', tone: 'ok' as const }) },
    { label: 'Wave cap', value: `${rules.waves.used} of ${rules.waves.max} used`, tone: 'mono' },
    { label: 'Budget', value: `${rules.budget.spentUsd.toFixed(2)} of ${rules.budget.capUsd.toFixed(2)} USD`, tone: 'mono' },
    { label: 'Progress since last wave', value: rules.progress === 'first' ? 'n/a (first)' : rules.progress, tone: rules.progress === 'none' ? 'bad' : 'ok' },
    { label: 'A tool can close the gap', value: rules.tools, tone: rules.tools === 'all' ? 'ok' : rules.tools === 'partly' ? 'warn' : rules.tools === 'none' ? 'bad' : 'mono' },
  ]
}

/** What a follow-up step closes, from the requirements it covers: conflicts first, then missing, then unverified. */
export function stepBadge(view: RunView, step: Pick<AgentStep, 'covers'>): string {
  const statuses = (step.covers ?? []).map((id) => view.ledger?.[id]?.status)
  const n = (status: LedgerStatus): number => statuses.filter((s) => s === status).length
  if (n('conflicted')) return `resolves ${n('conflicted')} conflict${n('conflicted') === 1 ? '' : 's'}`
  if (n('missing')) return `fills ${n('missing')} missing`
  if (n('unverified')) return `checks ${n('unverified')} unverified`
  return ''
}

/** plan → workers → assess: … → wave n → … → synthesize, as far as the run got. */
export function timelineStrip(view: RunView): Array<{ text: string; tone: ChipTone }> {
  const out: Array<{ text: string; tone: ChipTone }> = [{ text: 'plan', tone: 'neutral' }, { text: 'workers', tone: 'neutral' }]
  view.assess.forEach((a, i) => {
    out.push({ text: `assess: ${a.decision}`, tone: 'bad' })
    if (a.decision === 'follow_up' && (view.wave > a.wave || i < view.assess.length - 1)) out.push({ text: `wave ${a.wave + 1}`, tone: 'neutral' })
  })
  if (view.phase === 'synthesizing' || view.phase === 'complete') out.push({ text: 'synthesize', tone: 'neutral' })
  return out
}
