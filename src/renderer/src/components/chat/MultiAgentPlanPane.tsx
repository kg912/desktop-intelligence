import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Circle, Loader2, RotateCcw,
  ShieldAlert, Sparkles, Square, X,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentStatus, AgentView, RunView } from '../../lib/multiAgentRunState'
import { elapsedMs, formatElapsed, isRunActive } from '../../lib/multiAgentRunState'
import type { CostEstimate } from '../../../../shared/multiAgentModels'
import { formatUsd } from '../../../../shared/multiAgentModels'

export const PLAN_PANE_WIDTH = 280
export const PLAN_RAIL_WIDTH = 40

const STATUS_LABEL: Record<AgentStatus, string> = {
  queued: 'queued', running: 'running', paused: 'paused', reflecting: 'reflecting', retrying: 'retrying',
  done: 'passed', failed: 'failed', cancelled: 'stopped',
}

const DOT_CLASS: Record<AgentStatus, string> = {
  queued: 'bg-content-muted/50',
  running: 'bg-accent-500 animate-pulse',
  paused: 'bg-amber-400 animate-pulse',
  reflecting: 'bg-sky-400 animate-pulse',
  retrying: 'bg-amber-500 animate-pulse',
  done: 'bg-emerald-400',
  failed: 'bg-red-500',
  cancelled: 'bg-content-muted',
}

export function StatusIcon({ status, className }: { status: AgentStatus; className?: string }) {
  const c = cn('w-3.5 h-3.5 flex-shrink-0', className)
  switch (status) {
    case 'done': return <Check className={cn(c, 'text-emerald-400')} />
    case 'failed': return <X className={cn(c, 'text-red-400')} />
    case 'cancelled': return <Square className={cn(c, 'text-content-muted')} />
    case 'paused': return <ShieldAlert className={cn(c, 'text-amber-300')} />
    case 'retrying': return <RotateCcw className={cn(c, 'text-amber-400 animate-spin [animation-duration:2s]')} />
    case 'running':
    case 'reflecting': return <Loader2 className={cn(c, 'text-accent-400 animate-spin')} />
    default: return <Circle className={cn(c, 'text-content-muted')} />
  }
}

interface Props {
  view: RunView
  task: string
  collapsed: boolean
  onToggleCollapsed: () => void
  estimate: CostEstimate | null
  budgetCapUsd: number
  readOnly: boolean
  onApprove: () => void
  onCancel: () => void
  onAbort: () => void
  onSelectAgent: (agentId: string) => void
}

export function MultiAgentPlanPane(props: Props) {
  const { collapsed } = props
  return (
    <aside
      data-testid="plan-pane"
      data-collapsed={collapsed}
      className="flex-shrink-0 h-full overflow-hidden border-r border-surface-border bg-surface-DEFAULT"
      style={{ width: collapsed ? PLAN_RAIL_WIDTH : PLAN_PANE_WIDTH, transition: 'width 220ms cubic-bezier(0.4, 0, 0.2, 1)' }}
    >
      {collapsed ? <PlanRail {...props} /> : <PlanTree {...props} />}
    </aside>
  )
}

