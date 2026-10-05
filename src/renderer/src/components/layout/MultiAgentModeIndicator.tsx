// Multi-agent mode pill + hover card for the top bar (designs/05-topbar.html,
// states B–D). Every figure comes from the same RunView the dock renders, with
// the dock's status mapping, so the card and the dock cannot disagree.

import { useEffect, useId, useRef, useState } from 'react'
import { Network } from 'lucide-react'
import type { AgentView, RunView } from '../../lib/multiAgentRunState'
import { servedDiffers } from '../../lib/multiAgentRunState'
import { DOT, formatTokens, isWorking } from '../chat/MultiAgentSidebarView'
import { MODEL_ROLES, formatUsd, resolveRoleModels } from '../../../../shared/multiAgentModels'
import type { ModelRole, ResolvedRoleModel } from '../../../../shared/multiAgentModels'
import type { SidecarStatus } from '../../../../shared/types'

export interface TopBarRun {
  view: RunView
  /** Every run of the chat, oldest first. */
  runIds?: string[]
  /** Live (not a saved run under review) and not yet terminal. */
  live: boolean
  /** Budget the run started with; run_config's value wins once it arrives. */
  budgetCapUsd?: number
}

const CLOSE_DELAY_MS = 150
const PRECHECK = 'deterministic precheck'
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const agentsOf = (view: RunView): AgentView[] => view.steps.map((s) => view.agents[s.id]).filter((a): a is AgentView => !!a)
const phaseCount = (view: RunView): number => Math.max(0, ...view.steps.map((s) => s.phase))
const stoppedByUser = (reason = ''): boolean => /aborted|not approved/i.test(reason)

export type PillTone = 'idle' | 'live' | 'done' | 'bad'

/** The pill's look and mono sub-label for a run (null = no run in this chat yet). */
export function pillSummary(run: TopBarRun | null): { tone: PillTone; sub: string | null } {
  if (!run) return { tone: 'idle', sub: null }
  const { view } = run
  const agents = agentsOf(view)
  if (run.live) {
    const sub = view.phase === 'planning' ? 'planning'
      : view.phase === 'preflight' ? 'plan ready'
      : view.phase === 'synthesizing' ? 'synthesizing'
      : `${agents.filter((a) => isWorking(a.status)).length} of ${agents.length} working`
    return { tone: 'live', sub }
  }
  const failed = agents.filter((a) => a.status === 'failed').length
  if (view.phase === 'failed') {
    const sub = stoppedByUser(view.failureReason) ? 'stopped'
      : /budget/i.test(view.failureReason ?? '') ? 'budget reached'
      : failed ? `${failed} failed` : 'failed'
    return { tone: 'bad', sub }
  }
  if (view.phase !== 'complete') return { tone: 'bad', sub: 'stopped' } // a saved trace that never ended
  if (view.totals.budgetReached) return { tone: 'bad', sub: 'budget reached' }
  if (failed) return { tone: 'bad', sub: `${failed} failed` }
  return { tone: 'done', sub: `${plural(agents.length, 'agent')} · ${plural(phaseCount(view), 'phase')}` }
}

// ── Models table ─────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<ModelRole, string> = { orchestrator: 'Orchestrator', worker: 'Workers', reflection: 'Reflection', synthesizer: 'Synthesis' }
const SOURCE_LABEL: Record<ResolvedRoleModel['source'], string> = { saved: 'saved', default: 'default', active: 'follows active', missing: 'not in catalogue' }

export interface ModelRow {
  role: ModelRole
  model: string
  tag: string
  tone: 'ok' | 'amber' | 'plain'
  /** Hover text for a "served" row: what was asked for. */
  title?: string
}

