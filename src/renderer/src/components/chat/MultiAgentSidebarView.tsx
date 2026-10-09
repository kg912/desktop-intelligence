// The multi-agent run, hosted in the widened sidebar (designs/01-dock-live.html,
// 02-states.html). Left column: run summary, concurrency timeline, steps.
// Right column: one accordion card per agent with its trace. CSS transitions
// only — no motion.* here (M1 Pro scroll-jank issue).

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Network } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import type { AgentStatus, AgentView, RunView, TimelineItem } from '../../lib/multiAgentRunState'
import { CUT_OFF_LABEL, elapsedMs, formatElapsed, isRunActive, linkProvenance } from '../../lib/multiAgentRunState'
import type { CostEstimate } from '../../../../shared/multiAgentModels'
import { ESTIMATE, formatUsd } from '../../../../shared/multiAgentModels'
import type { McpToolPermissionRequest, McpToolPermissionResponse, MultiAgentConfig } from '../../../../shared/types'

export const DOCK_WIDTH = 760
const PLAN_COLUMN_WIDTH = 248

export type Dot = 'ok' | 'run' | 'wait' | 'fail' | 'idle'
export const DOT: Record<AgentStatus, Dot> = {
  queued: 'idle', running: 'run', reflecting: 'run', retrying: 'run', paused: 'wait', done: 'ok', failed: 'fail', cancelled: 'fail',
}
export const isWorking = (s: AgentStatus): boolean => s === 'running' || s === 'reflecting' || s === 'retrying' || s === 'paused'

/** "deepseek/deepseek-v4.1-flash" → "deepseek-v4.1-flash" */
export const shortModel = (id: string): string => id.split('/').pop() || id

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
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

