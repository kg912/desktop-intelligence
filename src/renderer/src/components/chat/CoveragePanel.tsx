// Spec B 7b (design 12): the coverage matrix, the assess card and the run timeline strip. Shown in the List run view
// and the Graph dock's Assess tab; an assess pause (follow-up approval or ask_user) also appears under "Needs you".
import { useContext, useState } from 'react'
import type { AssessAction, MultiAgentConfig } from '../../../../shared/types'
import { coverageMatrix, ledgerChips, stepBadge, stopRules, timelineStrip } from '../../lib/coverageView'
import type { RuleTone } from '../../lib/coverageView'
import type { RunView } from '../../lib/multiAgentRunState'
import { cn } from '../../lib/utils'
import { Chip } from './ClaimsDrawer'
import { ClaimLinksContext } from './ClaimLinks'
import { shortModel } from './MultiAgentSidebarView'

const LABEL = 'font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8a8a8a]'
const PANEL = 'rounded-xl border-[0.5px] border-white/[0.08] bg-[#0a0a0a]'
const RULE_TONE: Record<RuleTone, string> = { ok: 'text-[#4ade80]', warn: 'text-[#fbbf24]', bad: 'text-[#ff6b66]', mono: 'font-mono text-[#e8e8e8]' }

export function CoverageMatrixView({ view }: { view: RunView }) {
  const links = useContext(ClaimLinksContext)
  const matrix = coverageMatrix(view)
  if (!matrix) return null
  return (
    <section className={cn(PANEL, 'px-[22px] py-5')} data-testid="coverage-matrix">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className={LABEL}>Coverage ledger · {view.assess.length || view.assessStartedAt !== undefined ? `after wave ${view.wave}` : 'live'}</div>
          <div className="mt-1 text-[18px] font-semibold">{matrix.title}</div>
        </div>
        {view.ledgerCounts && (
          <div className="flex flex-wrap gap-1.5" data-testid="ledger-chips">
            {ledgerChips(view.ledgerCounts).map((c) => <Chip key={c.text} tone={c.tone}>{c.text}</Chip>)}
          </div>
        )}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className={cn(LABEL, 'border-b-[0.5px] border-white/[0.06] px-2.5 py-[9px] text-left')}>Requirement</th>
              {matrix.columns.map((c) => (
                <th key={c.scope} className={cn(LABEL, 'max-w-[180px] border-b-[0.5px] border-white/[0.06] px-2.5 py-[9px] text-center')}>
                  <span className="block truncate" title={c.label}>{c.label}</span>{c.scope !== 'global' && <span className="block">{c.scope}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.topic}>
                <td className="border-b-[0.5px] border-white/[0.06] px-2.5 py-[9px]">{row.topic}</td>
                {matrix.columns.map((c) => {
                  const cell = row.cells[c.scope]
                  return (
                    <td key={c.scope} className="border-b-[0.5px] border-white/[0.06] px-2.5 py-[9px] text-center">
                      {cell && (
                        <button data-testid={`cell-${cell.itemId}`} title={cell.title} disabled={!cell.refs.length || !links}
                          onClick={() => links?.open({ agentId: cell.refs[0].split(' ')[0], ref: cell.refs[0], refs: cell.refs })}>
                          <Chip tone={cell.tone}>{cell.label}</Chip>
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3.5 flex flex-wrap gap-3.5 text-[11px] text-[#8a8a8a]">
        <span>✓ verified claim</span><span>? unverified or declared</span><span>⚡ conflicting verified claims</span><span>· no claim yet</span>
      </div>
      <p className="mt-[18px] text-[12px] leading-relaxed text-[#8a8a8a]">
        Click a cell to open the claims in the evidence drawer. The ledger is computed from claim statuses, with no model call.
      </p>
    </section>
  )
}

export function AssessCard({ view, config, readOnly, onAssess }: {
  view: RunView
  config: MultiAgentConfig
  readOnly: boolean
  onAssess?: (action: AssessAction) => void
}) {
  const latest = view.assess.at(-1)
  const autoUsd = config.followUpAutoUsd ?? 0.15
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState<Record<string, { label: string; task: string }>>({})
  const [answer, setAnswer] = useState('')
  if (!latest) return null
  const pause = !readOnly && view.assessPause && onAssess ? view.assessPause : undefined
  const asking = pause?.toolName === 'ask_user'
  const approving = pause?.toolName === 'approve_followup'
  const text = new Map((view.checklist ?? []).map((c) => [c.id, c.text]))
  const steps = latest.steps
  const run = (): void => {
    const changed = editing ? steps.map((s) => ({ id: s.id, label: edits[s.id]?.label ?? s.label, task: edits[s.id]?.task ?? s.task ?? '' })) : undefined
    onAssess?.({ kind: 'run', steps: changed })
    setEditing(false)
  }
  return (
    <div className="flex flex-col gap-4" data-testid="assess-card">
      <section className={cn(PANEL, 'p-[18px]', (asking || approving || latest.decision !== 'done') && 'border-[#e53935]/40')}>
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL}>Assess · decision</span>
          <Chip testId="assess-call">{latest.model ? `${shortModel(latest.model)} · ${latest.costUsd.toFixed(3)} USD · ${(latest.durationMs / 1000).toFixed(1)} s` : 'no model call'}</Chip>
        </div>
        <div className="mb-1 mt-2 text-[20px] font-semibold" data-testid="assess-decision">
          {latest.decision}{latest.forced ? ` (${latest.forced.replace(/_/g, ' ')})` : ''}
          {steps.length > 0 && <span className="text-[13px] font-normal text-[#8a8a8a]"> · {steps.length} step{steps.length === 1 ? '' : 's'}</span>}
        </div>
        {latest.reason && <p className="text-[12.5px] leading-[1.55] text-[#8a8a8a]">{latest.reason}</p>}
        {asking && (
          <div className="mt-3.5">
            <p className="text-[13.5px]" data-testid="assess-question">{latest.question ?? String(pause?.args.question ?? '')}</p>
            <textarea aria-label="Your answer" value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2}
              className="mt-2 w-full rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-2 text-[13px] text-[#e8e8e8] outline-none focus:border-[#e53935]/60" />
            <div className="mt-2 flex gap-2">
              <button onClick={() => onAssess?.({ kind: 'answer', answer: answer.trim() })} disabled={!answer.trim()}
                className="rounded-lg border-[0.5px] border-[#e53935] bg-[#e53935] px-3 py-[7px] text-[12px] font-medium text-white disabled:opacity-50">Answer</button>
              <button onClick={() => onAssess?.({ kind: 'finish' })} className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium">Skip</button>
            </div>
          </div>
        )}
        {steps.length > 0 && (
          <div className="mt-3.5 flex flex-col gap-2">
            {steps.map((s) => {
              const badge = stepBadge(view, s)
              return (
                <div key={s.id} className="rounded-xl border-[0.5px] border-white/[0.08] bg-[#0d0d0d] px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11.5px]">{s.id}{s.condition ? ` · conditional: ${s.condition}` : s.dependsOn?.length ? ` · after ${s.dependsOn.join(', ')}` : ''}</span>
                    {badge && <Chip tone="info">{badge}</Chip>}
                  </div>
                  {editing ? (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                      <input aria-label={`Title of ${s.id}`} value={edits[s.id]?.label ?? s.label}
                        onChange={(e) => setEdits((m) => ({ ...m, [s.id]: { label: e.target.value, task: m[s.id]?.task ?? s.task ?? '' } }))}
                        className="rounded-md border-[0.5px] border-white/[0.16] bg-[#141414] px-2 py-1 text-[12.5px] outline-none" />
                      <textarea aria-label={`Task of ${s.id}`} rows={2} value={edits[s.id]?.task ?? s.task ?? ''}
                        onChange={(e) => setEdits((m) => ({ ...m, [s.id]: { label: m[s.id]?.label ?? s.label, task: e.target.value } }))}
                        className="rounded-md border-[0.5px] border-white/[0.16] bg-[#141414] px-2 py-1 text-[12px] outline-none" />
                    </div>
                  ) : (
                    <div className="mt-[5px] text-[12.5px]">{s.label}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {latest.decision === 'follow_up' && latest.estimatedUsd !== undefined && (
          <p className="mt-2.5 font-mono text-[11px] text-[#8a8a8a]" data-testid="auto-run-note">
            {latest.autoRun
              ? `Auto-runs under ${autoUsd.toFixed(2)} USD: estimated ${latest.estimatedUsd.toFixed(2)} USD.`
              : `Estimated ${latest.estimatedUsd.toFixed(2)} USD: above the ${autoUsd.toFixed(2)} USD auto-run limit, so it waits for you.`}
          </p>
        )}
        {approving && (
          <div className="mt-3.5 flex gap-2">
            <button onClick={run} className="rounded-lg border-[0.5px] border-[#e53935] bg-[#e53935] px-3 py-[7px] text-[12px] font-medium text-white">Run follow-up</button>
            <button onClick={() => setEditing((v) => !v)} aria-pressed={editing} className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium">Edit steps</button>
            <button onClick={() => onAssess?.({ kind: 'finish' })} className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium">Finish now</button>
          </div>
        )}
      </section>
      <section className={cn(PANEL, 'p-[18px]')} data-testid="stop-rules">
        <div className={LABEL}>Stop rules</div>
        <div className="mt-2.5 text-[12.5px] leading-[2]">
          {stopRules(latest.rules).map((r) => (
            <div key={r.label} className="flex items-center justify-between" data-testid="stop-rule"><span>{r.label}</span><span className={RULE_TONE[r.tone]}>{r.value}</span></div>
          ))}
        </div>
        {latest.unclosable.map((u) => (
          <div key={u.checklistId} data-testid="unclosable"
            className="mt-2.5 rounded-lg border-[0.5px] border-[#fbbf24]/35 bg-[#fbbf24]/[0.07] px-3 py-2.5 text-[12px] leading-normal text-[#fbbf24]">
            {text.get(u.checklistId) ?? u.checklistId}: no available tool can close this gap. Reported to you in the answer, no spend.
          </div>
        ))}
      </section>
    </div>
  )
}

export function RunTimeline({ view }: { view: RunView }) {
  const strip = timelineStrip(view)
  return (
    <section className={cn(PANEL, 'px-[18px] py-3.5')}>
      <div className={LABEL}>In the run timeline</div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]" data-testid="run-timeline">
        {strip.map((s, i) => <span key={i} className="contents">{i > 0 && '→'}<Chip tone={s.tone}>{s.text}</Chip></span>)}
      </div>
    </section>
  )
}

/** Matrix beside the assess column (stacked when narrow). Nothing for runs without a checklist. */
export function CoverageSection({ view, config, readOnly, onAssess }: { view: RunView; config: MultiAgentConfig; readOnly: boolean; onAssess?: (action: AssessAction) => void }) {
  if (!view.checklist?.length && !view.assess.length) return null
  return (
    <div className="mt-3 flex flex-col gap-4 @container" data-testid="coverage-section">
      <CoverageMatrixView view={view} />
      {view.assess.length > 0 && (
        <div className="flex flex-col gap-4">
          <AssessCard view={view} config={config} readOnly={readOnly} onAssess={onAssess} />
          <RunTimeline view={view} />
        </div>
      )}
    </div>
  )
}
