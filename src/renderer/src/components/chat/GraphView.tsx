// Graph view of a multi-agent run with the human-in-the-loop inbox (UI Goal 6, designs/06-graph-view.png).
// The graph is the run's own plan (layout from the dependency DAG); the inspector answers approvals from
// the same request list as the List view and the focus view, so all three stay in sync.

import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/utils'
import type { AgentView, RunView } from '../../lib/multiAgentRunState'
import { elapsedMs, formatElapsed, isRunActive } from '../../lib/multiAgentRunState'
import { ORCH_ID, OUT_ID, columnLabels, planningNodes, runGraphNodes } from '../../lib/agentGraphNodes'
import { layoutDag } from '../../lib/dagLayout'
import { argsSummary, bareTool, nextWaiting } from '../../lib/approvalQueue'
import { AgentGraphCanvas, usePageVisible } from './AgentGraphCanvas'
import { Preflight, formatTokens, isWorking, peakOverlap, shortModel } from './MultiAgentSidebarView'
import type { CostEstimate } from '../../../../shared/multiAgentModels'
import { formatUsd } from '../../../../shared/multiAgentModels'
import type { McpToolPermissionRequest, McpToolPermissionResponse, MultiAgentConfig } from '../../../../shared/types'

type Tab = 'needs' | 'node' | 'log'

interface Props {
  view: RunView
  config: MultiAgentConfig
  readOnly: boolean
  now: number
  estimate: CostEstimate | null
  /** agentId → pending requests, oldest first (approvalQueues of the shared request list). */
  queues: Map<string, McpToolPermissionRequest[]>
  onRespond: (r: McpToolPermissionResponse) => void
  onApprovePlan: () => void
  onCancelPlan: () => void
  onAbort: () => void
  onOpenAgent?: (agentId: string) => void
}

export function GraphView({ view, config, readOnly, now, estimate, queues, onRespond, onApprovePlan, onCancelPlan, onAbort, onOpenAgent }: Props) {
  const live = isRunActive(view) && !readOnly
  const visible = usePageVisible()
  const models = view.runConfig?.models ?? config.models
  const planning = view.steps.length === 0 && view.phase === 'planning'
  const pending = useMemo(() => new Map([...queues].map(([id, q]) => [id, q.length])), [queues])
  // The same canvas draws the plan while it is written and the run graph after it lands (Goal 5).
  const nodes = useMemo(
    () => (planning ? planningNodes(view.planning, models.orchestrator) : runGraphNodes(view, pending, models)),
    [planning, view, pending, models]
  )
  const labels = useMemo(() => columnLabels(layoutDag(nodes).columns), [nodes])
  const order = useMemo(() => view.steps.map((s) => s.id), [view.steps])
  const waitingTotal = [...queues.values()].reduce((n, q) => n + q.length, 0) + (view.phase === 'preflight' && !readOnly ? 1 : 0)

  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('needs')
  // With nothing chosen, the inbox focuses the first agent waiting on the user.
  const focusAgent = selected && queues.has(selected) ? selected : nextWaiting(order, queues, null)
  useEffect(() => { if (selected && !nodes.some((n) => n.id === selected)) setSelected(null) }, [nodes, selected])

  const select = (id: string): void => {
    setSelected(id)
    setTab(queues.has(id) ? 'needs' : 'node')
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graph-view">
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 border-r-[0.5px] border-white/5">
          <AgentGraphCanvas nodes={nodes} columnLabels={labels} animate={live && visible} interactive
            selectedId={selected ?? (tab === 'needs' ? focusAgent : null)} onSelect={select}
            onOpen={(id) => { if (id !== ORCH_ID && id !== OUT_ID && view.agents[id]) onOpenAgent?.(id) }} />
        </div>
        <aside className="flex w-[380px] max-w-[45%] flex-none flex-col px-[22px] py-5" aria-label="Inspector" data-testid="graph-inspector">
          <div role="tablist" className="flex gap-[18px] border-b-[0.5px] border-white/[0.06] text-[13px]">
            <TabButton active={tab === 'needs'} onClick={() => setTab('needs')} accent="yellow">
              Needs you {waitingTotal > 0 && <span className="font-mono text-[11px] text-[#e6b422]" data-testid="needs-count">{waitingTotal}</span>}
            </TabButton>
            <TabButton active={tab === 'node'} onClick={() => setTab('node')}>Node{selected ? ` ${selected}` : ''}</TabButton>
            <TabButton active={tab === 'log'} onClick={() => setTab('log')}>Run log</TabButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-3.5">
            {tab === 'needs' && (
              <NeedsYou view={view} config={config} readOnly={readOnly} estimate={estimate} queues={queues} order={order} focusAgent={focusAgent}
                onRespond={onRespond} onReview={select} onApprovePlan={onApprovePlan} onCancelPlan={onCancelPlan} />
            )}
            {tab === 'node' && <NodePanel view={view} id={selected} now={now} models={models} />}
            {tab === 'log' && <RunLog view={view} />}
          </div>
          <div className="flex items-center justify-between gap-3 border-t-[0.5px] border-white/[0.06] pt-3.5">
            <span className="min-w-0 truncate text-[12px] text-ma-mute" data-testid="graph-selection">{selectionText(view, selected)}</span>
            {selected && view.agents[selected] && onOpenAgent && (
              <button onClick={() => onOpenAgent(selected)} className="h-7 flex-none rounded-[7px] border-[0.5px] border-white/[0.14] px-2.5 text-[12px] text-[#d8d8d8] hover:bg-white/5">Open full view</button>
            )}
          </div>
        </aside>
      </div>
      <StatsStrip view={view} config={config} live={live} now={now} waiting={waitingTotal} onAbort={onAbort} />
    </div>
  )
}