/** Before run_config: the models the next run will use (null = not loaded yet). After: what the run used and did. */
export function modelRows(run: TopBarRun | null, next: Record<ModelRole, ResolvedRoleModel> | null): ModelRow[] {
  const config = run?.view.runConfig
  if (!run || !config) {
    return MODEL_ROLES.map((role) => {
      const r = next?.[role]
      if (!r) return { role, model: '—', tag: '—', tone: 'plain' }
      return { role, model: r.model || '—', tag: SOURCE_LABEL[r.source], tone: r.source === 'saved' ? 'ok' : r.source === 'missing' ? 'amber' : 'plain' }
    })
  }
  const { view, live } = run
  const agents = agentsOf(view)
  const gates = agents.flatMap((a) => a.reflections).filter((g) => g.model !== PRECHECK)
  const started = agents.filter((a) => a.startedAt).length
  const served: Record<ModelRole, string | undefined> = {
    orchestrator: view.served.orchestrator,
    worker: agents.find((a) => servedDiffers(a.step.model, a.modelServed))?.modelServed,
    reflection: gates.find((g) => servedDiffers(g.model ?? '', g.modelServed))?.modelServed,
    synthesizer: view.served.synthesizer,
  }
  const activity: Record<ModelRole, string> = {
    orchestrator: view.steps.length ? 'done' : 'planning',
    worker: started ? plural(started, 'agent') : live ? 'waiting' : '—',
    reflection: gates.length ? plural(gates.length, 'check') : live ? 'waiting' : '0 checks',
    synthesizer: view.phase === 'synthesizing' ? 'running' : view.phase === 'complete' ? 'done' : live ? 'waiting' : '—',
  }
  return MODEL_ROLES.map((role) => {
    const requested = role === 'worker'
      ? (agents.find((a) => servedDiffers(a.step.model, a.modelServed))?.step.model ?? config.models.worker)
      : config.models[role]
    const actual = served[role]
    if (servedDiffers(requested, actual)) return { role, model: actual, tag: 'served', tone: 'amber', title: `Requested ${requested}; OpenRouter served ${actual}` }
    return { role, model: requested || '—', tag: activity[role], tone: 'plain' }
  })
}

// ── Graph ────────────────────────────────────────────────────────────────────

const NODE_W = 110
const NODE_H = 32
const ROW = 36
const COL = NODE_W + 64
const SYN_W = 136
const PAD = 8

const fit = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function nodeCaption(agent: AgentView): string {
  if (agent.status === 'queued') return 'Queued'
  const suffix = agent.status === 'reflecting' ? 'reflecting'
    : agent.status === 'paused' ? 'approval'
    : agent.status === 'running' && agent.timeline.some((t) => t.kind === 'tool' && !t.done) ? 'tool'
    : ''
  // ~17 chars of 10px system sans fit a 110px node; too little room left for the label → the state alone.
  const room = 17 - 3 - suffix.length
  if (!suffix) return fit(agent.step.label, 17)
  return room >= 8 ? `${fit(agent.step.label, room)} · ${suffix}` : suffix[0].toUpperCase() + suffix.slice(1)
}

