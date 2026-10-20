// Spec B 7a: the claims and evidence drawer (design 11). Opens from any claim chip, a ledger cell (7b) or "View claims".
// Rectification R4: it sits above the agent focus view (zLayers.ts), Escape closes it first, and an agent with no claims
// says why in one line instead of an empty list.
import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { EvidenceRecord } from '../../../../shared/types'
import { acceptedClaims, claimLabel, claimTone, findQuoteRanges, noClaimsReason } from '../../lib/claimsView'
import type { ChipTone, ClaimRow } from '../../lib/claimsView'
import type { RunView } from '../../lib/multiAgentRunState'
import { cn } from '../../lib/utils'
import { coveredAbove, layerProps } from './zLayers'

/** What to open: one agent's claims, focused on `ref`; `refs` limits the list (a ledger cell's claims). */
export interface ClaimTarget {
  agentId: string
  ref?: string
  refs?: string[]
}

export const CHIP_TONE: Record<ChipTone | 'info', string> = {
  ok: 'text-[#4ade80] border-[#4ade80]/40 bg-[#4ade80]/[0.08]',
  warn: 'text-[#fbbf24] border-[#fbbf24]/40 bg-[#fbbf24]/[0.08]',
  bad: 'text-[#ff6b66] border-[#e53935]/50 bg-[#e53935]/10',
  info: 'text-[#60a5fa] border-[#60a5fa]/40 bg-[#60a5fa]/[0.08]',
  neutral: 'text-[#cfcfcf] border-white/[0.14] bg-[#141414]',
}

export function Chip({ tone = 'neutral', children, testId }: { tone?: ChipTone | 'info'; children: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={cn('inline-flex items-center gap-1 rounded-[5px] border-[0.5px] px-[7px] py-[2px] font-mono text-[11px] font-medium', CHIP_TONE[tone])}>
      {children}
    </span>
  )
}

const LABEL = 'font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8a8a8a]'
type Filter = 'all' | 'unverified' | 'conflicts'
type Evidence = { state: 'loading' } | { state: 'missing' } | { state: 'none' } | { state: 'ok'; record: EvidenceRecord }

/** The text a claim's quote should be found in: its snippet (cross-agent ids carry the agent prefix), else the result. */
function sourceText(row: ClaimRow, record: EvidenceRecord): { label: string; text: string } {
  const ids = (row.snippets ?? []).map((sid) => sid.split('/').pop()!)
  const withQuote = ids.find((sid) => record.snippets[sid] && row.quote && findQuoteRanges(record.snippets[sid], row.quote).length)
  const sid = withQuote ?? ids.find((id) => record.snippets[id])
  return sid ? { label: `[${sid}] `, text: record.snippets[sid] } : { label: '', text: record.result }
}

function Highlighted({ text, quote }: { text: string; quote?: string }) {
  const ranges = quote ? findQuoteRanges(text, quote) : []
  const parts: React.ReactNode[] = []
  let at = 0
  ranges.forEach(([start, end], i) => {
    parts.push(text.slice(at, start), <mark key={i} className="rounded-[3px] bg-[#fbbf24]/[0.28] px-[2px] py-px text-[#fde68a]">{text.slice(start, end)}</mark>)
    at = end
  })
  parts.push(text.slice(at))
  return <>{parts}</>
}

function statusChips(row: ClaimRow, accepted: { attempt: number; attempts: number; score: number }): Array<{ tone: ChipTone | 'info'; text: string }> {
  const chips: Array<{ tone: ChipTone | 'info'; text: string }> = []
  if (row.status.startsWith('verified')) chips.push({ tone: 'ok', text: row.status.includes('repointed') ? 'quote verified · re-pointed' : 'quote verified' })
  else if (row.status === 'unverified_declared') chips.push({ tone: 'warn', text: 'unverified · declared' })
  else if (row.status === 'source') chips.push({ tone: 'info', text: `from ${row.source}` })
  else chips.push({ tone: 'neutral', text: `failed check: ${row.status.replace(/_/g, ' ')}` })
  for (const other of row.conflictWith ?? []) chips.push({ tone: 'bad', text: `${row.conflictConfirmed ? 'contradicted' : 'possibly contradicted'} by ${other}` })
  if (accepted.score) chips.push({ tone: 'neutral', text: `judge ${accepted.score}/5` })
  chips.push({ tone: 'neutral', text: `attempt ${accepted.attempt + 1} of ${accepted.attempts}` })
  return chips
}