function PlanRail({ view, onToggleCollapsed, onSelectAgent }: Props) {
  return (
    <div className="flex flex-col items-center h-full py-3 gap-2" style={{ width: PLAN_RAIL_WIDTH }}>
      <button
        onClick={onToggleCollapsed}
        title="Show orchestrator plan"
        className="p-1 rounded text-content-muted hover:text-content-primary hover:bg-surface-hover"
      >
        <ChevronsRight className="w-3.5 h-3.5" />
      </button>
      <div className="mt-2 flex flex-col items-center gap-2">
        {view.steps.map((step) => {
          const agent = view.agents[step.id]
          return (
            <button
              key={step.id}
              title={`${step.id} · ${step.label} — ${agent ? STATUS_LABEL[agent.status] : 'queued'}`}
              onClick={() => onSelectAgent(step.id)}
              className={cn('w-2.5 h-2.5 rounded-full', DOT_CLASS[agent?.status ?? 'queued'])}
            />
          )
        })}
        {view.steps.length > 0 && (
          <span
            title="Synthesis"
            className={cn(
              'w-2.5 h-2.5 rounded-sm',
              view.phase === 'complete' ? 'bg-emerald-400' : view.phase === 'synthesizing' ? 'bg-accent-500 animate-pulse' : 'bg-content-muted/40'
            )}
          />
        )}
      </div>
    </div>
  )
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function PlanTree(props: Props) {
  const { view, task, estimate, budgetCapUsd, readOnly, onApprove, onCancel, onAbort, onToggleCollapsed, onSelectAgent } = props
  const active = isRunActive(view)
  const now = useNow(active)
  const phases = useMemo(() => [...new Set(view.steps.map((s) => s.phase))].sort((a, b) => a - b), [view.steps])
  const [closedPhases, setClosedPhases] = useState<Set<number>>(new Set())
  const [openAgents, setOpenAgents] = useState<Set<string>>(new Set())
  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  return (
    <div className="flex flex-col h-full" style={{ width: PLAN_PANE_WIDTH }}>
      <div className="px-4 pt-3 pb-3 border-b border-surface-border flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-content-primary">Orchestrator Plan</p>
          <p className="text-[11px] text-content-muted mt-1 line-clamp-2" title={task}>{task || 'Multi-agent run'}</p>
        </div>
        <div className="flex items-center gap-1">
          {active && !readOnly && view.phase !== 'preflight' && (
            <button
              onClick={onAbort}
              title="Abort run"
              className="rounded border border-red-900/60 px-1.5 py-0.5 text-[10px] text-red-400 hover:bg-red-950/40"
            >
              Abort
            </button>
          )}
          <button
            onClick={onToggleCollapsed}
            title="Collapse plan"
            className="p-1 rounded text-content-muted hover:text-content-primary hover:bg-surface-hover"
          >
            <ChevronsLeft className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
        {/* 1. Planning */}
        <TreeRow
          icon={view.steps.length ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Loader2 className="w-3.5 h-3.5 text-accent-400 animate-spin" />}
          label="Planning"
          detail={view.steps.length ? `${view.steps.length} agent${view.steps.length === 1 ? '' : 's'}` : 'decomposing task…'}
        />

        {phases.map((phase) => {
          const steps = view.steps.filter((s) => s.phase === phase)
          const open = !closedPhases.has(phase)
          return (
            <div key={phase}>
              {phases.length > 1 && (
                <button
                  onClick={() => setClosedPhases((s) => toggle(s, phase))}
                  className="flex items-center gap-1 w-full text-left text-[10px] uppercase tracking-wider text-content-muted hover:text-content-secondary mt-2 mb-1"
                >
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Phase {phase} · {steps.length > 1 ? 'parallel' : 'single'}
                </button>
              )}
              {open && steps.map((step) => {
                const agent = view.agents[step.id]
                if (!agent) return null
                const expanded = openAgents.has(step.id)
                return (
                  <AgentNode
                    key={step.id}
                    agent={agent}
                    now={now}
                    expanded={expanded}
                    onToggle={() => setOpenAgents((s) => toggle(s, step.id))}
                    onSelect={() => onSelectAgent(step.id)}
                  />
                )
              })}
            </div>
          )
        })}

        {view.steps.length > 0 && (
          <TreeRow
            icon={
              view.phase === 'complete' ? <Check className="w-3.5 h-3.5 text-emerald-400" />
                : view.phase === 'synthesizing' ? <Loader2 className="w-3.5 h-3.5 text-accent-400 animate-spin" />
                : view.phase === 'failed' ? <X className="w-3.5 h-3.5 text-red-400" />
                : <Sparkles className="w-3.5 h-3.5 text-content-muted" />
            }
            label="Synthesis"
            detail={view.phase === 'complete' ? 'done' : view.phase === 'synthesizing' ? 'writing…' : 'after agents'}
          />
        )}

        {view.phase === 'failed' && view.failureReason && (
          <div className="mt-2 rounded border border-red-900/60 bg-red-950/20 p-2 text-[11px] text-red-300 flex gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />
            <span>{view.failureReason}</span>
          </div>
        )}
      </div>

      {view.phase === 'preflight' && !readOnly && (
        <div className="m-3 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 space-y-2" data-testid="preflight">
          <div className="flex gap-2 text-amber-200 text-xs">
            <ShieldAlert className="w-4 h-4 flex-shrink-0" />
            Approve this plan before any worker starts.
          </div>
          {estimate ? (
            <div className="text-[11px] text-content-secondary space-y-0.5">
              <p>
                Estimated cost <span className="text-content-primary">{formatUsd(estimate.minUsd)} – {formatUsd(estimate.maxUsd)}</span>
              </p>
              <p className="text-amber-300 font-medium">
                Worst case {formatUsd(Math.min(estimate.maxUsd, budgetCapUsd))}
                {estimate.maxUsd > budgetCapUsd && <span className="font-normal text-content-muted"> (capped by the {formatUsd(budgetCapUsd)} budget)</span>}
              </p>
              {estimate.unpricedModels.length > 0 && (
                <p className="text-content-muted">No published price for {estimate.unpricedModels.join(', ')} — counted as $0.</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-content-muted">Cost estimate unavailable (OpenRouter prices not loaded). Budget cap {formatUsd(budgetCapUsd)} still applies.</p>
          )}
          <div className="flex gap-2 pt-1">
            <button onClick={onApprove} className="px-2.5 py-1 rounded bg-accent-700 hover:bg-accent-600 text-[11px] text-white">
              Approve & run
            </button>
            <button onClick={onCancel} className="px-2.5 py-1 rounded border border-surface-border text-[11px] text-content-secondary hover:bg-surface-hover">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="px-4 py-2.5 border-t border-surface-border text-[10px] text-content-muted flex items-center flex-wrap gap-x-2 gap-y-1">
        <span>Total: {formatUsd(view.totals.costUsd)} · {view.totals.tokens.toLocaleString()} tok</span>
        <span className="text-content-muted/70">cap {formatUsd(budgetCapUsd)}</span>
        {view.totals.budgetReached && (
          <span className="rounded border border-amber-800/60 px-1 text-amber-300">Budget cap reached</span>
        )}
      </div>
    </div>
  )
}

function TreeRow({ icon, label, detail }: { icon: React.ReactNode; label: string; detail?: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-content-secondary">
      {icon}
      <span className="text-content-primary">{label}</span>
      {detail && <span className="ml-auto text-[10px] text-content-muted">{detail}</span>}
    </div>
  )
}

function AgentNode({
  agent, now, expanded, onToggle, onSelect,
}: { agent: AgentView; now: number; expanded: boolean; onToggle: () => void; onSelect: () => void }) {
  const ms = elapsedMs(agent, now)
  return (
    <div
      className={cn(
        'rounded-lg border px-2 py-2',
        agent.status === 'paused' ? 'border-amber-700/70 bg-amber-950/20 animate-pulse' : 'border-surface-border bg-surface-elevated'
      )}
      data-testid={`plan-step-${agent.step.id}`}
      data-status={agent.status}
    >
      <div className="flex gap-2 items-start">
        <button onClick={onToggle} className="mt-0.5 text-content-muted hover:text-content-secondary" title={expanded ? 'Collapse' : 'Expand'}>
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        <StatusIcon status={agent.status} className="mt-0.5" />
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <p className="text-xs text-content-primary truncate">{agent.step.id} · {agent.step.label}</p>
          <p className="text-[10px] text-content-muted mt-0.5 truncate">
            {agent.step.role} · {agent.step.model || 'default model'}
          </p>
        </button>
        {ms !== null && <span className="text-[10px] text-content-muted tabular-nums mt-0.5">{formatElapsed(ms)}</span>}
      </div>
      {expanded && (
        <div className="mt-2 ml-5 space-y-1 text-[10px] text-content-muted">
          <p>Status: {STATUS_LABEL[agent.status]}{agent.attempt > 1 ? ` · attempt ${agent.attempt}` : ''}</p>
          {agent.reflections.map((r, i) => (
            <p key={i} className={r.passed ? 'text-emerald-400' : 'text-amber-300'}>
              Reflection {r.score}/5 · {r.passed ? 'passed' : 'failed'} — {r.reason}
            </p>
          ))}
          {agent.pause && <p className="text-amber-300">Waiting for approval: {agent.pause.serverName}:{agent.pause.toolName}</p>}
          {agent.failure && <p className="text-red-400">{agent.failure}</p>}
          {agent.tokenCount > 0 && <p>{agent.tokenCount.toLocaleString()} tok · {formatUsd(agent.costUsd)}</p>}
        </div>
      )}
    </div>
  )
}
