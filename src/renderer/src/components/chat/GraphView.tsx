// Graph view of a multi-agent run with the human-in-the-loop inbox (UI Goals 6 and 7,
// designs/06-graph-view.png, 08–10). The graph takes the whole pane; the inspector (Needs you, Node,
// Run log) is a collapsible bottom dock whose behaviour lives in lib/graphDock.ts. Approvals are
// answered from the same request list as the List view and the focus view, so all three stay in sync.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import type { AgentView, RunView } from '../../lib/multiAgentRunState'
import { elapsedMs, formatElapsed, isRunActive } from '../../lib/multiAgentRunState'
import { ORCH_ID, OUT_ID, columnLabels, planningNodes, runGraphNodes } from '../../lib/agentGraphNodes'
import { layoutDag } from '../../lib/dagLayout'
import { argsSummary, bareTool, inboxSummary, nextWaiting, trustToolResponses } from '../../lib/approvalQueue'
import type { DockState, DockTab } from '../../lib/graphDock'
import { DOCK_COLLAPSED_PX, clampDockHeight, dockHeight, dockReducer, initialDock, readSavedDock, writeSavedDock } from '../../lib/graphDock'
import { AgentGraphCanvas, useElementSize, usePageVisible } from './AgentGraphCanvas'
import { Preflight, formatTokens, isWorking, peakOverlap, shortModel } from './MultiAgentSidebarView'
import type { CostEstimate } from '../../../../shared/multiAgentModels'
import { formatUsd } from '../../../../shared/multiAgentModels'
import type { AgentStep, AssessAction, McpToolPermissionRequest, McpToolPermissionResponse, MultiAgentConfig } from '../../../../shared/types'
import { StepControls } from './StepControls'
import { AssessCard, CoverageSection } from './CoveragePanel'
import { GanttStrip } from './GanttView'

interface Props {
  view: RunView
  config: MultiAgentConfig
  readOnly: boolean
  now: number
  estimate: CostEstimate | null
  /** agentId → pending requests, oldest first (approvalQueues of the shared request list). */
  queues: Map<string, McpToolPermissionRequest[]>
  onRespond: (r: McpToolPermissionResponse) => void
  onApprovePlan: (steps?: AgentStep[]) => void
  onCancelPlan: () => void
  onAbort: () => void
  onOpenAgent?: (agentId: string) => void
  /** The dock's pinned state and height are remembered per chat. */
  chatId?: string | null
  /** false while the List view is showing (this view stays mounted): its shortcuts are off. */
  active?: boolean
  /** Spec B 7b: answer an assess pause from Needs you or the Assess tab. */
  onAssess?: (action: AssessAction) => void
}

/** Arrow keys on the dock's handle change its height by this fraction of the pane. */
const RESIZE_KEY_STEP = 0.05

