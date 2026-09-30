import { memo, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Bot, ChevronDown, ChevronUp, GitBranch, Loader2, Sparkles, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import { McpPermissionDialog } from './McpPermissionDialog'
import { StatusIcon } from './MultiAgentPlanPane'
import type { AgentStatus, AgentView, RunView } from '../../lib/multiAgentRunState'
import { isRunActive, linkProvenance } from '../../lib/multiAgentRunState'
import { formatUsd } from '../../../../shared/multiAgentModels'
import type { McpToolPermissionRequest, McpToolPermissionResponse } from '../../../../shared/types'

const BADGE: Record<AgentStatus, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'text-content-muted border-surface-border' },
  running: { label: 'Live', className: 'text-accent-300 border-accent-800/70' },
  paused: { label: 'Waiting', className: 'text-amber-300 border-amber-800/70' },
  reflecting: { label: 'Reflecting', className: 'text-sky-300 border-sky-900/70' },
  retrying: { label: 'Retrying', className: 'text-amber-300 border-amber-800/70' },
  done: { label: 'Pass', className: 'text-emerald-300 border-emerald-900/70' },
  failed: { label: 'Failed', className: 'text-red-300 border-red-900/70' },
  cancelled: { label: 'Stopped', className: 'text-content-muted border-surface-border' },
}

interface Props {
  view: RunView
  readOnly: boolean
  /** MCP approval requests raised by this run's agents — rendered in their cards. */
  permissionRequests: McpToolPermissionRequest[]
  onRespondPermission: (response: McpToolPermissionResponse) => void
  focusAgentId: string | null
  onSelectAgent: (agentId: string) => void
  onBack: () => void
}

