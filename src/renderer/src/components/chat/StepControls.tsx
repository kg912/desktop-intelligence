// Spec B 7d (design 14, right): controls for one step. Running: steer it (delivered at its next round). Finished run:
// re-run it on another model (optionally with its dependents, otherwise they are marked stale), lock its output, view
// its claims. Locked: says what that means.
import { useContext, useMemo, useState } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import { formatUsd } from '../../../../shared/multiAgentModels'
import type { RunView } from '../../lib/multiAgentRunState'
import { isRunActive } from '../../lib/multiAgentRunState'
import { cn } from '../../lib/utils'
import { Chip } from './ClaimsDrawer'
import { ClaimLinksContext } from './ClaimLinks'
import { RunActionsContext } from './RunActions'
import { isWorking, shortModel } from './MultiAgentSidebarView'

const LABEL = 'font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8a8a8a]'
const PANEL = 'rounded-xl border-[0.5px] border-white/[0.08] bg-[#0a0a0a] p-[18px]'
const BTN = 'rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium disabled:opacity-50'
const PRIMARY = 'rounded-lg border-[0.5px] border-[#e53935] bg-[#e53935] px-3 py-[7px] text-[12px] font-medium text-white disabled:opacity-50'

export function StepControls({ view, agentId, readOnly }: { view: RunView; agentId: string; readOnly?: boolean }) {
  const actions = useContext(RunActionsContext)
  const links = useContext(ClaimLinksContext)
  const agent = view.agents[agentId]
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rerunOpen, setRerunOpen] = useState(false)
  const [model, setModel] = useState(agent?.step.model ?? '')
  const estimate = useMemo(() => (agent && actions ? actions.estimateFor([{ ...agent.step, model, dependsOn: agent.step.dependsOn }]) : null), [actions, agent, model])
  if (!agent || !actions || readOnly) return null
  const live = isRunActive(view)
  const locked = view.locked.includes(agentId)
  const running = live && isWorking(agent.status)
  const finished = !live && (agent.status === 'done' || agent.status === 'failed')
  const run = (p: Promise<unknown>): void => { setError(null); p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))) }
  const round = agent.timeline.filter((t) => t.kind === 'tool' && t.attempt === agent.attempt - 1).length + 1
  const lastGate = agent.reflections.at(-1)
  return (
    <div className="flex flex-col gap-4" data-testid={`step-controls-${agentId}`}>
      {running && (
        <section className={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <span className={LABEL}>Running · step {agentId}</span>
            <Chip tone="info">round {round} · {agent.timeline.findLast((t) => t.kind === 'tool' && !t.done) ? 'searching' : 'writing'}</Chip>
          </div>
          <div className="mt-1.5 text-[15px]">{agent.step.label}</div>
          <div className={cn(LABEL, 'mt-3')}>Steer this agent</div>
          <input aria-label={`Steer ${agentId}`} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Only use airline schedule pages, ignore aggregators."
            className="mt-2 w-full rounded-lg border-[0.5px] border-white/[0.16] bg-[#0d0d0d] px-3.5 py-2.5 text-[13.5px] outline-none focus:border-[#e53935]/60" />
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[12px] text-[#8a8a8a]">Delivered at the next round, shown in the run log</span>
            <button className={PRIMARY} disabled={!message.trim()} onClick={() => { run(actions.steer(agentId, message.trim())); setMessage('') }}>Send</button>
          </div>
          {(agent.steers ?? []).map((s, i) => (
            <p key={i} className="mt-1.5 text-[12px] text-[#a8a8a8]" data-testid="steer-sent">“{s.message}” · {s.delivered ? `delivered at round ${(s.round ?? 0) + 1}` : 'queued'}</p>
          ))}
        </section>
      )}
      {finished && (
        <section className={PANEL}>
          <div className={LABEL}>Finished step · {agentId} {agent.step.role}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip tone={agent.status === 'done' ? (agent.degraded ? 'warn' : 'ok') : 'bad'}>{agent.status === 'done' ? (agent.degraded ? 'caveats' : 'done') : 'failed'}</Chip>
            {lastGate && lastGate.score > 0 && <Chip>score {lastGate.score}/5</Chip>}
            {agent.costUsd > 0 && <Chip>{formatUsd(agent.costUsd)}</Chip>}
            <Chip>{shortModel(agent.step.model)}</Chip>
            {agent.stale && <Chip tone="warn">stale</Chip>}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={BTN} disabled={locked} aria-expanded={rerunOpen} onClick={() => setRerunOpen((v) => !v)}>Re-run on…</button>
            <button className={cn(BTN, 'inline-flex items-center gap-1.5')} onClick={() => run(actions.lock(agentId, !locked))}>
              {locked ? <LockOpen className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{locked ? 'Unlock output' : 'Lock output'}
            </button>
            {links && <button className={BTN} onClick={() => links.open({ agentId })}>View claims</button>}
          </div>
          {rerunOpen && !locked && (
            <div className="mt-3 rounded-lg border-[0.5px] border-white/[0.08] bg-[#0d0d0d] p-3" data-testid="rerun-panel">
              <select aria-label={`Re-run ${agentId} on`} value={model} onChange={(e) => setModel(e.target.value)}
                className="rounded-md border-[0.5px] border-white/[0.14] bg-[#141414] px-2 py-1 font-mono text-[11.5px]">
                {[...new Set([agent.step.model, ...actions.models])].filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="mt-2 text-[12.5px] leading-normal text-[#a8a8a8]" data-testid="rerun-estimate">
                Re-run on <b className="text-[#e8e8e8]">{shortModel(model)}</b>: est. {estimate ? `${formatUsd(estimate.minUsd)} – ${formatUsd(estimate.maxUsd)}` : 'unavailable'}.
                Downstream steps that used this output will be marked stale, not re-run automatically.
              </p>
              <div className="mt-2.5 flex gap-2">
                <button className={PRIMARY} onClick={() => run(actions.rerun(agentId, { model, withDependents: false }))}>Re-run this step</button>
                <button className={BTN} onClick={() => run(actions.rerun(agentId, { model, withDependents: true }))}>Re-run + dependents</button>
              </div>
            </div>
          )}
        </section>
      )}
      {locked && (
        <section className={PANEL} data-testid="locked-note">
          <div className={LABEL}>Locked</div>
          <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-relaxed text-[#cfcfcf]">
            <Lock className="mt-[3px] h-3.5 w-3.5 flex-none text-[#fbbf24]" />{agentId} is locked. Later re-runs and follow-up waves reuse its claims and evidence unchanged.
          </p>
        </section>
      )}
      {error && <p className="text-[12px] text-[#ff8c88]" role="alert">{error}</p>}
    </div>
  )
}