export function GraphView({ view, config, readOnly, now, estimate, queues, onRespond, onApprovePlan, onCancelPlan, onAbort, onOpenAgent, chatId, active = true, onAssess }: Props) {
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
  const preflight = view.phase === 'preflight' && !readOnly
  // Spec B 7b: an assess pause (follow-up approval or ask_user) waits on the user like an approval.
  const assessWaiting = !readOnly && !!view.assessPause
  const waitingTotal = [...queues.values()].reduce((n, q) => n + q.length, 0) + (preflight ? 1 : 0) + (assessWaiting ? 1 : 0)
  const hasAssess = !!view.checklist?.length || view.assess.length > 0

  const [selected, setSelected] = useState<string | null>(null)
  // The agent whose card J/K/Y/N act on.
  const [activeCard, setActiveCard] = useState<string | null>(null)
  useEffect(() => { if (selected && !nodes.some((n) => n.id === selected)) setSelected(null) }, [nodes, selected])

  const [dock, dispatch] = useReducer(dockReducer, chatId, (id) => initialDock(readSavedDock(id)))
  useEffect(() => { dispatch({ type: 'approvals', count: waitingTotal, now: Date.now() }) }, [waitingTotal])
  useEffect(() => {
    if (dock.closeAt === null) return
    const t = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, dock.closeAt - Date.now()))
    return () => clearTimeout(t)
  }, [dock.closeAt])
  // Per chat: another chat restores its own; a new chat (no id yet → id) keeps the dock as it is.
  const pinned = dock.mode === 'pinned'
  const savedFor = useRef(chatId)
  useEffect(() => {
    if (savedFor.current !== chatId) {
      const from = savedFor.current
      savedFor.current = chatId
      if (from) { dispatch({ type: 'restore', saved: readSavedDock(chatId) }); return }
    }
    writeSavedDock(chatId, { pinned, fraction: dock.pinnedFraction })
  }, [chatId, pinned, dock.pinnedFraction])

  const pane = useRef<HTMLDivElement>(null)
  const paneH = useElementSize(pane).h
  const height = dockHeight(dock, paneH)

  // Cmd/Ctrl+J toggles the dock; Esc closes a peek opened by selecting a node (before the dock-wide Esc).
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (document.querySelector('[aria-modal="true"]')) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        dispatch({ type: 'toggle' })
      } else if (e.key === 'Escape' && !e.defaultPrevented && dock.mode === 'peek' && dock.peekFromSelect) {
        e.preventDefault()
        dispatch({ type: 'dismiss' })
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active, dock.mode, dock.peekFromSelect])

  const select = (id: string): void => {
    setSelected(id)
    if (queues.has(id)) setActiveCard(id)
    dispatch({ type: 'select', hasApprovals: queues.has(id) })
  }
  const onEmptyClick = (): void => {
    if (dock.mode === 'peek' && dock.peekFromSelect) setSelected(null)
    dispatch({ type: 'dismiss' })
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="graph-view">
      <div ref={pane} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 min-w-0 flex-1">
          <AgentGraphCanvas nodes={nodes} columnLabels={labels} animate={live && visible} interactive
            selectedId={selected ?? (dock.mode !== 'collapsed' && dock.tab === 'needs' ? activeCard : null)} onSelect={select} onEmptyClick={onEmptyClick}
            onOpen={(id) => { if (id !== ORCH_ID && id !== OUT_ID && view.agents[id]) onOpenAgent?.(id) }} />
        </div>
        <GraphDock dock={dock} dispatch={dispatch} height={height} paneH={paneH} waiting={waitingTotal} selected={selected} tabs={hasAssess ? ['needs', 'node', 'assess', 'log'] : ['needs', 'node', 'log']}
          latest={view.log.at(-1) ? `${formatElapsed(Math.max(0, view.log.at(-1)!.ts - view.startedAt))} · ${view.log.at(-1)!.text}` : ''}>
          {dock.tab === 'needs' && (
            <>
              {assessWaiting && <div className="max-w-[560px] px-7 pt-3" data-testid="needs-assess"><AssessCard view={view} config={config} readOnly={readOnly} onAssess={onAssess} /></div>}
              {(!assessWaiting || preflight || queues.size > 0) && (
                <NeedsYou view={view} config={config} preflight={preflight} estimate={estimate} queues={queues} order={order}
                  activeCard={activeCard} setActiveCard={setActiveCard} selected={selected}
                  onRespond={onRespond} onApprovePlan={onApprovePlan} onCancelPlan={onCancelPlan} />
              )}
            </>
          )}
          {dock.tab === 'assess' && <div className="px-7 pb-4"><CoverageSection view={view} config={config} readOnly={readOnly} onAssess={onAssess} /></div>}
          {dock.tab === 'node' && <NodePanel view={view} id={selected} now={now} models={models} onOpenAgent={onOpenAgent} />}
          {dock.tab === 'log' && <RunLog view={view} now={live ? now : undefined} />}
        </GraphDock>
      </div>
      <StatsStrip view={view} config={config} live={live} now={now} waiting={waitingTotal} onAbort={onAbort} />
    </div>
  )
}

