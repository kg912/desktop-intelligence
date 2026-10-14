// Spec B 7d (design 14, left): the pre-flight plan editor. Titles and tasks, per-step model and budget, reorder (drag or
// the arrow buttons; a drop that breaks the dependency order is undone), add and remove steps, the conditional marker,
// and a running estimate. Approve sends the edited plan; the sidecar runs the planner's checks on it again.
import { useContext, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Plus, X } from 'lucide-react'
import type { AgentStep, MultiAgentConfig } from '../../../../shared/types'
import { formatUsd } from '../../../../shared/multiAgentModels'
import { addStep, moveStep, phasesOf, removeStep, validatePlanEdit } from '../../lib/planEdit'
import type { RunView } from '../../lib/multiAgentRunState'
import { cn } from '../../lib/utils'
import { Chip } from './ClaimsDrawer'
import { RunActionsContext } from './RunActions'
import { shortModel } from './MultiAgentSidebarView'

const LABEL = 'font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8a8a8a]'
const FIELD = 'rounded-md border-[0.5px] border-white/[0.14] bg-[#141414] px-2 py-1 text-[12.5px] text-[#e8e8e8] outline-none focus:border-[#e53935]/60'

export function PlanEditor({ view, config, onApprove, onCancel }: {
  view: RunView
  config: MultiAgentConfig
  onApprove: (steps: AgentStep[]) => void
  onCancel: () => void
}) {
  const actions = useContext(RunActionsContext)
  const [steps, setSteps] = useState<AgentStep[]>(view.steps)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropError, setDropError] = useState<string | null>(null)
  // One line per step, as designed; a step's task and dependencies open under "Details" (open when it already has a task).
  const [open, setOpen] = useState<Set<string>>(() => new Set(view.steps.filter((s) => s.task).map((s) => s.id)))
  const toggle = (id: string): void => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const estimate = useMemo(() => actions?.estimateFor(steps) ?? null, [actions, steps])
  const errors = validatePlanEdit(steps, config, estimate)
  const models = actions?.models.length ? actions.models : [config.models.worker].filter(Boolean)
  const conditional = steps.filter((s) => s.condition).length
  const set = (id: string, patch: Partial<AgentStep>): void => setSteps((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  // A move that would run a step before what it needs is undone and explained (dependencies re-check on drop).
  const move = (from: number, to: number): void => {
    const next = moveStep(steps, from, to)
    const broken = validatePlanEdit(next, config).find((e) => e.includes('is listed before'))
    if (broken && !validatePlanEdit(steps, config).includes(broken)) { setDropError(broken); return }
    setDropError(null)
    setSteps(next)
  }
  return (
    <section className="flex flex-col rounded-xl border-[0.5px] border-white/[0.08] bg-[#0a0a0a]" data-testid="plan-editor">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b-[0.5px] border-white/[0.08] px-[18px] py-3.5">
        <div>
          <div className={LABEL}>Pre-flight · edit plan</div>
          <div className="mt-1 text-[16px] font-semibold" data-testid="plan-editor-title">{steps.length} step{steps.length === 1 ? '' : 's'} · {phasesOf(steps)} phase{phasesOf(steps) === 1 ? '' : 's'}</div>
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="plan-editor-chips">
          <Chip>{estimate ? `est. ${formatUsd(estimate.minUsd)} – ${formatUsd(estimate.maxUsd)}` : 'est. unavailable'}</Chip>
          {conditional > 0 && <Chip tone="warn">{conditional} conditional</Chip>}
        </div>
      </div>
      <ol>
        {steps.map((s, i) => (
          <li key={s.id || i} data-testid={`edit-step-${s.id}`} draggable onDragStart={() => setDragFrom(i)} onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (dragFrom !== null && dragFrom !== i) move(dragFrom, i); setDragFrom(null) }}
            className={cn('border-b-[0.5px] border-white/[0.06] px-3 py-2.5', s.condition && 'shadow-[inset_2px_0_0_#fbbf24]')}>
            <div className="flex items-center gap-2">
              <GripVertical className="h-4 w-4 flex-none cursor-grab text-[#6a6a6a]" aria-hidden />
              <span className="w-8 flex-none font-mono text-[12px] text-[#8a8a8a]">{s.id}</span>
              <input aria-label={`Title of ${s.id}`} value={s.label} onChange={(e) => set(s.id, { label: e.target.value })} placeholder="What should this step find?"
                className={cn(FIELD, 'min-w-0 flex-1 border-transparent bg-transparent text-[13.5px]')} />
              {s.condition && <Chip tone="warn">{s.condition.replace(/^only /i, 'only ')}</Chip>}
              <select aria-label={`Model of ${s.id}`} value={s.model} onChange={(e) => set(s.id, { model: e.target.value })} className={cn(FIELD, 'max-w-[150px] font-mono text-[11px]')}>
                {[...new Set([s.model, ...models])].filter(Boolean).map((m) => <option key={m} value={m}>worker · {shortModel(m)}</option>)}
              </select>
              <label className="flex items-center gap-1 font-mono text-[11px] text-[#8a8a8a]">$
                <input aria-label={`Budget of ${s.id}`} type="number" min={0} step={0.01} value={s.budgetUsd ?? ''} placeholder="—"
                  onChange={(e) => set(s.id, { budgetUsd: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} className={cn(FIELD, 'w-[64px] font-mono text-[11px]')} />
              </label>
              <button aria-label={`Move ${s.id} up`} disabled={i === 0} onClick={() => move(i, i - 1)} className="text-[#8a8a8a] hover:text-white disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
              <button aria-label={`Move ${s.id} down`} disabled={i === steps.length - 1} onClick={() => move(i, i + 1)} className="text-[#8a8a8a] hover:text-white disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
              <button aria-label={`Remove ${s.id}`} onClick={() => setSteps((list) => removeStep(list, s.id))} className="text-[#8a8a8a] hover:text-[#ff6b66]"><X className="h-3.5 w-3.5" /></button>
              <button aria-label={`Details of ${s.id}`} aria-expanded={open.has(s.id)} onClick={() => toggle(s.id)} className="text-[#8a8a8a] hover:text-white">
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open.has(s.id) && 'rotate-180')} />
              </button>
            </div>
            {(open.has(s.id) || s.condition) && (
              <div className="ml-[56px] mt-1.5 flex flex-col gap-1.5">
                {open.has(s.id) && (
                  <>
                    <textarea aria-label={`Task of ${s.id}`} rows={1} value={s.task ?? ''} onChange={(e) => set(s.id, { task: e.target.value || undefined })}
                      placeholder="Task details (optional)" className={cn(FIELD, 'text-[12px]')} />
                    <input aria-label={`Dependencies of ${s.id}`} value={(s.dependsOn ?? []).join(', ')} placeholder="after (step ids, comma separated)"
                      onChange={(e) => set(s.id, { dependsOn: e.target.value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) })} className={cn(FIELD, 'font-mono text-[11px]')} />
                  </>
                )}
                {s.condition && <p className="text-[12px] text-[#8a8a8a]">Depends on {(s.dependsOn ?? []).join(', ') || 'nothing'}. Skipped automatically when the condition fails.</p>}
              </div>
            )}
          </li>
        ))}
        {view.removedSteps.map((r) => (
          <li key={r.stepId} className="flex items-center gap-2 border-b-[0.5px] border-white/[0.06] px-3 py-2.5 opacity-50" data-testid={`removed-step-${r.stepId}`}>
            <span className="ml-6 w-8 font-mono text-[12px] text-[#8a8a8a]">{r.stepId}</span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] line-through">{r.label}</span>
            <Chip>removed · the synthesizer merges</Chip>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3 px-[18px] py-3">
        <button onClick={() => setSteps((list) => addStep(list, config.models.worker || models[0] || ''))}
          className="inline-flex items-center gap-1.5 rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium"><Plus className="h-3.5 w-3.5" />Add step</button>
        <span className="text-[12px] text-[#8a8a8a]">Drag to reorder. Dependencies re-check on drop.</span>
      </div>
      {(dropError || errors.length > 0) && (
        <ul className="mx-[18px] mb-2 list-disc rounded-lg border-[0.5px] border-[#e53935]/35 bg-[#e53935]/[0.06] py-2 pl-7 pr-3 text-[12px] text-[#ff8c88]" data-testid="plan-editor-errors" role="alert">
          {dropError && <li>{dropError} The move was undone.</li>}
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-white/[0.08] px-[18px] py-3">
        <span className="text-[12px] text-[#8a8a8a]">Budget cap {config.budgetCapUsd.toFixed(2)} USD · auto-runs follow-ups under {(config.followUpAutoUsd ?? 0.15).toFixed(2)} USD</span>
        <div className="flex gap-2">
          <button onClick={onCancel} className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium">Cancel</button>
          <button onClick={() => onApprove(steps)} disabled={errors.length > 0}
            className="rounded-lg border-[0.5px] border-[#e53935] bg-[#e53935] px-3 py-[7px] text-[12px] font-medium text-white disabled:opacity-50">Approve and run</button>
        </div>
      </div>
    </section>
  )
}
