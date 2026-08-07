import { Check, Circle, Loader2, ShieldAlert, X } from 'lucide-react'
import type { AgentEvent, AgentStep } from '../../../../shared/types'

export function MultiAgentRunPanel({
  steps, events, awaitingApproval, onApprove, onCancel,
}: {
  steps: AgentStep[]
  events: AgentEvent[]
  awaitingApproval: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const stateFor = (id: string) => {
    const complete = events.find((event) => event.type === 'agent_complete' && event.agentId === id)
    const running = events.find((event) => event.type === 'agent_start' && event.agentId === id)
    const failed = events.find((event) => event.type === 'task_failed' && event.partialOutputs && id in event.partialOutputs)
    return failed ? 'failed' : complete ? 'complete' : running ? 'running' : 'queued'
  }
  const cost = events.filter((event): event is Extract<AgentEvent, { type: 'agent_complete' }> => event.type === 'agent_complete').reduce((sum, event) => sum + event.costUsd, 0)
  const tokens = events.filter((event): event is Extract<AgentEvent, { type: 'agent_complete' }> => event.type === 'agent_complete').reduce((sum, event) => sum + event.tokenCount, 0)
  return <aside className="w-[280px] h-full flex-shrink-0 border-r border-surface-border bg-surface-DEFAULT overflow-y-auto">
    <div className="p-4 border-b border-surface-border"><p className="text-xs font-semibold text-content-primary">Agent plan</p><p className="text-[10px] text-content-muted mt-1">{awaitingApproval ? 'Review before agents start' : 'Live orchestration'}</p></div>
    <div className="p-3 space-y-2">{steps.map((step) => { const state = stateFor(step.id); return <div key={step.id} className="rounded-lg border border-surface-border bg-surface-elevated p-2.5"><div className="flex gap-2 items-start">{state === 'complete' ? <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5" /> : state === 'running' ? <Loader2 className="w-3.5 h-3.5 text-accent-400 animate-spin mt-0.5" /> : state === 'failed' ? <X className="w-3.5 h-3.5 text-red-400 mt-0.5" /> : <Circle className="w-3.5 h-3.5 text-content-muted mt-0.5" />}<div><p className="text-xs text-content-primary">{step.id} · {step.label}</p><p className="text-[10px] text-content-muted mt-0.5">{step.role} · {step.model || 'default model'}</p></div></div></div>})}</div>
    {awaitingApproval && <div className="m-3 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3"><div className="flex gap-2 text-amber-200 text-xs"><ShieldAlert className="w-4 h-4" />Approve this plan before workers begin.</div><div className="flex gap-2 mt-3"><button onClick={onApprove} className="px-2 py-1 rounded bg-accent-700 hover:bg-accent-600 text-[11px] text-white">Approve</button><button onClick={onCancel} className="px-2 py-1 rounded border border-surface-border text-[11px] text-content-secondary">Cancel</button></div></div>}
    <div className="mt-auto p-3 border-t border-surface-border text-[10px] text-content-muted">{tokens.toLocaleString()} tokens · ${cost.toFixed(4)}</div>
  </aside>
}