const TAB_LABEL: Record<DockTab, string> = { needs: 'Needs you', node: 'Node', assess: 'Assess', log: 'Run log' }

/** The bottom dock: a 44px bar when collapsed, else handle + tabs + the tab body (designs/08, 09, 07). */
function GraphDock({ dock, dispatch, height, paneH, waiting, selected, latest, children, tabs = ['needs', 'node', 'log'] }: {
  dock: DockState; dispatch: React.Dispatch<Parameters<typeof dockReducer>[1]>; height: number; paneH: number
  waiting: number; selected: string | null; latest: string; children: React.ReactNode
  /** Spec B 7b: "assess" appears when the run has a checklist. */
  tabs?: DockTab[]
}) {
  const open = dock.mode !== 'collapsed'
  const [dragging, setDragging] = useState(false)
  // The expand and collapse buttons replace each other: keep keyboard focus on whichever is shown.
  const toggleBtn = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  useLayoutEffect(() => { if (refocus.current) { refocus.current = false; toggleBtn.current?.focus() } }, [open])
  const toggle = (): void => { refocus.current = true; dispatch({ type: 'toggle' }) }
  const fraction = paneH ? height / paneH : dock.pinnedFraction
  const resizeTo = (px: number): void => { if (paneH) dispatch({ type: 'resize', fraction: clampDockHeight(px, paneH) / paneH }) }
  const onHandleDown = (e: React.PointerEvent): void => {
    const startY = e.clientY
    const startH = height
    setDragging(true)
    const move = (ev: PointerEvent): void => resizeTo(startH - (ev.clientY - startY))
    const up = (): void => { setDragging(false); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const onHandleKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    resizeTo(height + (e.key === 'ArrowUp' ? 1 : -1) * RESIZE_KEY_STEP * paneH)
  }
  const alert = !open && waiting > 0
  const yellowTop = open && dock.tab === 'needs' && waiting > 0
  const redTop = open && dock.mode === 'peek' && dock.peekFromSelect && dock.tab === 'node'
  const count = (n: number | string, tone = 'text-ma-dim') => <span className={cn('font-mono text-[11px]', tone)}>{n}</span>
  return (
    <section aria-label="Run inspector" data-testid="graph-dock" data-mode={dock.mode} data-dragging={dragging}
      onPointerDown={() => { if (open) dispatch({ type: 'touch' }) }} onKeyDown={() => { if (open) dispatch({ type: 'touch' }) }}
      className={cn('ma-gdock relative flex flex-none flex-col overflow-hidden bg-[#0b0b0b]',
        yellowTop ? 'border-t border-[#e6b422]/55 shadow-[0_-14px_40px_rgba(230,180,34,0.06)]'
          : redTop ? 'border-t border-ma-red/70'
          : alert ? 'ma-gdock-alert border-t border-[#e6b422]/55'
          : 'border-t-[0.5px] border-white/10')}
      style={{ height: open ? (paneH ? height : undefined) : DOCK_COLLAPSED_PX }}>
      <div aria-live="polite" className="sr-only" data-testid="dock-announce">{dock.mode === 'auto' ? dock.announce : ''}</div>
      {!open ? (
        <div className="flex h-[44px] flex-none items-center gap-2.5 px-5" data-testid="dock-bar">
          {tabs.map((t) => (
            <button key={t} onClick={() => dispatch({ type: 'tab', tab: t })} data-testid={`dock-chip-${t}`}
              className={cn('flex flex-none items-center gap-[7px] rounded-lg border-[0.5px] px-2.5 py-[5px] text-[12.5px] hover:bg-white/5',
                t === 'needs' && waiting > 0 ? 'border-[#e6b422]/50 text-[#e6b422]' : 'border-white/10 text-[#9a9a9a]')}>
              {TAB_LABEL[t]}{t !== 'log' && ' '}
              {t === 'needs' && count(waiting, waiting > 0 ? 'text-[#e6b422]' : 'text-ma-dim')}
              {t === 'node' && count(selected ?? 'none selected')}
            </button>
          ))}
          <span className="ml-3.5 min-w-0 flex-1 truncate font-mono text-[11px] text-ma-dim" data-testid="dock-latest">{latest}</span>
          <span className="flex-none font-mono text-[10.5px] text-[#5a5a5a]">⌘J</span>
          <button ref={toggleBtn} aria-label="Expand panel" aria-expanded={false} aria-controls="graph-dock-panel" onClick={toggle}
            className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] border-[0.5px] border-white/[0.12] hover:bg-white/5">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#9a9a9a" strokeWidth="1.3" aria-hidden><path d="M2 8l4-4 4 4" /></svg>
          </button>
        </div>
      ) : (
        <>
          <div role="separator" aria-orientation="horizontal" aria-label="Resize panel" tabIndex={0}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}
            onPointerDown={onHandleDown} onKeyDown={onHandleKey} data-testid="dock-handle"
            className="group flex h-3.5 flex-none cursor-row-resize items-center justify-center outline-none">
            <span className="h-[3px] w-11 rounded-sm bg-white/[0.14] group-hover:bg-white/30 group-focus-visible:bg-ma-red/70" />
          </div>
          <div className="ma-gdock-head flex h-[34px] flex-none items-center gap-[22px] border-b-[0.5px] border-white/[0.06] px-7 text-[13px]">
            <div role="tablist" aria-label="Inspector" className="ma-gdock-tabs flex h-full items-center gap-[22px]">
              {tabs.map((t) => (
                <button key={t} role="tab" id={`graph-dock-tab-${t}`} aria-selected={dock.tab === t} aria-controls="graph-dock-panel"
                  onClick={() => dispatch({ type: 'tab', tab: t })}
                  className={cn('-mb-px flex h-full flex-none items-center gap-1.5 whitespace-nowrap border-b-2',
                    dock.tab === t ? cn('text-white', t === 'needs' ? 'border-[#e6b422]' : 'border-ma-red') : 'border-transparent text-[#8a8a8a] hover:text-ma-soft')}>
                  {TAB_LABEL[t]}{t === 'node' && selected ? ` ${selected}` : ''}{t === 'needs' && waiting > 0 && ' '}
                  {t === 'needs' && waiting > 0 && <span className="font-mono text-[11px] text-[#e6b422]" data-testid="needs-count">{waiting}</span>}
                </button>
              ))}
            </div>
            <span className="flex-1" />
            {dock.mode === 'auto' && !dock.touched && (
              <span className="ma-gdock-auto truncate rounded-full bg-[#e6b422]/10 px-[9px] py-0.5 font-mono text-[10.5px] text-[#e6b422]" data-testid="dock-auto-chip"
                title="auto-opened · closes when queue is empty"><span className="ma-gdock-auto-full">auto-opened · closes when queue is empty</span></span>
            )}
            {dock.mode === 'peek' && dock.peekFromSelect && <span className="truncate font-mono text-[10.5px] text-ma-dim">Esc to close</span>}
            {isPinned(dock) && <span className="truncate font-mono text-[10.5px] text-ma-dim" data-testid="dock-pin-label">{Math.round(fraction * 100)}% · drag to resize</span>}
            <button aria-pressed={isPinned(dock)} onClick={() => dispatch({ type: 'pin', fraction })} data-testid="dock-pin"
              className={cn('flex-none rounded-md border-[0.5px] px-[9px] py-[3px] font-mono text-[11px] hover:bg-white/5',
                isPinned(dock) ? 'border-ma-red/50 text-[#ff8a85]' : 'border-white/[0.12] text-[#9a9a9a]')}>
              {isPinned(dock) ? 'Pinned' : 'Pin'}
            </button>
            <button ref={toggleBtn} aria-label="Collapse panel" aria-expanded aria-controls="graph-dock-panel" onClick={toggle}
              className="flex h-6 w-6 flex-none items-center justify-center rounded-md border-[0.5px] border-white/[0.12] hover:bg-white/5">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#9a9a9a" strokeWidth="1.3" aria-hidden><path d="M2 4l4 4 4-4" /></svg>
            </button>
          </div>
          <div role="tabpanel" id="graph-dock-panel" aria-labelledby={`graph-dock-tab-${dock.tab}`} className="min-h-0 flex-1 overflow-y-auto" data-testid="dock-panel">
            {children}
          </div>
        </>
      )}
    </section>
  )
}

