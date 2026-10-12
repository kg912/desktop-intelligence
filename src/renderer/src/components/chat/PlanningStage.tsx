// Orchestrator planning state (UI Goal 5, designs/05-planning-state.png): a stepper with timer and
// live token count for the run's left column, and a centre stage where the plan's graph fills in as
// the orchestrator writes it, with its thinking, a slow-plan escape hatch, and any failure inline.

import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import type { PlanningView, RunView } from '../../lib/multiAgentRunState'
import { PLAN_STAGES } from '../../lib/multiAgentRunState'
import { planningNodes } from '../../lib/agentGraphNodes'
import { AgentGraphCanvas, usePageVisible } from './AgentGraphCanvas'
import type { PlanStage } from '../../../../shared/types'

/** The escape hatch appears once planning has taken this long. */
export const SLOW_PLAN_MS = 45_000

const STAGE_LABEL: Record<PlanStage, string> = {
  reading: 'Reading your request', splitting: 'Splitting into subtasks', assigning: 'Assigning roles and tools', wiring: 'Wiring dependencies',
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const approxTokens = (chars: number): string => {
  const t = Math.round(chars / 4)
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t)
}
const found = (p: PlanningView): number => p.draft.filter(Boolean).length

/** Left column: the four planning stages, elapsed time and the live token estimate. */
export function PlanningStepper({ planning, now, failed }: { planning: PlanningView; now: number; failed: boolean }) {
  const current = PLAN_STAGES.indexOf(planning.stage)
  return (
    <div className="px-4 py-3" data-testid="planning-stepper">
      <div className="mb-3 flex items-baseline justify-between font-mono">
        <span className="text-[11px] text-ma-mute">PLANNING</span>
        <span className="text-[11px] text-ma-mute" data-testid="planning-tokens">~{approxTokens(planning.streamedChars)} tok</span>
        <span className="text-[12px] text-ma-redtext" data-testid="planning-clock">{clock(now - planning.startedAt)}</span>
      </div>
      <ol className="flex flex-col gap-3.5">
        {PLAN_STAGES.map((stage, i) => {
          const state = failed && i === current ? 'fail' : i < current ? 'done' : i === current ? 'active' : 'waiting'
          const next = PLAN_STAGES[i + 1]
          const took = state === 'done' && planning.stageAt[stage] !== undefined && next && planning.stageAt[next] !== undefined
            ? `done · ${Math.max(1, Math.round((planning.stageAt[next]! - planning.stageAt[stage]!) / 1000))}s` : 'done'
          const sub = state === 'done' ? took
            : state === 'fail' ? 'stopped'
            : state === 'waiting' ? 'waiting'
            : stage === 'splitting' ? `${found(planning)} found so far` : 'in progress'
          return (
            <li key={stage} className="flex items-start gap-3" data-testid={`plan-stage-${stage}`} data-state={state}>
              <span className={cn('mt-[5px] h-[9px] w-[9px] flex-none rounded-full',
                state === 'done' ? 'bg-[#4ade80]' : state === 'active' ? 'ma-plan-active bg-ma-red' : state === 'fail' ? 'border-[1.5px] border-ma-red' : 'bg-[#3a3a3a]')} />
              <div>
                <div className={cn('text-[13px]', state === 'active' ? 'text-white' : state === 'waiting' ? 'text-ma-dim' : 'text-[#bdbdbd]')}>{STAGE_LABEL[stage]}</div>
                <div className="mt-0.5 font-mono text-[11px] text-ma-dim">{sub}</div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** Centre: the plan's graph as it is written, the orchestrator's thinking, slow-plan options, failures. */
export function PlanningStage({ view, orchestratorModel, live, now, onQuickPlan, onAbort }: {
  view: RunView
  orchestratorModel: string
  live: boolean
  now: number
  onQuickPlan?: () => Promise<void> | void
  onAbort: () => void
}) {
  const p = view.planning
  const visible = usePageVisible()
  const failed = view.phase === 'failed'
  const nodes = useMemo(() => planningNodes(p, orchestratorModel), [p, orchestratorModel])
  const [keptWaitingAt, setKeptWaitingAt] = useState<number | null>(null)
  const [switching, setSwitching] = useState(false)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const elapsed = now - p.startedAt
  const slow = live && !failed && elapsed >= SLOW_PLAN_MS && (keptWaitingAt === null || now - keptWaitingAt >= SLOW_PLAN_MS)
  const n = found(p)
  const caption = p.stage === 'reading' ? 'Reading your request…'
    : `${n} subtask${n === 1 ? '' : 's'} defined${p.stage === 'splitting' ? ' · roles and wiring still being assigned' : ''}`

  return (
    <div className="flex flex-col gap-[18px]" data-testid="planning-stage" data-page-visible={visible}>
      <div className="flex items-center gap-2.5">
        <span className={cn('h-2 w-2 rounded-full bg-ma-red', live && !failed && 'ma-plan-active')} />
        <span className="text-[15px] font-medium">{failed ? 'The orchestrator could not plan this run' : 'Orchestrator is drafting the plan'}</span>
        <span className="flex-1" />
        {!failed && <span className="font-mono text-[11px] text-ma-dim">usually 20–40s</span>}
      </div>

      <div className="h-[300px] overflow-hidden rounded-[14px] border-[0.5px] border-white/[0.06]">
        <AgentGraphCanvas nodes={nodes} animate={live && !failed && visible} caption={caption} />
      </div>

      {failed && (
        <div className="rounded-xl border-[0.5px] border-ma-red/35 bg-ma-red/[0.08] p-3 text-[12.5px] text-ma-redtext" role="alert" data-testid="planning-failed">
          Planning failed: {view.failureReason ?? 'unknown error'}. Nothing ran and no agents were started. Send the task again to retry.
        </div>
      )}

      {p.reasoning && (
        <div className="rounded-xl border-[0.5px] border-white/[0.07] bg-white/[0.02] px-4 py-3.5" data-testid="planning-thinking">
          <button onClick={() => setThinkingOpen((o) => !o)} aria-expanded={thinkingOpen} className="flex w-full justify-between font-mono text-[11px]">
            <span className="text-ma-mute">ORCHESTRATOR THINKING</span>
            <span className="text-ma-dim">{live && !failed ? 'streaming · ' : ''}{thinkingOpen ? 'collapse' : 'expand'}</span>
          </button>
          {thinkingOpen && (
            <p className="mt-2.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.75] text-[#9a9a9a]">
              {p.reasoning.slice(-2000)}{live && !failed && <span className="ma-cursor" />}
            </p>
          )}
        </div>
      )}

      {slow && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border-[0.5px] border-dashed border-[#e6b422]/50 bg-[#e6b422]/[0.05] px-4 py-3" data-testid="slow-plan">
          <span className="font-mono text-[11px] text-[#e6b422]">after {Math.floor(SLOW_PLAN_MS / 1000)}s</span>
          <span className="min-w-[220px] flex-1 text-[13px] text-[#d8d8d8]">Planning is slower than usual on this model.</span>
          <div className="ml-auto flex flex-wrap gap-2">
          <button disabled={switching} onClick={() => setKeptWaitingAt(now)}
            className="h-7 rounded-[7px] border-[0.5px] border-white/[0.14] px-2.5 text-[12px] text-[#d8d8d8] hover:bg-white/5 disabled:opacity-50">Keep waiting</button>
          {onQuickPlan && (
            <button disabled={switching} onClick={() => { setSwitching(true); void onQuickPlan() }}
              className="h-7 rounded-[7px] border-[0.5px] border-[#e6b422]/50 px-2.5 text-[12px] text-[#e6b422] hover:bg-[#e6b422]/10 disabled:opacity-50">
              {switching ? 'Switching to the quick plan…' : 'Use quick 3-step plan'}
            </button>
          )}
          <button onClick={onAbort} className="h-7 rounded-[7px] border-[0.5px] border-white/[0.09] px-2.5 text-[12px] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">Abort</button>
          </div>
        </div>
      )}
    </div>
  )
}