export function MultiAgentExecutionArea({
  view, readOnly, permissionRequests, onRespondPermission, focusAgentId, onSelectAgent, onBack,
}: Props) {
  const active = isRunActive(view)
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    if (!focusAgentId) return
    document.getElementById(`agent-card-${focusAgentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setFlash(focusAgentId)
    const id = setTimeout(() => setFlash(null), 1200)
    return () => clearTimeout(id)
  }, [focusAgentId])

  const agentIds = useMemo(() => new Set(view.steps.map((s) => s.id)), [view.steps])
  const requestsByAgent = useMemo(() => {
    const map = new Map<string, McpToolPermissionRequest[]>()
    for (const r of permissionRequests) {
      if (!r.agent || r.agent.runId !== view.runId) continue
      map.set(r.agent.agentId, [...(map.get(r.agent.agentId) ?? []), r])
    }
    return map
  }, [permissionRequests, view.runId])

  return (
    <section className="flex-1 min-h-0 overflow-y-auto bg-background px-8 py-6" data-testid="execution-area">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <header className="flex items-center gap-3">
          <GitBranch className="w-4 h-4 text-accent-400" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-content-primary">
              {readOnly ? 'Agent run (review)' : PHASE_TITLE[view.phase]}
            </p>
            <p className="mt-0.5 text-xs text-content-muted">
              {view.steps.length
                ? `${view.steps.length} agent${view.steps.length === 1 ? '' : 's'} · ${formatUsd(view.totals.costUsd)} · ${view.totals.tokens.toLocaleString()} tokens`
                : 'The orchestrator is decomposing your task…'}
            </p>
          </div>
          {(!active || readOnly) && (
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 rounded-lg border border-surface-border px-3 py-1.5 text-xs text-content-secondary hover:text-content-primary hover:bg-surface-hover"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to chat
            </button>
          )}
        </header>

        {view.steps.length === 0 && active && (
          <div className="flex items-center gap-2 text-sm text-content-muted">
            <Loader2 className="w-4 h-4 animate-spin text-accent-400" /> Planning…
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {view.steps.map((step) => {
            const agent = view.agents[step.id]
            if (!agent) return null
            return (
              <AgentCard
                key={step.id}
                agent={agent}
                flash={flash === step.id}
                runActive={active}
                requests={readOnly ? [] : requestsByAgent.get(step.id) ?? []}
                onRespondPermission={onRespondPermission}
              />
            )
          })}
        </div>

        {(view.synthesis || view.phase === 'synthesizing') && (
          <article className="rounded-xl border border-accent-900/70 bg-accent-950/25 p-5" data-testid="synthesis">
            <header className="mb-3 flex items-center gap-2 text-accent-300">
              <Sparkles className="h-4 w-4" />
              <span className="text-xs font-semibold uppercase tracking-wider">Final synthesis</span>
              {view.phase === 'synthesizing' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </header>
            <ProvenanceText
              text={view.synthesis}
              agentIds={agentIds}
              streaming={view.phase === 'synthesizing'}
              onSelectAgent={onSelectAgent}
            />
            {view.phase === 'complete' && (
              <p className="mt-4 text-[11px] text-content-muted">
                Synthesized by {view.steps.length} agent{view.steps.length === 1 ? '' : 's'} · {formatUsd(view.totals.costUsd)} total · {view.totals.tokens.toLocaleString()} tokens
              </p>
            )}
          </article>
        )}

        {view.phase === 'failed' && (
          <div className="flex items-start gap-2 rounded-xl border border-red-900/60 bg-red-950/20 p-4 text-sm text-red-300">
            <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>Run failed: {view.failureReason}</span>
          </div>
        )}
      </div>
    </section>
  )
}

const PHASE_TITLE: Record<RunView['phase'], string> = {
  planning: 'Planning',
  preflight: 'Plan ready for review',
  running: 'Agents running',
  synthesizing: 'Synthesizing',
  complete: 'Run complete',
  failed: 'Run failed',
}

/** Markdown with [1.1] provenance markers as chips that jump to the source agent. */
function ProvenanceText({
  text, agentIds, streaming, onSelectAgent,
}: { text: string; agentIds: Set<string>; streaming: boolean; onSelectAgent: (id: string) => void }) {
  const linked = useMemo(() => linkProvenance(text, agentIds), [text, agentIds])
  return (
    <div
      className="provenance text-[15px] leading-7 text-content-primary"
      onClickCapture={(e) => {
        const anchor = (e.target as HTMLElement).closest('a')
        const href = anchor?.getAttribute('href') ?? ''
        if (href.startsWith('#agent-')) {
          e.preventDefault()
          e.stopPropagation()
          onSelectAgent(href.slice('#agent-'.length))
        }
      }}
    >
      <MarkdownRenderer content={linked} isStreaming={streaming} />
    </div>
  )
}

interface CardProps {
  agent: AgentView
  flash: boolean
  runActive: boolean
  requests: McpToolPermissionRequest[]
  onRespondPermission: (response: McpToolPermissionResponse) => void
}

const AgentCard = memo(
  function AgentCard({ agent, flash, runActive, requests, onRespondPermission }: CardProps) {
    const settled = agent.status === 'done' || agent.status === 'failed' || agent.status === 'cancelled'
    const [expanded, setExpanded] = useState(false)
    const collapsed = settled && !expanded && requests.length === 0
    const badge = BADGE[agent.status]
    const liveCounter = !settled && agent.streamedTokens > 0 ? `~${agent.streamedTokens.toLocaleString()} tok` : null

    return (
      <article
        id={`agent-card-${agent.step.id}`}
        data-testid={`agent-card-${agent.step.id}`}
        data-status={agent.status}
        className={cn(
          'rounded-xl border bg-surface-elevated p-4 shadow-sm transition-shadow',
          agent.status === 'paused' ? 'border-amber-800/70' : 'border-surface-border',
          flash && 'ring-2 ring-accent-600/70',
          collapsed ? 'min-h-0' : 'min-h-[150px]'
        )}
      >
        <header className="flex items-start gap-3">
          <div className="rounded-lg bg-accent-950/40 p-2 text-accent-300">
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-content-primary truncate">{agent.step.id} · {agent.step.label}</p>
            <p className="mt-0.5 truncate text-[11px] text-content-muted">
              {agent.step.role} · {agent.step.model || 'default model'}
              {agent.attempt > 1 && ` · attempt ${agent.attempt}`}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className={cn('rounded border px-1.5 py-0.5 text-[10px] font-medium', badge.className)}>{badge.label}</span>
            <span className="text-[10px] tabular-nums text-content-muted">
              {liveCounter ?? (agent.tokenCount > 0 ? `${agent.tokenCount.toLocaleString()} tok · ${formatUsd(agent.costUsd)}` : '')}
            </span>
          </div>
        </header>

        {collapsed ? (
          <button
            onClick={() => setExpanded(true)}
            className="mt-3 flex w-full items-start gap-2 text-left text-xs text-content-secondary hover:text-content-primary"
          >
            <StatusIcon status={agent.status} className="mt-0.5" />
            <span className="line-clamp-2 flex-1">{agent.failure ?? summarize(agent.output ?? agent.liveText)}</span>
            <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
          </button>
        ) : (
          <div className="mt-3 border-t border-surface-border/70 pt-3">
            {agent.output ? (
              <div className="text-sm text-content-secondary">
                <MarkdownRenderer content={agent.output} />
              </div>
            ) : agent.liveText ? (
              <div className="whitespace-pre-wrap text-sm leading-6 text-content-secondary">{agent.liveText}</div>
            ) : (
              <p className="text-sm text-content-muted">
                {agent.status === 'queued' ? (runActive ? 'Waiting for its phase…' : 'Did not start') : agent.status === 'paused' ? '' : 'Working…'}
              </p>
            )}

            {agent.pause && requests.length === 0 && (
              <p className="mt-2 text-xs text-amber-300">Calling {agent.pause.serverName}:{agent.pause.toolName}…</p>
            )}
            {requests.map((request) => (
              <div key={request.requestId} className="mt-3">
                <McpPermissionDialog inline request={request} onRespond={onRespondPermission} />
              </div>
            ))}

            {settled && (
              <button
                onClick={() => setExpanded(false)}
                className="mt-2 flex items-center gap-1 text-[11px] text-content-muted hover:text-content-secondary"
              >
                <ChevronUp className="h-3 w-3" /> Collapse
              </button>
            )}
          </div>
        )}

        {/* Reflection gate between this agent's output and the next step (spec §08) */}
        {(agent.reflections.length > 0 || agent.status === 'reflecting') && (
          <div className="mt-3 space-y-1 border-t border-dashed border-surface-border/70 pt-2" data-testid="reflection-gate">
            {agent.reflections.map((r, i) => (
              <p key={i} className={cn('text-[11px]', r.passed ? 'text-emerald-400' : 'text-amber-300')}>
                Reflection gate · attempt {r.attempt} · {r.score}/5 {r.passed ? 'passed' : 'failed — retrying'} — {r.reason}
              </p>
            ))}
            {agent.status === 'reflecting' && (
              <p className="flex items-center gap-1.5 text-[11px] text-sky-300">
                <Loader2 className="h-3 w-3 animate-spin" /> Reflection gate · reviewing…
              </p>
            )}
          </div>
        )}
        {agent.failure && !collapsed && <p className="mt-2 text-xs text-red-400">{agent.failure}</p>}
      </article>
    )
  }
)

function summarize(text: string): string {
  const flat = text.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat || 'No output'
}