const isPinned = (d: DockState): boolean => d.mode === 'pinned'

/** One card per agent with a waiting call (the head of its queue), in a wrapping grid (designs/09). */
function NeedsYou({ view, config, preflight, estimate, queues, order, activeCard, setActiveCard, selected, onRespond, onApprovePlan, onCancelPlan }: {
  view: RunView; config: MultiAgentConfig; preflight: boolean; estimate: CostEstimate | null
  queues: Map<string, McpToolPermissionRequest[]>; order: string[]; activeCard: string | null; setActiveCard: (id: string | null) => void
  selected: string | null; onRespond: (r: McpToolPermissionResponse) => void; onApprovePlan: (steps?: AgentStep[]) => void; onCancelPlan: () => void
}) {
  const inbox = useMemo(() => inboxSummary(queues), [queues])
  const agents = order.filter((id) => queues.has(id))
  if (!preflight && agents.length === 0) return <p className="px-7 py-3.5 text-[12.5px] text-ma-mute" data-testid="needs-empty">Nothing needs you right now.</p>
  const current = activeCard && queues.has(activeCard) ? activeCard : null
  const goTo = (id: string | null): void => {
    setActiveCard(id)
    if (id) document.getElementById(`dock-card-${id}`)?.focus()
  }
  const respondHead = (id: string | null, approved: boolean): void => {
    const head = id ? queues.get(id)?.[0] : undefined
    if (head) onRespond({ requestId: head.requestId, approved, alwaysAllow: false, userNote: '' })
  }
  // J/K move between cards, Y allows, N denies — only while focus is inside the panel.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || inbox.total === 0) return
    const key = e.key.toLowerCase()
    if (key === 'j' || key === 'k') goTo(nextWaiting(order, queues, current, key === 'j' ? 1 : -1))
    else if (key === 'y' || key === 'n') respondHead(current ?? nextWaiting(order, queues, null), key === 'y')
    else return
    e.preventDefault()
  }
  return (
    <div role="group" aria-label="Approvals" onKeyDown={onKeyDown} className="flex flex-col gap-3 px-7 pb-4 pt-3">
      {preflight && <div className="max-w-[560px]"><Preflight view={view} config={config} estimate={estimate} onApprove={onApprovePlan} onCancel={onCancelPlan} /></div>}
      {inbox.total > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-[12.5px] text-[#cfcfcf]" data-testid="needs-summary">
            <b className="font-semibold">{inbox.total} tool call{inbox.total === 1 ? '' : 's'}</b> waiting across {inbox.agents} agent{inbox.agents === 1 ? '' : 's'}
          </span>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-ma-dim">J / K move · Y allow · N deny</span>
          {inbox.topTool && (
            <button onClick={() => { for (const r of trustToolResponses(queues, inbox.topTool)) onRespond(r) }}
              title={`Allow every ${bareTool(inbox.topTool.toolName)} call in this chat without asking`}
              className="rounded-[7px] border-[0.5px] border-white/[0.14] px-2.5 py-[5px] text-[12px] text-[#d8d8d8] hover:bg-white/5">
              Trust {bareTool(inbox.topTool.toolName)} for all
            </button>
          )}
        </div>
      )}
      {agents.length > 0 && (
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]" data-testid="needs-cards">
          {agents.map((id) => (
            <ApprovalCard key={queues.get(id)![0].requestId} agent={view.agents[id]} queue={queues.get(id)!} selected={selected === id}
              onFocus={() => setActiveCard(id)} onRespond={onRespond} />
          ))}
        </div>
      )}
    </div>
  )
}