/** Agents as nodes in phase columns, edges from dependsOn, the synthesis node last. */
export function AgentGraph({ view }: { view: RunView }) {
  const phases = [...new Set(view.steps.map((s) => s.phase))].sort((a, b) => a - b)
  const columns = phases.map((p) => view.steps.filter((s) => s.phase === p))
  const rows = Math.max(1, ...columns.map((c) => c.length))
  const height = PAD * 2 + rows * ROW - (ROW - NODE_H)
  const pos = new Map<string, { x: number; y: number }>()
  columns.forEach((col, ci) => {
    const offset = ((rows - col.length) * ROW) / 2
    col.forEach((s, ri) => pos.set(s.id, { x: PAD + ci * COL, y: PAD + offset + ri * ROW }))
  })
  const synX = PAD + columns.length * COL
  const synY = (height - NODE_H) / 2
  const width = synX + SYN_W + PAD
  const dependedOn = new Set(view.steps.flatMap((s) => s.dependsOn ?? []))
  const curve = (x1: number, y1: number, x2: number, y2: number): string => {
    const mx = (x1 + x2) / 2
    return y1 === y2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`
  }
  const synthesisStarted = view.phase === 'synthesizing' || view.phase === 'complete'

  return (
    <svg className="ma-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Agent graph" data-testid="agent-graph">
      {view.steps.flatMap((s) => (s.dependsOn ?? []).filter((d) => pos.has(d)).map((d) => {
        const from = pos.get(d)!
        const to = pos.get(s.id)!
        const live = DOT[view.agents[d]?.status ?? 'queued'] !== 'idle' && view.agents[s.id]?.status !== 'done'
        return <path key={`${d}-${s.id}`} className="ma-g-edge" data-live={live} d={curve(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2)} />
      }))}
      {view.steps.filter((s) => !dependedOn.has(s.id)).map((s) => {
        const from = pos.get(s.id)!
        return <path key={`${s.id}-syn`} className="ma-g-edge" d={curve(from.x + NODE_W, from.y + NODE_H / 2, synX, synY + NODE_H / 2)} />
      })}
      {view.steps.map((s) => {
        const agent = view.agents[s.id]
        const { x, y } = pos.get(s.id)!
        if (!agent) return null
        const state = DOT[agent.status] === 'idle' ? 'q' : DOT[agent.status]
        return (
          <g key={s.id} className="ma-g-node" data-s={state} data-testid={`graph-node-${s.id}`}>
            <title>{`${s.id} ${s.label} — ${agent.status}${agent.failure ? `: ${agent.failure}` : ''}`}</title>
            <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={7} />
            <text x={x + 10} y={y + 14}>{s.id}</text>
            <text className="ma-g-t" x={x + 10} y={y + 26}>{nodeCaption(agent)}</text>
            {state === 'fail' && <text className="ma-g-x" x={x + NODE_W - 16} y={y + 14} aria-label="failed">✕</text>}
          </g>
        )
      })}
      <g className="ma-g-syn" opacity={synthesisStarted ? 1 : 0.5} data-testid="graph-synthesis">
        <rect x={synX} y={synY} width={SYN_W} height={NODE_H} rx={7} />
        <text x={synX + 12} y={synY + 20}>Final synthesis</text>
      </g>
    </svg>
  )
}

// ── Pill + card ──────────────────────────────────────────────────────────────

interface Props {
  run: TopBarRun | null
  dockOpen: boolean
  onToggleDock: () => void
  onOpenRunView: () => void
  onOpenSettings: () => void
}

export function MultiAgentModeIndicator({ run, dockOpen, onToggleDock, onOpenRunView, onOpenSettings }: Props) {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const { tone, sub } = pillSummary(run)

  const show = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
    setOpen(true)
  }
  const hideSoon = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  return (
    <div
      ref={wrapper}
      className="relative ml-1.5"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onBlur={(e) => { if (!wrapper.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault() // the dock's Escape handler skips handled events
          setOpen(false)
        }
      }}
    >
      <button
        type="button"
        className="ma-mpill"
        data-tone={tone}
        data-testid="mode-pill"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        aria-haspopup="dialog"
        aria-label={`Multi-agent${sub ? `, ${sub}` : ''}${run ? `. ${dockOpen ? 'Close' : 'Open'} the run view` : ''}`}
        onFocus={show}
        // Like the "View agent run" pill: there is no dock to open before the first run.
        onClick={run ? onToggleDock : undefined}
      >
        {tone === 'idle' ? <Network className="h-[15px] w-[15px]" strokeWidth={1.6} /> : <span className="ma-mpill-dot" data-s={tone === 'done' ? 'ok' : tone === 'bad' ? 'fail' : 'run'} />}
        Multi-agent
        {sub && <span className="ma-mpill-sub" data-testid="mode-pill-sub">{sub}</span>}
      </button>
      {open && <HoverCard id={cardId} run={run} onOpenRunView={onOpenRunView} onOpenSettings={onOpenSettings} />}
    </div>
  )
}

function useNextRunModels(enabled: boolean): { models: Record<ModelRole, ResolvedRoleModel> | null; sidecar: SidecarStatus | null } {
  const [models, setModels] = useState<Record<ModelRole, ResolvedRoleModel> | null>(null)
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // The settings page's rule ("Models the next run will use"): saved config, active OpenRouter model, catalogue.
    Promise.all([
      window.api.getMultiAgentConfig(),
      window.api.getBackendSettings().catch(() => null),
      window.api.getMultiAgentCatalogue().catch(() => ({ models: [] })),
    ]).then(([config, backend, catalogue]) => {
      if (cancelled) return
      const ids = catalogue.models.length ? new Set(catalogue.models.map((m) => m.id)) : null
      setModels(resolveRoleModels(config.models, backend?.openrouterModel ?? '', ids))
    }).catch(() => { /* rows stay "—" */ })
    window.api.getMultiAgentSidecarStatus?.().then((s) => { if (!cancelled) setSidecar(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [enabled])
  return { models, sidecar }
}

function HoverCard({ id, run, onOpenRunView, onOpenSettings }: { id: string; run: TopBarRun | null; onOpenRunView: () => void; onOpenSettings: () => void }) {
  const view = run?.view ?? null
  const { models: next, sidecar } = useNextRunModels(!view?.runConfig)
  const rows = modelRows(run, next)
  const hasGraph = !!view && view.steps.length > 0
  const agents = view ? agentsOf(view) : []
  const passed = agents.filter((a) => a.status === 'done').length

  let title = 'No agent graph yet'
  let right: string | null = sidecar ? `sidecar ${sidecar}` : null
  let explanation = 'The orchestrator plans the agents after your first message. The graph appears here and in the run view.'
  if (view && run) {
    if (run.live && !hasGraph) explanation = 'The orchestrator is planning the agents. The graph appears here and in the run view.'
    if (!run.live && !hasGraph) explanation = `The run ended before a plan${view.failureReason ? `: ${view.failureReason}` : '.'}`
    if (hasGraph) {
      const index = run.runIds?.indexOf(view.runId) ?? -1
      const state = run.live ? 'in progress' : view.phase === 'complete' ? 'finished' : stoppedByUser(view.failureReason) || view.phase !== 'failed' ? 'stopped' : 'failed'
      title = `${index >= 0 ? `Run ${index + 1} of ${run.runIds!.length}` : 'Run'} · ${state}`
      const unfinished = agents.filter((a) => !['done', 'failed', 'cancelled'].includes(a.status)).map((a) => a.step.phase)
      right = run.live
        ? view.phase === 'preflight' ? 'awaiting approval'
          : unfinished.length ? `Phase ${Math.min(...unfinished)} of ${phaseCount(view)}` : 'Synthesis'
        : passed === agents.length && view.phase === 'complete' ? 'all agents passed' : `${passed} of ${agents.length} passed`
    }
  }
  const cap = view?.runConfig?.budgetCapUsd ?? run?.budgetCapUsd
  const footer = !view ? 'Change in Settings → Multi-Agent'
    : run?.live ? `${formatUsd(view.totals.costUsd)} of ${cap !== undefined ? formatUsd(cap) : '—'} budget`
    : `${formatUsd(view.totals.costUsd)} · ${formatTokens(view.totals.tokens)} tokens`

  return (
    <div id={id} role="dialog" aria-label="Multi-agent run" className="ma-pop" data-testid="mode-card">
      <h4><b data-testid="mode-card-title">{title}</b>{right && <span>{right}</span>}</h4>
      {hasGraph ? <AgentGraph view={view!} /> : <p className="ma-pop-empty">{explanation}</p>}
      <div className="ma-models" aria-label="Models">
        {rows.map((r) => (
          <div key={r.role} className="contents" data-testid={`card-model-${r.role}`}>
            <span className="ma-models-r">{ROLE_LABEL[r.role]}</span>
            <span className="ma-models-m" title={r.title ?? r.model}>{r.model}</span>
            <span className="ma-src" data-tone={r.tone} title={r.title}>{r.tag}</span>
          </div>
        ))}
      </div>
      <div className="ma-pop-foot">
        <span data-testid="mode-card-footer">{footer}</span>
        {hasGraph
          ? <button type="button" onClick={onOpenRunView}>Open run view</button>
          : <button type="button" onClick={onOpenSettings}>Open settings</button>}
      </div>
    </div>
  )
}