function TabButton({ active, onClick, accent, children }: { active: boolean; onClick: () => void; accent?: 'yellow'; children: React.ReactNode }) {
  return (
    <button role="tab" aria-selected={active} onClick={onClick}
      className={cn('-mb-px border-b-2 pb-2.5', active ? cn('text-white', accent === 'yellow' ? 'border-[#e6b422]' : 'border-ma-red') : 'border-transparent text-ma-mute hover:text-ma-soft')}>
      {children}
    </button>
  )
}

function selectionText(view: RunView, id: string | null): string {
  if (!id) return 'Click a node to inspect it; double-click to open it'
  if (id === ORCH_ID) return `Selected orchestrator · planned ${view.steps.length} agents`
  if (id === OUT_ID) return 'Selected final synthesis'
  const feeds = view.steps.filter((s) => s.dependsOn?.includes(id)).map((s) => s.id)
  return `Selected ${id} · feeds ${feeds.length ? feeds.join(', ') : 'the final synthesis'}`
}

function NeedsYou({ view, config, readOnly, estimate, queues, order, focusAgent, onRespond, onReview, onApprovePlan, onCancelPlan }: {
  view: RunView; config: MultiAgentConfig; readOnly: boolean; estimate: CostEstimate | null
  queues: Map<string, McpToolPermissionRequest[]>; order: string[]; focusAgent: string | null
  onRespond: (r: McpToolPermissionResponse) => void; onReview: (id: string) => void; onApprovePlan: () => void; onCancelPlan: () => void
}) {
  const preflight = view.phase === 'preflight' && !readOnly
  const others = order.filter((id) => id !== focusAgent && queues.has(id))
  if (!preflight && !focusAgent) return <p className="text-[12.5px] text-ma-mute" data-testid="needs-empty">Nothing needs you right now.</p>
  return (
    <div className="flex flex-col gap-3">
      {preflight && <Preflight view={view} config={config} estimate={estimate} onApprove={onApprovePlan} onCancel={onCancelPlan} />}
      {focusAgent && <FocusedApproval key={queues.get(focusAgent)![0].requestId} agent={view.agents[focusAgent]} queue={queues.get(focusAgent)!} onRespond={onRespond} />}
      {others.map((id) => {
        const q = queues.get(id)!
        return (
          <div key={id} className="flex items-center gap-2.5 rounded-[10px] border-[0.5px] border-white/[0.07] bg-[#0f0f0f] px-3 py-2.5" data-testid={`needs-row-${id}`}>
            <span className="h-[7px] w-[7px] flex-none rounded-full bg-[#e6b422]" />
            <span className="font-mono text-[12px]">{id}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[#e6b422]">{bareTool(q[0].toolName)}</span>
            {q.length > 1 && <span className="font-mono text-[10.5px] text-ma-mute">+{q.length - 1} queued</span>}
            <button onClick={() => onReview(id)} className="h-6 rounded-md border-[0.5px] border-[#e6b422]/45 px-2 text-[11.5px] text-[#e6b422] hover:bg-[#e6b422]/10">Review</button>
          </div>
        )
      })}
    </div>
  )
}

/** The full permission card for the agent in focus; the rest of its queue shows as "next". */
function FocusedApproval({ agent, queue, onRespond }: { agent?: AgentView; queue: McpToolPermissionRequest[]; onRespond: (r: McpToolPermissionResponse) => void }) {
  const [sent, setSent] = useState(false)
  const head = queue[0]
  const code = typeof head.args.code === 'string' ? head.args.code : null
  const respond = (approved: boolean, agentTrust?: 'trust'): void => {
    if (sent) return
    setSent(true)
    onRespond({ requestId: head.requestId, approved, alwaysAllow: false, userNote: '', ...(agentTrust && { agentTrust }) })
  }
  const btn = 'h-7 rounded-[7px] px-3 text-[12px] disabled:opacity-50'
  return (
    <div className="rounded-xl border-[0.5px] border-l-2 border-[#e6b422]/45 border-l-[#e6b422] bg-[#e6b422]/[0.07] p-3.5" data-testid="needs-focused">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] text-white">{head.agent?.agentId}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#cfcfcf]">{agent?.step.role ?? head.agent?.role}</span>
        <span className="rounded-full bg-[#e6b422]/[0.12] px-2 py-0.5 font-mono text-[11px] text-[#e6b422]">1 of {queue.length}</span>
      </div>
      <div className="mt-2.5 font-mono text-[12px] text-[#e6b422]">{bareTool(head.toolName)}</div>
      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/35 px-[11px] py-[9px] font-mono text-[11px] leading-relaxed text-[#bdbdbd]">{code ?? argsSummary(head.args)}</pre>
      <div className="mt-3 flex flex-wrap gap-[7px]">
        <button disabled={sent} onClick={() => respond(true)} className={cn(btn, 'bg-[#e6b422] font-medium text-[#0a0a0a] hover:bg-[#f0c33a]')}>Allow</button>
        <button disabled={sent} onClick={() => respond(true, 'trust')} title={`Trust ${head.agent?.role ?? 'this agent'} for the rest of the run`}
          className={cn(btn, 'border-[0.5px] border-[#e6b422]/50 text-[#e6b422] hover:bg-[#e6b422]/10')}>Trust agent</button>
        <button disabled={sent} onClick={() => respond(false)} className={cn(btn, 'border-[0.5px] border-white/[0.12] text-ma-mute hover:bg-white/5 hover:text-ma-text')}>Deny</button>
      </div>
      {queue[1] && <div className="mt-2.5 truncate font-mono text-[11px] text-ma-dim" data-testid="needs-next">next: {bareTool(queue[1].toolName)} · {argsSummary(queue[1].args)}</div>}
    </div>
  )
}

function NodePanel({ view, id, now, models }: { view: RunView; id: string | null; now: number; models: { orchestrator: string; synthesizer: string } }) {
  if (!id) return <p className="text-[12.5px] text-ma-mute">Select a node in the graph.</p>
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-3 py-1"><span className="text-ma-mute">{k}</span><span className="min-w-0 truncate text-right font-mono text-ma-soft">{v}</span></div>
  if (id === ORCH_ID) {
    return (
      <div className="text-[12.5px]" data-testid="node-panel">
        <p className="mb-2 text-[13px] text-white">Orchestrator</p>
        {row('Model', shortModel(models.orchestrator))}
        {row('Agents planned', view.steps.length)}
        {view.planning.fallbackReason && <p className="mt-2 text-[#e8c77f]">Fallback plan: {view.planning.fallbackReason}</p>}
      </div>
    )
  }
  if (id === OUT_ID) {
    return (
      <div className="text-[12.5px]" data-testid="node-panel">
        <p className="mb-2 text-[13px] text-white">Final synthesis</p>
        {row('Model', shortModel(models.synthesizer))}
        {row('State', view.phase)}
        {view.synthesis && <p className="mt-2 line-clamp-[10] whitespace-pre-wrap text-ma-soft">{view.synthesis}</p>}
      </div>
    )
  }
  const agent = view.agents[id]
  if (!agent) return null
  const gate = agent.reflections.at(-1)
  const elapsed = elapsedMs(agent, isWorking(agent.status) ? now : agent.startedAt || 0)
  const text = agent.status === 'running' ? agent.liveText : agent.output
  return (
    <div className="text-[12.5px]" data-testid="node-panel">
      <p className="mb-2 text-[13px] text-white">{id} {agent.step.label}</p>
      {row('Role', agent.step.role)}
      {row('Model', shortModel(agent.step.model) || 'active model')}
      {row('State', agent.status)}
      {row('Tokens · cost', `${formatTokens(agent.tokenCount || agent.streamedTokens)} · ${formatUsd(agent.costUsd)}`)}
      {row('Elapsed', elapsed === null ? '—' : formatElapsed(elapsed))}
      {row('Tool calls', agent.timeline.filter((t) => t.kind === 'tool').length)}
      {row('Waits on', agent.step.dependsOn?.length ? agent.step.dependsOn.join(', ') : '—')}
      {gate && <p className={cn('mt-2', gate.passed ? 'text-[#7fdcb0]' : 'text-[#ff8c88]')}>Review {gate.score}/5 — {gate.reason}</p>}
      {agent.failure && <p className="mt-2 text-[#ff8c88]">{agent.failure}</p>}
      {text && <p className="mt-2 line-clamp-[8] whitespace-pre-wrap text-ma-soft" data-testid="node-output">{text}</p>}
    </div>
  )
}

const LOG_TONE = { info: 'text-ma-soft', ok: 'text-[#7fdcb0]', wait: 'text-[#e8c77f]', fail: 'text-[#ff8c88]' } as const

function RunLog({ view }: { view: RunView }) {
  if (view.log.length === 0) return <p className="text-[12.5px] text-ma-mute">Nothing logged yet.</p>
  return (
    <ol className="flex flex-col gap-1.5 font-mono text-[11.5px]" data-testid="run-log">
      {[...view.log].reverse().map((l, i) => (
        <li key={view.log.length - i} className="flex gap-2.5">
          <span className="flex-none text-ma-dim">{formatElapsed(Math.max(0, l.ts - view.startedAt))}</span>
          <span className={cn('min-w-0 break-words', LOG_TONE[l.tone])}>{l.text}</span>
        </li>
      ))}
    </ol>
  )
}

function StatsStrip({ view, config, live, now, waiting, onAbort }: { view: RunView; config: MultiAgentConfig; live: boolean; now: number; waiting: number; onAbort: () => void }) {
  const agents = view.steps.map((s) => view.agents[s.id]).filter((a): a is AgentView => !!a)
  const working = agents.filter((a) => isWorking(a.status)).length
  const end = live ? now : (view.endedAt ?? now)
  const peak = peakOverlap(agents.filter((a) => a.startedAt).map((a) => [a.startedAt!, a.endedAt ?? end] as [number, number]))
  const checks = agents.reduce((n, a) => n + a.reflections.filter((g) => g.model !== 'deterministic precheck').length, 0)
  const cap = view.runConfig?.budgetCapUsd ?? config.budgetCapUsd
  const m = view.runConfig?.models ?? config.models
  return (
    <div className="flex h-[60px] flex-none items-center gap-x-8 gap-y-1 overflow-hidden border-t-[0.5px] border-white/[0.06] bg-[#080808] px-6 font-mono text-[12px] text-[#bdbdbd]" data-testid="graph-stats">
      <span>{formatUsd(view.totals.costUsd)} <span className="text-ma-dim">/ {formatUsd(cap)}</span></span>
      <span>{formatTokens(view.totals.tokens)} tok</span>
      <span>{formatElapsed(Math.max(0, end - view.startedAt))} elapsed</span>
      <span>{live ? `${working} agent${working === 1 ? '' : 's'} in parallel` : `peak ${peak} in parallel`}</span>
      {waiting > 0 && <span className="text-[#e6b422]">{waiting} approval{waiting === 1 ? '' : 's'} waiting</span>}
      <span className="text-ma-dim">reflection {checks} / {agents.length} checks</span>
      <span className="min-w-0 flex-1 truncate text-right text-ma-dim" title={`orch ${m.orchestrator} · reflect ${m.reflection} · synth ${m.synthesizer}`}>
        orch {shortModel(m.orchestrator)} · reflect {shortModel(m.reflection)} · synth {shortModel(m.synthesizer)}
      </span>
      {live && view.phase !== 'preflight' && (
        <button onClick={onAbort} className="h-6 flex-none rounded-[7px] border-[0.5px] border-white/[0.09] px-2.5 text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">Abort</button>
      )}
    </div>
  )
}