/** The head of one agent's queue: id and role, +N queued, tool, args or code (about 3 lines), Allow / Trust agent / Deny. */
function ApprovalCard({ agent, queue, selected, onFocus, onRespond }: {
  agent?: AgentView; queue: McpToolPermissionRequest[]; selected: boolean; onFocus: () => void; onRespond: (r: McpToolPermissionResponse) => void
}) {
  const [sent, setSent] = useState(false)
  const head = queue[0]
  const id = head.agent?.agentId ?? ''
  const code = typeof head.args.code === 'string' ? head.args.code : null
  const respond = (approved: boolean, agentTrust?: 'trust'): void => {
    if (sent) return
    setSent(true)
    onRespond({ requestId: head.requestId, approved, alwaysAllow: false, userNote: '', ...(agentTrust && { agentTrust }) })
  }
  const btn = 'rounded-md px-2.5 py-[5px] text-[11.5px] disabled:opacity-50'
  return (
    <div id={`dock-card-${id}`} tabIndex={-1} onFocus={onFocus} data-testid={`needs-card-${id}`}
      className={cn('flex min-w-0 flex-col gap-2 rounded-[11px] border-[0.5px] border-l-2 border-[#e6b422]/40 border-l-[#e6b422] bg-[#e6b422]/[0.06] px-[13px] py-3 outline-none',
        'focus-visible:shadow-[0_0_0_2px_rgba(230,180,34,0.45)]', selected && 'shadow-[0_0_0_2px_rgba(229,57,53,0.35)]')}>
      <div className="flex items-center gap-[7px]">
        <span className="font-mono text-[12px] text-white">{id}</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-[#9a9a9a]">{agent?.step.role ?? head.agent?.role}</span>
        {queue.length > 1 && <span className="flex-none rounded-full bg-[#e6b422]/[0.12] px-[7px] py-px font-mono text-[10.5px] text-[#e6b422]" title={`${queue.length - 1} more queued`}>+{queue.length - 1}</span>}
      </div>
      <div className="truncate font-mono text-[12px] text-[#e6b422]">{bareTool(head.toolName)}</div>
      <pre className="line-clamp-3 h-[67px] overflow-hidden whitespace-pre-wrap break-words rounded-[7px] bg-black/35 px-[9px] py-2 font-mono text-[11px] leading-[1.55] text-[#bdbdbd]" data-testid="needs-card-args">
        {code ?? argsSummary(head.args)}
      </pre>
      <div className="mt-auto flex flex-wrap gap-1.5">
        <button disabled={sent} onClick={() => respond(true)} className={cn(btn, 'bg-[#e6b422] font-medium text-[#0a0a0a] hover:bg-[#f0c33a]')}>Allow</button>
        <button disabled={sent} onClick={() => respond(true, 'trust')} title={`Trust ${head.agent?.role ?? 'this agent'} for the rest of the run`}
          className={cn(btn, 'border-[0.5px] border-[#e6b422]/50 text-[#e6b422] hover:bg-[#e6b422]/10')}>Trust agent</button>
        <button disabled={sent} onClick={() => respond(false)} className={cn(btn, 'border-[0.5px] border-white/[0.12] text-[#9a9a9a] hover:bg-white/5 hover:text-ma-text')}>Deny</button>
      </div>
    </div>
  )
}

function selectionText(view: RunView, id: string): string {
  if (id === ORCH_ID) return `orchestrator · planned ${view.steps.length} agents`
  if (id === OUT_ID) return 'final synthesis'
  const feeds = view.steps.filter((s) => s.dependsOn?.includes(id)).map((s) => s.id)
  return `${id} · feeds ${feeds.length ? feeds.join(', ') : 'the final synthesis'}`
}

function NodePanel({ view, id, now, models, onOpenAgent }: {
  view: RunView; id: string | null; now: number; models: { orchestrator: string; synthesizer: string }; onOpenAgent?: (agentId: string) => void
}) {
  if (!id) return <p className="px-7 py-3.5 text-[12.5px] text-ma-mute">Click a node to inspect it; double-click to open it.</p>
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-3 py-1"><span className="text-ma-mute">{k}</span><span className="min-w-0 truncate text-right font-mono text-ma-soft">{v}</span></div>
  // Wide and short: facts on the left, the latest output on the right.
  const frame = (title: string, facts: React.ReactNode, body: React.ReactNode) => (
    <div className="px-7 pb-4 pt-3 text-[12.5px]" data-testid="node-panel">
      <div className="mb-2 flex items-center gap-3">
        <p className="min-w-0 flex-1 truncate text-[13px] text-white">{title}</p>
        <span className="min-w-0 truncate text-[12px] text-ma-mute" data-testid="graph-selection">{selectionText(view, id)}</span>
        {view.agents[id] && onOpenAgent && (
          <button onClick={() => onOpenAgent(id)} className="h-7 flex-none rounded-[7px] border-[0.5px] border-white/[0.14] px-2.5 text-[12px] text-[#d8d8d8] hover:bg-white/5">Open full view</button>
        )}
      </div>
      <div className="grid gap-x-8 [grid-template-columns:minmax(260px,520px)_minmax(0,1fr)]">
        <div className="grid grid-cols-2 gap-x-6 self-start">{facts}</div>
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  )
  if (id === ORCH_ID) {
    return frame('Orchestrator', <>{row('Model', shortModel(models.orchestrator))}{row('Agents planned', view.steps.length)}</>,
      view.planning.fallbackReason && <p className="text-[#e8c77f]">Fallback plan: {view.planning.fallbackReason}</p>)
  }
  if (id === OUT_ID) {
    return frame('Final synthesis', <>{row('Model', shortModel(models.synthesizer))}{row('State', view.phase)}</>,
      view.synthesis && <p className="line-clamp-[10] whitespace-pre-wrap text-ma-soft">{view.synthesis}</p>)
  }
  const agent = view.agents[id]
  if (!agent) return null
  const gate = agent.reflections.at(-1)
  const elapsed = elapsedMs(agent, isWorking(agent.status) ? now : agent.startedAt || 0)
  const text = agent.status === 'running' ? agent.liveText : agent.output
  return frame(`${id} ${agent.step.label}`, (
    <>
      {row('Role', agent.step.role)}
      {row('Model', shortModel(agent.step.model) || 'active model')}
      {row('State', agent.status)}
      {row('Tokens · cost', `${formatTokens(agent.tokenCount || agent.streamedTokens)} · ${formatUsd(agent.costUsd)}`)}
      {row('Elapsed', elapsed === null ? '—' : formatElapsed(elapsed))}
      {row('Tool calls', agent.timeline.filter((t) => t.kind === 'tool').length)}
      {row('Waits on', agent.step.dependsOn?.length ? agent.step.dependsOn.join(', ') : '—')}
    </>
  ), (
    <>
      {gate && <p className={cn('mb-2', gate.passed ? 'text-[#7fdcb0]' : 'text-[#ff8c88]')}>Review {gate.score}/5 — {gate.reason}</p>}
      {agent.failure && <p className="mb-2 text-[#ff8c88]">{agent.failure}</p>}
      {text ? <p className="line-clamp-[8] whitespace-pre-wrap text-ma-soft" data-testid="node-output">{text}</p> : !gate && !agent.failure && <p className="text-ma-dim">No output yet.</p>}
      {/* Spec B 7d: steer, re-run on… (rectification R3: no lock). */}
      <div className="mt-3 max-w-[560px]"><StepControls view={view} agentId={id} /></div>
    </>
  ))
}

const LOG_TONE = { info: 'text-ma-soft', ok: 'text-[#7fdcb0]', wait: 'text-[#e8c77f]', fail: 'text-[#ff8c88]' } as const

function RunLog({ view, now }: { view: RunView; now?: number }) {
  if (view.log.length === 0) return <p className="px-7 py-3.5 text-[12.5px] text-ma-mute">Nothing logged yet.</p>
  return (
    <>
    {/* Spec B 7c: a compact Gantt above the log. */}
    <div className="px-7 pt-3"><GanttStrip view={view} now={now} /></div>
    <ol className="flex flex-col gap-1.5 px-7 pb-4 pt-3 font-mono text-[11.5px]" data-testid="run-log">
      {[...view.log].reverse().map((l, i) => (
        <li key={view.log.length - i} className="flex gap-2.5">
          <span className="flex-none text-ma-dim">{formatElapsed(Math.max(0, l.ts - view.startedAt))}</span>
          <span className={cn('min-w-0 break-words', LOG_TONE[l.tone])}>{l.text}</span>
        </li>
      ))}
    </ol>
    </>
  )
}

function StatsStrip({ view, config, live, now, waiting, onAbort }: { view: RunView; config: MultiAgentConfig; live: boolean; now: number; waiting: number; onAbort: () => void }) {
  const agents = view.steps.map((s) => view.agents[s.id]).filter((a): a is AgentView => !!a)
  const working = agents.filter((a) => isWorking(a.status)).length
  const end = live ? now : (view.endedAt ?? now)
  const peak = peakOverlap(agents.filter((a) => a.startedAt).map((a) => [a.startedAt!, a.endedAt ?? end] as [number, number]))
  const checks = agents.reduce((n, a) => n + a.reflections.filter((g) => g.model !== 'deterministic precheck').length, 0)
  const passed = agents.filter((a) => a.status === 'done').length
  const cap = view.runConfig?.budgetCapUsd ?? config.budgetCapUsd
  const m = view.runConfig?.models ?? config.models
  return (
    <div className="flex min-h-[44px] flex-none flex-wrap items-center gap-x-[30px] gap-y-1 border-t-[0.5px] border-white/[0.06] bg-[#080808] px-7 py-1.5 font-mono text-[11.5px] text-[#bdbdbd] [&>span]:whitespace-nowrap" data-testid="graph-stats">
      <span>{formatUsd(view.totals.costUsd)} <span className="text-ma-dim">/ {formatUsd(cap)}</span></span>
      <span>{formatTokens(view.totals.tokens)} tok</span>
      <span>{formatElapsed(Math.max(0, end - view.startedAt))} elapsed</span>
      <span>{live ? `${working} agent${working === 1 ? '' : 's'} in parallel` : `peak ${peak} in parallel`}</span>
      {waiting > 0 && <span className="text-[#e6b422]">{waiting} approval{waiting === 1 ? '' : 's'} waiting</span>}
      <span className="text-ma-dim">{checks} reflection check{checks === 1 ? '' : 's'} · {passed}/{agents.length} passed</span>
      <span className="min-w-0 flex-1 truncate text-right text-ma-dim [white-space:nowrap]" title={`orch ${m.orchestrator} · reflect ${m.reflection} · synth ${m.synthesizer}`}>
        orch {shortModel(m.orchestrator)} · reflect {shortModel(m.reflection)} · synth {shortModel(m.synthesizer)}
      </span>
      {live && view.phase !== 'preflight' && (
        <button onClick={onAbort} className="h-6 flex-none rounded-[7px] border-[0.5px] border-white/[0.09] px-2.5 text-ma-mute hover:bg-ma-bg3 hover:text-ma-text">Abort</button>
      )}
    </div>
  )
}
