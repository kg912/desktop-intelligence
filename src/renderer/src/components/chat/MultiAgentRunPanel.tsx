import { Check, Circle, Loader2, ShieldAlert, X } from 'lucide-react'
import type { AgentEvent, AgentStep } from '../../../../shared/types'

type Props = { steps: AgentStep[]; events: AgentEvent[]; budgetCapUsd: number; awaitingApproval: boolean; onApprove: () => void; onCancel: () => void; onAbort: () => void }

export function MultiAgentRunPanel({ steps, events, budgetCapUsd, awaitingApproval, onApprove, onCancel, onAbort }: Props) {
  const completions = events.filter((event): event is Extract<AgentEvent, { type: 'agent_complete' }> => event.type === 'agent_complete')
  const outputs = new Map(completions.map((event) => [event.agentId, event]))
  const reflections = new Map(events.filter((event): event is Extract<AgentEvent, { type: 'reflection_result' }> => event.type === 'reflection_result').map((event) => [event.agentId, event]))
  const pauses = events.filter((event): event is Extract<AgentEvent, { type: 'hitl_pause' }> => event.type === 'hitl_pause' && event.serverName !== 'multi-agent')
  const completedRun = [...events].reverse().find((event): event is Extract<AgentEvent, { type: 'task_complete' }> => event.type === 'task_complete')
  const cost = completedRun?.totalCostUsd ?? completions.reduce((sum, event) => sum + event.costUsd, 0)
  const tokens = completedRun?.totalTokens ?? completions.reduce((sum, event) => sum + event.tokenCount, 0)
  const stateFor = (id: string) => {
    if (reflections.get(id) && !reflections.get(id)?.passed) return 'retrying'
    if (outputs.has(id)) return 'complete'
    if (pauses.some((event) => event.agentId === id)) return 'paused'
    if (events.some((event) => event.type === 'agent_start' && event.agentId === id)) return 'running'
    return 'queued'
  }
  return <aside className="w-[280px] h-full flex-shrink-0 border-r border-surface-border bg-surface-DEFAULT overflow-y-auto animate-in slide-in-from-left-2 duration-200">
    <div className="p-4 border-b border-surface-border flex items-start justify-between gap-2"><div><p className="text-xs font-semibold text-content-primary">Agent plan</p><p className="text-[10px] text-content-muted mt-1">{awaitingApproval ? 'Review before agents start' : 'Live orchestration'}</p></div>{!awaitingApproval && <button onClick={onAbort} title="Abort run" className="rounded border border-red-900/60 p-1 text-red-400 hover:bg-red-950/40"><X className="w-3 h-3" /></button>}</div>
    <div className="p-3 space-y-2">{steps.map((step) => { const state = stateFor(step.id); const reflection = reflections.get(step.id); return <div key={step.id} className={`rounded-lg border p-2.5 ${state === 'paused' ? 'border-amber-700/70 bg-amber-950/20 animate-pulse' : 'border-surface-border bg-surface-elevated'}`}><div className="flex gap-2 items-start">{state === 'complete' ? <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5" /> : state === 'running' || state === 'retrying' ? <Loader2 className="w-3.5 h-3.5 text-accent-400 animate-spin mt-0.5" /> : state === 'paused' ? <ShieldAlert className="w-3.5 h-3.5 text-amber-300 mt-0.5" /> : <Circle className="w-3.5 h-3.5 text-content-muted mt-0.5" />}<div className="min-w-0"><p className="text-xs text-content-primary">{step.id} · {step.label}</p><p className="text-[10px] text-content-muted mt-0.5 truncate">{step.role} · {step.model || 'default model'}</p>{reflection && <p className={`text-[10px] mt-1 ${reflection.passed ? 'text-emerald-400' : 'text-amber-300'}`}>Reflection {reflection.score}/5 · {reflection.passed ? 'passed' : 'retrying'}</p>}</div></div></div>})}</div>
    {awaitingApproval && <div className="m-3 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3"><div className="flex gap-2 text-amber-200 text-xs"><ShieldAlert className="w-4 h-4" />Approve this plan before workers begin.</div><div className="flex gap-2 mt-3"><button onClick={onApprove} className="px-2 py-1 rounded bg-accent-700 hover:bg-accent-600 text-[11px] text-white">Approve</button><button onClick={onCancel} className="px-2 py-1 rounded border border-surface-border text-[11px] text-content-secondary">Cancel</button></div></div>}
    {pauses.length > 0 && <div className="m-3 space-y-2">{pauses.map((pause) => <div key={`${pause.seq}-${pause.agentId}`} className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-[10px] text-amber-200"><b>{pause.role}</b> is waiting for {pause.serverName}:{pause.toolName}</div>)}</div>}
    <div className="mt-auto p-3 border-t border-surface-border text-[10px] text-content-muted">{tokens.toLocaleString()} tokens · ${cost.toFixed(4)}{cost >= budgetCapUsd && <span className="ml-2 rounded border border-amber-800/60 px-1 text-amber-300">Budget cap reached</span>}</div>
  </aside>
}