/** Most agents ever working at the same moment. */
export function peakOverlap(intervals: Array<[number, number]>): number {
  const points = intervals.flatMap(([s, e]) => [[s, 1], [e, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let current = 0
  let peak = 0
  for (const [, delta] of points) peak = Math.max(peak, (current += delta))
  return peak
}

interface Props {
  view: RunView
  task: string
  config: MultiAgentConfig
  /** A saved run: no Abort, no approvals. */
  readOnly: boolean
  estimate: CostEstimate | null
  permissionRequests: McpToolPermissionRequest[]
  onRespondPermission: (response: McpToolPermissionResponse) => void
  onApprove: () => void
  onCancel: () => void
  onAbort: () => void
  focusAgentId: string | null
  onSelectAgent: (agentId: string) => void
  onClose: () => void
  /** Very narrow window: the plan/timeline column hides first. */
  hidePlanColumn?: boolean
  /** The chat's runs, oldest first; "Run N of M" shows when there is more than one. */
  runIds?: string[]
  onShowRun?: (runId: string) => void
  /** false: this live run started with observability off and is not being logged. */
  recorded?: boolean
}

export function MultiAgentSidebarView(props: Props) {
  const { view, task, config, readOnly, estimate, permissionRequests, onRespondPermission, focusAgentId, onSelectAgent, onClose } = props
  const live = isRunActive(view) && !readOnly
  const now = useNow(live)
  useEscape(onClose)

  const requestsByAgent = useMemo(() => {
    const map = new Map<string, McpToolPermissionRequest[]>()
    if (readOnly) return map
    for (const r of permissionRequests) {
      if (r.agent?.runId !== view.runId) continue
      map.set(r.agent.agentId, [...(map.get(r.agent.agentId) ?? []), r])
    }
    return map
  }, [permissionRequests, view.runId, readOnly])

  const models = view.runConfig?.models ?? config.models
  return (
    <div className="flex h-full text-ma-text" style={{ width: DOCK_WIDTH }} data-testid="agent-dock">
      {!props.hidePlanColumn && <section aria-label="Run plan" className="flex min-h-0 flex-none flex-col border-r-[0.5px] border-white/5" style={{ width: PLAN_COLUMN_WIDTH }}>
        <div className="border-b-[0.5px] border-white/5 px-4 pb-3 pt-3.5">
          <div className="flex items-center justify-between font-semibold">
            <span className="text-[14px]">Agent run</span>
            {live && view.phase !== 'preflight' && (
              <button onClick={props.onAbort} className="h-6 rounded-[7px] border-[0.5px] border-white/[0.09] px-2.5 text-[12.5px] font-normal text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">
                Abort
              </button>
            )}
            {readOnly && <span className="font-mono text-[11px] font-normal text-ma-mute">read-only</span>}
          </div>
          <RunNav runIds={props.runIds} current={view.runId} locked={live} onShowRun={props.onShowRun} />
          {!readOnly && props.recorded === false && <LoggingOff />}
          <p className="mt-0.5 truncate text-[12px] text-ma-mute" title={task}>{task || 'Multi-agent run'}</p>
          <div className="mt-2 flex flex-wrap gap-1" aria-label="Run models">
            {(['orchestrator', 'reflection', 'synthesizer'] as const).map((role) => (
              <span key={role} title={`${role}: ${models[role]}`} className="max-w-full truncate rounded-[5px] border-[0.5px] border-white/[0.09] px-1.5 font-mono text-[10.5px] leading-[18px] text-ma-mute">
                {role === 'orchestrator' ? 'orch' : role === 'reflection' ? 'reflect' : 'synth'} · {shortModel(models[role]) || 'active'}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-b-[0.5px] border-white/5 px-4 py-2.5 font-mono text-[12px] text-ma-mute" data-testid="run-totals">
          <span><b className="font-medium text-ma-text">{formatUsd(view.totals.costUsd)}</b> / {formatUsd(config.budgetCapUsd)}</span>
          <span><b className="font-medium text-ma-text">{formatTokens(view.totals.tokens)}</b> tok</span>
          {view.totals.budgetReached && <span className="text-ma-amber">Budget cap reached</span>}
        </div>
        {view.steps.length > 0 && <ConcurrencyTimeline view={view} live={live} now={now} />}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {view.steps.length === 0 && <p className="px-2 py-3 text-[12.5px] text-ma-mute">{view.phase === 'failed' ? view.failureReason : 'Orchestrator is planning…'}</p>}
          {view.steps.map((step) => {
            const agent = view.agents[step.id]
            if (!agent) return null
            const waitingOn = (step.dependsOn ?? []).filter((d) => view.agents[d]?.status !== 'done')
            return (
              <button
                key={step.id}
                data-testid={`step-${step.id}`}
                onClick={() => onSelectAgent(step.id)}
                className={cn(
                  'relative flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-ma-bg2',
                  focusAgentId === step.id && 'bg-ma-bg3 before:absolute before:bottom-2 before:left-0 before:top-2 before:w-0.5 before:rounded-sm before:bg-ma-red'
                )}
              >
                <span className="ma-dot mt-1.5" data-s={DOT[agent.status]} />
                <span className="min-w-0">
                  <span className={cn('block text-[13px] leading-snug', agent.status === 'queued' && 'text-ma-mute')}>{step.label}</span>
                  {agent.status === 'queued' && waitingOn.length > 0 ? (
                    <span className="mt-0.5 block text-[11.5px] text-ma-mute">Waits for {waitingOn.join(', ')}</span>
                  ) : (
                    <span className="mt-0.5 block truncate font-mono text-[11.5px] text-ma-mute">
                      {step.role} · {agent.status === 'paused' && requestsByAgent.has(step.id) ? 'needs approval' : shortModel(step.model) || 'active model'}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        <div className="flex justify-between gap-3 border-t-[0.5px] border-white/5 px-4 py-2.5 font-mono text-[11.5px] text-ma-mute">
          <span className="min-w-0 break-words">orchestrator · {shortModel(models.orchestrator)}</span>
          <span className="min-w-0 break-words">reflect · {shortModel(models.reflection)}</span>
        </div>
      </section>}

      <section aria-label="Agent traces" className="min-w-0 flex-1 overflow-y-auto p-3.5">
        {view.phase === 'preflight' && !readOnly ? (
          <Preflight view={view} config={config} estimate={estimate} onApprove={props.onApprove} onCancel={props.onCancel} />
        ) : (
          <AgentCards view={view} now={now} config={config} requestsByAgent={requestsByAgent} onRespondPermission={onRespondPermission} focusAgentId={focusAgentId} />
        )}
        {view.phase === 'failed' && view.failureReason && view.steps.length > 0 && (
          <p className="rounded-xl border-[0.5px] border-ma-red/35 bg-ma-red/[0.08] p-3 text-[12.5px] text-ma-redtext">Run failed: {view.failureReason}</p>
        )}
      </section>
    </div>
  )
}

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

export const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** "Tools: brave_web_search, +2" / "No tools" — names without their server namespace. */
/** "Run N of M" with prev/next. Locked while a live run is shown — it cannot be swapped out. */
/** The run started with observability off: say so, and offer to log the next one (this one cannot be). */
function LoggingOff() {
  const [enabled, setEnabled] = useState(false)
  const enable = () => {
    window.api.obsSetPrefs({ observabilityEnabled: true }).then(() => setEnabled(true), (err: unknown) => console.error('[MultiAgent] could not turn on logging:', err))
  }
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11.5px]" data-testid="logging-off">
      <span className="font-mono text-ma-amber">Logging off</span>
      {enabled ? (
        <span className="text-ma-mute">On from the next run</span>
      ) : (
        <button onClick={enable} className="h-5 rounded-[5px] border-[0.5px] border-white/[0.09] px-2 text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">
          Log the next run
        </button>
      )}
    </div>
  )
}

function RunNav({ runIds, current, locked, onShowRun }: { runIds?: string[]; current: string; locked: boolean; onShowRun?: (runId: string) => void }) {
  const index = runIds?.indexOf(current) ?? -1
  if (!runIds || runIds.length < 2 || index < 0) return null
  const go = (i: number) => onShowRun?.(runIds[i])
  const btn = 'flex h-5 w-5 items-center justify-center rounded-[5px] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text disabled:pointer-events-none disabled:opacity-35'
  return (
    <div className="mt-1 flex items-center gap-1 font-mono text-[11px] text-ma-mute" aria-label="Run history">
      <button aria-label="Previous run" className={btn} disabled={locked || index === 0} onClick={() => go(index - 1)}><ChevronLeft size={13} /></button>
      <span data-testid="run-position">Run {index + 1} of {runIds.length}</span>
      <button aria-label="Next run" className={btn} disabled={locked || index === runIds.length - 1} onClick={() => go(index + 1)}><ChevronRight size={13} /></button>
    </div>
  )
}

export function toolsLabel(tools: string[]): string {
  const names = tools.map((t) => t.split('__').slice(1).join('__') || t)
  return names.length ? `Tools: ${names[0]}${names.length > 1 ? `, +${names.length - 1}` : ''}` : 'No tools'
}

// ── Concurrency timeline: the proof that workers overlap ─────────────────────

function ConcurrencyTimeline({ view, live, now }: { view: RunView; live: boolean; now: number }) {
  const t0 = view.startedAt
  const end = live ? now : (view.endedAt ?? Math.max(t0, ...Object.values(view.agents).map((a) => a.endedAt ?? 0)))
  const span = Math.max(end - t0, 1) * (live ? 1.25 : 1) // live: headroom for queued bars
  const pos = (t: number): number => Math.min(100, Math.max(0, ((t - t0) / span) * 100))
  const agents = view.steps.map((s) => view.agents[s.id]).filter((a): a is AgentView => !!a)
  const intervals = agents.filter((a) => a.startedAt).map((a) => [a.startedAt!, a.endedAt ?? end] as [number, number])
  const working = agents.filter((a) => isWorking(a.status)).length
  const peak = peakOverlap(intervals)
  const caption = live && working > 1 ? `${working} agents running in parallel`
    : live && working === 1 ? '1 agent running'
    : peak > 1 ? `Peak: ${peak} agents in parallel`
    : intervals.length ? 'Agents ran one at a time' : 'Waiting to start'

  return (
    <div className="border-b-[0.5px] border-white/5 px-4 pb-3.5 pt-3" aria-label="Agent timeline" data-testid="concurrency-timeline">
      <div className="mb-2 flex justify-between text-[12px] text-ma-mute">
        <b className="font-medium text-ma-redtext" data-testid="concurrency-caption">{caption}</b>
        <span className="font-mono">{clock(end - t0)}</span>
      </div>
      <div className="relative ml-[26px]">
        {agents.map((a) => {
          const started = a.startedAt
          const state = started ? (a.status === 'done' ? 'ok' : DOT[a.status] === 'idle' ? 'q' : DOT[a.status]) : 'q'
          if (!started && !live) return null
          const left = started ? pos(started) : pos(end)
          const right = started ? pos(a.endedAt ?? end) : 100
          return (
            <div key={a.step.id} className="relative my-[5px] h-4" data-testid={`lane-${a.step.id}`}>
              <span className="absolute -left-px -top-px -translate-x-full pr-1.5 font-mono text-[10.5px] text-ma-mute">{a.step.id}</span>
              <i className="ma-lane-bar" data-s={state} style={{ left: `${left}%`, width: `${Math.max(right - left, 1.5)}%` }} />
            </div>
          )
        })}
        {live && <div className="absolute -bottom-1 -top-1 w-px bg-white/35" style={{ left: `${pos(end)}%` }} aria-hidden />}
      </div>
    </div>
  )
}

// ── Pre-flight ───────────────────────────────────────────────────────────────

function Preflight({ view, config, estimate, onApprove, onCancel }: {
  view: RunView; config: MultiAgentConfig; estimate: CostEstimate | null; onApprove: () => void; onCancel: () => void
}) {
  const cap = config.budgetCapUsd
  return (
    <div className="rounded-xl border-[0.5px] border-ma-amber/35 bg-ma-bg1 p-4" data-testid="preflight">
      <p className="text-[14px] font-medium">Review the plan</p>
      <p className="mt-0.5 text-[12.5px] text-ma-mute">Approve it before any agent starts.</p>
      <ol className="mt-3 space-y-1.5">
        {view.steps.map((s) => (
          <li key={s.id} className="flex gap-2 text-[13px]">
            <span className="w-8 flex-none font-mono text-[12px] text-ma-mute">{s.id}</span>
            <span className="min-w-0">
              {s.label}
              <span className="block font-mono text-[11.5px] text-ma-mute">
                {s.role}{s.dependsOn?.length ? ` · after ${s.dependsOn.join(', ')}` : ' · starts immediately'}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {view.runConfig?.excludedServers?.map(({ server, reason }) => (
        <p key={server} data-testid="excluded-server" className="mt-2 truncate border-t-[0.5px] border-white/5 pt-2 font-mono text-[11.5px] text-ma-mute" title={`${server} · excluded: ${reason}`}>
          {server} · excluded: {reason}
        </p>
      ))}
      <div className="mt-3 space-y-0.5 border-t-[0.5px] border-white/5 pt-3 text-[12.5px] text-ma-soft">
        {estimate ? (
          <>
            <p>Estimated cost <span className="text-ma-text">{formatUsd(estimate.minUsd)} – {formatUsd(estimate.maxUsd)}</span></p>
            {estimate.nominal && (
              <p className="text-ma-mute" data-testid="estimate-nominal">
                Nominal figure: tool rounds are unlimited, so the worst case assumes {ESTIMATE.nominalToolRounds} rounds per attempt.
              </p>
            )}
            <p className="font-medium text-ma-amber">
              Worst case {formatUsd(Math.min(estimate.maxUsd, cap))}
              {estimate.maxUsd > cap && <span className="font-normal text-ma-mute"> (capped by the {formatUsd(cap)} budget)</span>}
            </p>
            {estimate.unpricedModels.length > 0 && <p className="text-ma-mute">No published price for {estimate.unpricedModels.join(', ')}, counted as $0.</p>}
          </>
        ) : (
          <p className="text-ma-mute">Cost estimate unavailable (OpenRouter prices not loaded). The {formatUsd(cap)} budget cap still applies.</p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onApprove} className="h-7 rounded-[7px] border-[0.5px] border-ma-red bg-ma-red px-3 text-[12.5px] font-medium text-white hover:bg-[#d8322e]">Approve & run</button>
        <button onClick={onCancel} className="h-7 rounded-[7px] border-[0.5px] border-white/[0.09] px-3 text-[12.5px] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">Cancel</button>
      </div>
    </div>
  )
}

// ── Agent cards ──────────────────────────────────────────────────────────────

function AgentCards({ view, now, config, requestsByAgent, onRespondPermission, focusAgentId }: {
  view: RunView
  now: number
  config: MultiAgentConfig
  requestsByAgent: Map<string, McpToolPermissionRequest[]>
  onRespondPermission: (r: McpToolPermissionResponse) => void
  focusAgentId: string | null
}) {
  // User toggles override the default (working agents open, settled ones collapsed).
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = useCallback((id: string, next: boolean) => setOpen((o) => ({ ...o, [id]: next })), [])

  useEffect(() => {
    if (!focusAgentId) return
    setOpen((o) => ({ ...o, [focusAgentId]: true }))
    requestAnimationFrame(() => document.getElementById(`agent-card-${focusAgentId}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }))
  }, [focusAgentId])

  return (
    <>
      {view.steps.map((step) => {
        const agent = view.agents[step.id]
        if (!agent) return null
        const requests = requestsByAgent.get(step.id) ?? []
        const isOpen = open[step.id] ?? (isWorking(agent.status) || requests.length > 0)
        return (
          <AgentCard
            key={step.id}
            agent={agent}
            open={isOpen}
            now={isWorking(agent.status) ? now : 0}
            maxRetries={config.maxRetriesPerAgent}
            tools={view.runConfig?.tools}
            waitingOn={(step.dependsOn ?? []).filter((d) => view.agents[d]?.status !== 'done')}
            requests={requests}
            onToggle={toggle}
            onRespondPermission={onRespondPermission}
          />
        )
      })}
    </>
  )
}

function stateTag(agent: AgentView, maxRetries: number, hasRequest: boolean): { label: string; tone: 'ok' | 'run' | 'wait' | 'fail' | 'idle' } {
  const lastGate = agent.reflections.at(-1)
  switch (agent.status) {
    case 'done': return { label: lastGate ? `Pass ${lastGate.score}/5` : 'Done', tone: 'ok' }
    case 'running': return { label: agent.attempt > 1 ? `Retry ${agent.attempt - 1} of ${maxRetries}` : 'Live', tone: 'run' }
    case 'reflecting': return { label: 'Reviewing', tone: 'run' }
    case 'retrying': return { label: `Retry ${agent.attempt - 1} of ${maxRetries}`, tone: 'run' }
    case 'paused': return { label: hasRequest ? 'Approval' : 'Tool call', tone: 'wait' }
    case 'failed': return { label: agent.startedAt ? 'Failed' : 'Not started', tone: 'fail' }
    case 'cancelled': return { label: 'Stopped', tone: 'idle' }
    default: return { label: 'Queued', tone: 'idle' }
  }
}

const TAG_TONE = {
  ok: 'text-ma-ok border-ma-ok/30 bg-ma-ok/10',
  run: 'text-ma-redtext border-ma-red/35 bg-ma-red/[0.08]',
  wait: 'text-ma-amber border-ma-amber/30 bg-ma-amber/10',
  fail: 'text-[#ff8c88] border-ma-red/35',
  idle: 'text-ma-mute border-white/[0.09]',
} as const

const AgentCard = memo(function AgentCard({ agent, open, now, maxRetries, tools, waitingOn, requests, onToggle, onRespondPermission }: {
  agent: AgentView
  open: boolean
  now: number
  maxRetries: number
  /** Tools offered to the workers (run_config); undefined on older traces. */
  tools?: string[]
  waitingOn: string[]
  requests: McpToolPermissionRequest[]
  onToggle: (id: string, open: boolean) => void
  onRespondPermission: (r: McpToolPermissionResponse) => void
}) {
  const { step } = agent
  const tag = stateTag(agent, maxRetries, requests.length > 0)
  const elapsed = elapsedMs(agent, now || agent.startedAt || 0)
  const meta = agent.status === 'queued'
    ? [step.role, waitingOn.length ? `starts when ${waitingOn.join(', ')} pass` : 'queued']
    : agent.status === 'paused' && requests.length
      ? [step.role, 'waiting on you']
      : [step.role, shortModel(step.model), agent.tokenCount ? `${formatTokens(agent.tokenCount)} tok` : agent.streamedTokens ? `~${formatTokens(agent.streamedTokens)} tok` : null,
          agent.costUsd ? formatUsd(agent.costUsd) : null, elapsed !== null ? formatElapsed(elapsed) : null]
  const multiAttempt = agent.timeline.some((t) => t.attempt > 0)

  return (
    <article
      id={`agent-card-${step.id}`}
      data-testid={`agent-card-${step.id}`}
      data-status={agent.status}
      data-open={open}
      className={cn('mb-3 overflow-hidden rounded-xl border-[0.5px] bg-ma-bg1', isWorking(agent.status) && agent.status !== 'paused' ? 'border-ma-red/35' : 'border-white/[0.09]')}
    >
      <button onClick={() => onToggle(step.id, !open)} className="flex w-full items-center gap-2.5 px-3.5 py-[11px] text-left" aria-expanded={open}>
        <span className="ma-dot" data-s={DOT[agent.status]} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13.5px] font-medium">{step.id} {step.label}</b>
          <span className="block truncate font-mono text-[11.5px] text-ma-mute">{meta.filter(Boolean).join(' · ')}</span>
          {tools && (
            <span className="block truncate font-mono text-[11px] text-ma-mute" data-testid={`agent-tools-${step.id}`} title={tools.join(', ') || undefined}>
              {toolsLabel(tools)}
            </span>
          )}
        </span>
        {agent.truncated && <CutOffChip limit={agent.truncated} testId={`cut-off-${step.id}`} />}
        {agent.stoppedAtToolLimit && (
          <span data-testid={`tool-limit-${step.id}`} title="The answer came from the forced last round, with tools turned off, after the tool round limit."
            className="inline-flex h-5 flex-none items-center rounded-[5px] border-[0.5px] border-ma-amber/30 bg-ma-amber/10 px-[7px] font-mono text-[11.5px] text-ma-amber">
            stopped at tool limit
          </span>
        )}
        <span className={cn('inline-flex h-5 items-center rounded-[5px] border-[0.5px] px-[7px] font-mono text-[11.5px]', TAG_TONE[tag.tone])}>{tag.label}</span>
        <ChevronDown className={cn('h-[18px] w-[18px] flex-none text-ma-mute transition-transform duration-200', open && 'rotate-180')} strokeWidth={1.6} />
      </button>
      {/* Collapsed cards do not render their timelines. */}
      {open && (
        <div className="border-t-[0.5px] border-white/5 px-3.5 pb-3.5 pt-1" data-testid={`agent-trace-${step.id}`}>
          {/* Plain text, not a timeline node: there is no event to mark yet. */}
          {agent.timeline.length === 0 && !agent.output && requests.length === 0 && !agent.failure && (
            <p className="pt-2.5 text-[12px] text-ma-mute" data-testid={`agent-empty-${step.id}`}>{agent.status === 'queued' ? 'Nothing to show yet' : 'Working…'}</p>
          )}
          {agent.timeline.map((item, i) => (
            <TraceItem key={i} item={item} attemptLabel={multiAttempt ? ` · attempt ${item.attempt + 1}` : ''} streaming={i === agent.timeline.length - 1 && agent.status === 'running'} />
          ))}
          {agent.timeline.length === 0 && agent.output && <TraceItem item={{ kind: 'output', attempt: 0, text: agent.output }} attemptLabel="" streaming={false} />}
          {agent.status === 'reflecting' && (
            <div className="ma-ev" data-k="gate"><i className="ma-k" /><p className="text-[12px] text-ma-mute">Reflection gate · reviewing…</p></div>
          )}
          {requests.map((r) => <ApprovalBlock key={r.requestId} request={r} onRespond={onRespondPermission} />)}
          {agent.failure && (
            <div className="ma-ev" data-k="fail"><i className="ma-k" /><p className="text-[12.5px] text-[#ff8c88]">{agent.failure}</p></div>
          )}
        </div>
      )}
    </article>
  )
})

/**
 * Reasoning: 3 lines collapsed; expanded, at most 18 lines (3 paragraphs of ~6)
 * then it scrolls inside. While streaming it follows the end unless scrolled up.
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && expanded && streaming && pinned.current) el.scrollTop = el.scrollHeight
  }, [text, expanded, streaming])
  const toggle = (): void => {
    pinned.current = true
    setExpanded((x) => !x)
  }
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
      }}
      title={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
      data-expanded={expanded}
      className={cn(
        'ma-reasoning mt-1.5 block min-w-0 cursor-pointer whitespace-pre-wrap border-l-[0.5px] border-white/[0.09] pl-3 text-left text-[13px] italic leading-relaxed text-[#9a9a9a] [overflow-wrap:anywhere]',
        !expanded && 'line-clamp-3'
      )}
    >
      {text}
    </div>
  )
}

function CutOffChip({ limit, testId }: { limit: 'budget' | 'context'; testId: string }) {
  return (
    <span
      data-testid={testId}
      title={limit === 'budget' ? 'The answer reached the output the remaining budget allows.' : "The answer filled the model's context window."}
      className="inline-flex h-5 flex-none items-center rounded-[5px] border-[0.5px] border-ma-amber/30 bg-ma-amber/10 px-[7px] font-mono text-[11.5px] text-ma-amber"
    >
      {CUT_OFF_LABEL[limit]}
    </span>
  )
}

function TraceItem({ item, attemptLabel, streaming }: { item: TimelineItem; attemptLabel: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(false)
  switch (item.kind) {
    case 'reasoning':
      return (
        <div className="ma-ev min-w-0" data-k="reasoning">
          <i className="ma-k" />
          <div className="flex gap-2 text-[12px] text-ma-mute">Reasoning{attemptLabel}<span className="font-mono">· {Math.max(1, Math.round((item.endedAt - item.startedAt) / 1000))}s</span></div>
          <ReasoningBlock text={item.text} streaming={streaming} />
        </div>
      )
    case 'tool': {
      const done = item.done
      return (
        <div className="ma-ev" data-k="tool">
          <i className="ma-k" />
          <div className="flex gap-2 text-[12px] text-ma-mute">Tool call{attemptLabel}{done && <span className="font-mono">· {(done.durationMs / 1000).toFixed(1)}s</span>}</div>
          <button onClick={() => setExpanded((x) => !x)} className="mt-1.5 flex w-full items-center gap-2.5 rounded-lg border-[0.5px] border-white/[0.09] bg-ma-bg2 px-2.5 py-2 text-left font-mono text-[12px]">
            <span className="text-[#ff9a97]">{item.tool}</span>
            <span className="min-w-0 flex-1 truncate text-ma-mute">{item.argsPreview}</span>
            <span className={done && !done.ok ? 'text-[#ff8c88]' : 'text-ma-mute'}>
              {!done ? 'running…' : done.ok ? `${done.resultChars.toLocaleString()} chars` : 'not run'}
            </span>
          </button>
          {expanded && done && (
            <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-ma-bg2 p-2.5 font-mono text-[11.5px] text-ma-soft">{done.resultPreview}</pre>
          )}
        </div>
      )
    }
    case 'output':
      return (
        <div className="ma-ev" data-k="output">
          <i className="ma-k" />
          <div className="flex gap-2 text-[12px] text-ma-mute">Answer{attemptLabel}{streaming && <span className="font-mono">· streaming</span>}</div>
          <div className="mt-1.5 text-[13px] leading-relaxed text-[#d0d0d0] [&_li]:!text-[13px] [&_p]:!text-[13px] [&_p]:!leading-relaxed">
            <MarkdownRenderer content={item.text} isStreaming={streaming} />
          </div>
        </div>
      )
    case 'gate': {
      const judge = item.model ? ` · ${item.model === 'deterministic precheck' ? 'precheck' : shortModel(item.model)}` : ''
      return (
        <div className="ma-ev" data-k={item.passed ? 'gate' : 'gate-bad'} data-testid="reflection-gate">
          <i className="ma-k" />
          <div className="text-[12px] text-ma-mute">Reflection gate{attemptLabel || ` · attempt ${item.attempt + 1}`}{judge}</div>
          <p className={cn('mt-1 text-[12.5px]', item.passed ? 'text-[#7fdcb0]' : 'text-[#ff8c88]')}>
            {item.score ? `${item.score}/5 — ` : ''}{item.reason}
          </p>
          {!item.passed && item.issues && item.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-[12px] text-ma-soft">{item.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
          )}
        </div>
      )
    }
  }
}

function ApprovalBlock({ request, onRespond }: { request: McpToolPermissionRequest; onRespond: (r: McpToolPermissionResponse) => void }) {
  const [sent, setSent] = useState(false)
  const role = request.agent?.role ?? 'Agent'
  const tool = request.toolName.includes('__') ? request.toolName.split('__').slice(1).join('__') : request.toolName
  const args = JSON.stringify(request.args)
  const respond = (approved: boolean, agentTrust?: 'trust'): void => {
    if (sent) return
    setSent(true)
    onRespond({ requestId: request.requestId, approved, alwaysAllow: false, userNote: '', ...(agentTrust && { agentTrust }) })
  }
  const button = 'h-7 rounded-[7px] border-[0.5px] px-3 text-[12.5px] disabled:opacity-50'
  return (
    <div className="ma-ev" data-k="approval" data-testid={`approval-${request.requestId}`}>
      <i className="ma-k" />
      <div className="text-[12px] text-ma-mute">Wants to run a tool</div>
      <div className="mt-1.5 rounded-[9px] border-[0.5px] border-ma-amber/35 bg-ma-amber/10 px-3 py-2.5">
        <p className="text-[12.5px] text-[#e8c77f]">
          <b>{role}</b> wants to call <span className="font-mono">{tool}</span> on {request.serverName} with <span className="font-mono">{args.length > 160 ? `${args.slice(0, 159)}…` : args}</span>.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={sent} onClick={() => respond(true)} className={cn(button, 'border-ma-red/35 bg-ma-red/[0.08] text-ma-redtext hover:bg-ma-red/[0.14]')}>Approve</button>
          <button disabled={sent} onClick={() => respond(false)} className={cn(button, 'border-white/[0.09] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text')}>Deny</button>
          <button disabled={sent} onClick={() => respond(true, 'trust')} className={cn(button, 'border-white/[0.09] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text')}>Trust {role} for this run</button>
        </div>
      </div>
    </div>
  )
}

// ── Main chat: the synthesis, while a run is live ────────────────────────────

export function FinalSynthesis({ view, onSelectAgent }: { view: RunView; onSelectAgent: (agentId: string) => void }) {
  const agentIds = useMemo(() => new Set(view.steps.map((s) => s.id)), [view.steps])
  const linked = useMemo(() => linkProvenance(view.synthesis, agentIds), [view.synthesis, agentIds])
  const passed = view.steps.filter((s) => view.agents[s.id]?.status === 'done').length
  return (
    <div className="mt-5 rounded-[14px] border-[0.5px] border-ma-red/35 bg-gradient-to-b from-ma-red/[0.06] to-ma-red/[0.02] px-[18px] py-4" data-testid="synthesis">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ma-redtext">
        <Network className="h-4 w-4" strokeWidth={1.6} />Final synthesis
        {view.synthesisTruncated && <CutOffChip limit={view.synthesisTruncated} testId="cut-off-synthesis" />}
      </div>
      {view.synthesis ? (
        <div
          className="provenance mt-2 text-[14px] leading-relaxed text-ma-soft"
          onClickCapture={(e) => {
            const href = (e.target as HTMLElement).closest('a')?.getAttribute('href') ?? ''
            if (href.startsWith('#agent-')) {
              e.preventDefault()
              e.stopPropagation()
              onSelectAgent(href.slice('#agent-'.length))
            }
          }}
        >
          <MarkdownRenderer content={linked} isStreaming={view.phase === 'synthesizing'} />
        </div>
      ) : (
        <p className="mt-2 text-[13px] text-[#bdbdbd]">
          {view.steps.length === 0
            ? 'Starts when every agent has passed its gate.'
            : `Starts when every agent has passed its gate. Currently ${passed} of ${view.steps.length} passed.`}
        </p>
      )}
    </div>
  )
}