export function ClaimsDrawer({ view, target, onSelect, onClose }: {
  view: RunView
  target: ClaimTarget
  onSelect: (target: ClaimTarget) => void
  onClose: () => void
}) {
  const accepted = useMemo(() => acceptedClaims(view, target.agentId), [view, target.agentId])
  const [filter, setFilter] = useState<Filter>('all')
  const [raw, setRaw] = useState(false)
  const [evidence, setEvidence] = useState<Evidence>({ state: 'loading' })
  const all = useMemo(() => (accepted?.claims ?? []).filter((c) => !target.refs || target.refs.includes(c.ref)), [accepted, target.refs])
  const row = all.find((c) => c.ref === target.ref) ?? all[0]
  const conflictRows = useMemo(() => (row?.conflictWith ?? []).map((ref) => acceptedClaims(view, ref.split(' ')[0])?.claims.find((c) => c.ref === ref)), [view, row])
  const step = view.agents[target.agentId]?.step

  // Escape closes this layer only: captured and handled, so the focus view and the dock beneath do not also close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || coveredAbove('claimsDrawer')) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Focus moves into the drawer and back to whatever opened it.
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    root.current?.focus()
    return () => { if (opener?.isConnected && opener !== document.body) opener.focus() }
  }, [])

  useEffect(() => {
    setRaw(false)
    if (!row?.callId) { setEvidence({ state: 'none' }); return }
    let cancelled = false
    setEvidence({ state: 'loading' })
    Promise.resolve(window.api.getMultiAgentEvidence?.(view.runId, row.agentId, row.callId) ?? null)
      .then((record) => { if (!cancelled) setEvidence(record ? { state: 'ok', record } : { state: 'missing' }) })
      .catch(() => { if (!cancelled) setEvidence({ state: 'missing' }) })
    return () => { cancelled = true }
  }, [view.runId, row?.agentId, row?.callId])

  const shown = all.filter((c) => filter === 'all' || (filter === 'unverified' ? c.status === 'unverified_declared' : !!c.conflictWith?.length))
  const source = evidence.state === 'ok' && row ? sourceText(row, evidence.record) : null

  return (
    <aside ref={root} tabIndex={-1} data-testid="claims-drawer" role="dialog" aria-label="Claims and evidence" {...layerProps('claimsDrawer')}
      className="fixed bottom-4 right-4 top-4 flex outline-none w-[560px] max-w-[calc(100vw-32px)] animate-[ma-slide-in_180ms_ease-out] flex-col overflow-hidden rounded-xl border-[0.5px] border-white/[0.08] bg-[#0a0a0a] text-[#e8e8e8] shadow-[0_20px_60px_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between border-b-[0.5px] border-white/[0.08] px-4 py-3.5">
        <div>
          <div className={LABEL}>Evidence · agent {target.agentId}{step ? ` · ${step.role}` : ''}</div>
          <div className="mt-[3px] text-[14px] font-semibold" data-testid="drawer-title">{row ? `Claim ${row.id} · ${claimLabel(row)}` : 'No claims'}</div>
        </div>
        <button onClick={onClose} aria-label="Close" className="text-[#8a8a8a] hover:text-[#e8e8e8]"><X className="h-4 w-4" strokeWidth={1.6} /></button>
      </div>
      {row && accepted && (
        <>
          <div className="border-b-[0.5px] border-white/[0.08] px-4 py-3.5">
            <div className="text-[13.5px] leading-normal" data-testid="drawer-claim-text">"{row.claim}"</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5" data-testid="drawer-status-chips">
              {statusChips(row, accepted).map((c, i) => <Chip key={i} tone={c.tone}>{c.text}</Chip>)}
            </div>
          </div>
          <div className="border-b-[0.5px] border-white/[0.08] px-4 py-3.5">
            <div className="flex items-center justify-between">
              <span className={LABEL}>{evidence.state === 'ok' ? `Source · call ${evidence.record.callId} · ${evidence.record.name}` : 'Source'}</span>
              {evidence.state === 'ok' && (
                <button onClick={() => setRaw((v) => !v)} className={cn('rounded-[5px] border-[0.5px] px-[7px] py-[2px] font-mono text-[11px]', CHIP_TONE.neutral)}>
                  {raw ? 'show snippet' : 'open raw result'}
                </button>
              )}
            </div>
            <div data-testid="drawer-source" className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg border-[0.5px] border-white/[0.06] bg-[#060606] px-3 py-2.5 font-mono text-[11.5px] leading-[1.65] text-[#a8a8a8]">
              {evidence.state === 'loading' && 'Loading…'}
              {evidence.state === 'missing' && 'Evidence not stored for this run.'}
              {evidence.state === 'none' && 'This claim cites no tool result.'}
              {evidence.state === 'ok' && (raw
                ? <span data-testid="drawer-raw">{evidence.record.result}</span>
                : source && <>{source.label}<Highlighted text={source.text} quote={row.quote} /></>)}
            </div>
          </div>
          {conflictRows.length > 0 && (
            <div className="border-b-[0.5px] border-white/[0.08] px-4 py-3.5">
              <div className={cn(LABEL, 'mb-2')}>{row.conflictConfirmed ? 'Conflicting claim' : 'Possibly conflicting claim'}</div>
              {conflictRows.map((c, i) => c && (
                <button key={i} data-testid="drawer-conflict" onClick={() => onSelect({ agentId: c.agentId, ref: c.ref })}
                  className="block w-full rounded-lg border-[0.5px] border-[#e53935]/35 bg-[#e53935]/[0.06] px-3 py-2.5 text-left text-[12.5px] leading-normal">
                  {c.ref}: "{c.claim}"
                  <div className="mt-[5px] font-mono text-[11px] text-[#8a8a8a]">
                    {[c.callId, ...(c.snippets ?? []).map((s) => `[${s}]`), claimLabel({ ...c, conflictWith: undefined })].filter(Boolean).join(' · ')}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {!all.length && <p data-testid="drawer-empty" className="px-4 py-3.5 text-[13px] leading-normal text-[#a8a8a8]">{noClaimsReason(view, target.agentId) ?? 'No claims match.'}</p>}
      {all.length > 0 && <div className="flex items-center gap-2 px-4 py-2.5">
        <span className={LABEL}>All claims</span>
        {([['all', `all ${all.length}`, 'neutral'], ['unverified', 'unverified only', 'warn'], ['conflicts', 'conflicts', 'bad']] as const).map(([key, text, tone]) => (
          <button key={key} data-testid={`drawer-filter-${key}`} aria-pressed={filter === key} onClick={() => setFilter(key)}
            className={cn('rounded-[5px] border-[0.5px] px-[7px] py-[2px] font-mono text-[11px] font-medium', CHIP_TONE[tone], filter === key && 'ring-1 ring-white/20')}>
            {text}
          </button>
        ))}
      </div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.map((c) => (
          <button key={c.ref} data-testid={`drawer-claim-row-${c.ref}`} onClick={() => onSelect({ ...target, ref: c.ref })}
            className={cn('block w-full border-b-[0.5px] border-white/[0.06] px-3.5 py-3 text-left', c.ref === row?.ref && 'bg-[#111] shadow-[inset_2px_0_0_#ff6b66]')}>
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px]">{c.ref}</span>
              <Chip tone={claimTone(c.status, !!c.conflictWith?.length)}>{claimLabel(c)}</Chip>
            </div>
            <div className={cn('mt-[5px] text-[12.5px]', c.ref !== row?.ref && 'text-[#8a8a8a]')}>{c.claim}</div>
          </button>
        ))}
      </div>
    </aside>
  )
}
