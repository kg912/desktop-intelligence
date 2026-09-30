import { Bot, Check, Loader2, Sparkles } from 'lucide-react'
import type { AgentEvent, AgentStep } from '../../../../shared/types'

type Props = { steps: AgentStep[]; events: AgentEvent[] }

/** The main canvas for live worker output; the companion left rail is plan-only. */
export function MultiAgentExecutionArea({ steps, events }: Props) {
  const completions = new Map(events.filter((event): event is Extract<AgentEvent, { type: 'agent_complete' }> => event.type === 'agent_complete').map((event) => [event.agentId, event]))
  const started = new Set(events.filter((event): event is Extract<AgentEvent, { type: 'agent_start' }> => event.type === 'agent_start').map((event) => event.agentId))
  const tokens = new Map<string, string>()
  for (const event of events) if (event.type === 'agent_token') tokens.set(event.agentId, `${tokens.get(event.agentId) ?? ''}${event.token}`)
  const synthesis = events.filter((event): event is Extract<AgentEvent, { type: 'synthesis_token' }> => event.type === 'synthesis_token').map((event) => event.token).join('')

  return <section className="flex-1 min-h-0 overflow-y-auto bg-background px-8 py-7">
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div><p className="text-sm font-semibold text-content-primary">Agent execution</p><p className="mt-1 text-xs text-content-muted">Worker outputs stream here. The plan and approvals remain in the left rail.</p></div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {steps.map((step) => {
          const output = completions.get(step.id)
          const live = tokens.get(step.id)
          const active = started.has(step.id) && !output
          return <article key={step.id} className="min-h-[170px] rounded-xl border border-surface-border bg-surface-elevated p-4 shadow-sm">
            <header className="flex items-start gap-3 border-b border-surface-border/70 pb-3"><div className="rounded-lg bg-accent-950/40 p-2 text-accent-300"><Bot className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="text-sm font-medium text-content-primary">{step.id} · {step.label}</p><p className="mt-0.5 truncate text-[11px] text-content-muted">{step.role} · {step.model || 'default model'}</p></div>{output ? <Check className="h-4 w-4 text-emerald-400" /> : active ? <Loader2 className="h-4 w-4 animate-spin text-accent-400" /> : null}</header>
            <div className="pt-3 whitespace-pre-wrap text-sm leading-6 text-content-secondary">{output?.output ?? live ?? (active ? 'Working…' : 'Waiting for this phase…')}</div>
          </article>
        })}
      </div>
      {synthesis && <article className="rounded-xl border border-accent-900/70 bg-accent-950/20 p-5"><header className="mb-3 flex items-center gap-2 text-accent-300"><Sparkles className="h-4 w-4" /><span className="text-xs font-semibold uppercase tracking-wider">Synthesis</span></header><div className="whitespace-pre-wrap text-[15px] leading-7 text-content-primary">{synthesis}</div></article>}
    </div>
  </section>
}
