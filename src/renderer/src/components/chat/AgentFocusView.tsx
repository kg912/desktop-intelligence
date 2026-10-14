// Agent focus view (specs/multi-agent-ui-improvements.md Goal 4, designs/04-agent-focus.png):
// a translucent layer over the run page for one agent. Purely a view of the run store —
// opening or closing it never touches the agent. Permissions come from the same request
// list as the agent rows, so resolving here or there is one action.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ClaimLinkedMarkdown } from './ClaimLinks'
import type { AgentView, RunView, TimelineItem } from '../../lib/multiAgentRunState'
import { elapsedMs, formatElapsed } from '../../lib/multiAgentRunState'
import { argsSummary, bareTool } from '../../lib/approvalQueue'
import { APPROVAL_TONE, TAG_TONE, formatTokens, isWorking, shortModel, stateTag } from './MultiAgentSidebarView'
import { formatUsd } from '../../../../shared/multiAgentModels'
import type { McpToolPermissionRequest, McpToolPermissionResponse, MultiAgentConfig } from '../../../../shared/types'

type Tab = 'live' | 'reasoning' | 'tools' | 'brief' | 'raw'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'live', label: 'Live output' }, { id: 'reasoning', label: 'Reasoning' }, { id: 'tools', label: 'Tool calls' },
  { id: 'brief', label: 'Brief & inputs' }, { id: 'raw', label: 'Raw' },
]

interface Props {
  view: RunView
  agentId: string
  task: string
  config: MultiAgentConfig
  /** This agent's pending requests, oldest first (same list the rows use). */
  queue: McpToolPermissionRequest[]
  readOnly: boolean
  onRespond: (r: McpToolPermissionResponse) => void
  onNavigate: (agentId: string) => void
  onClose: () => void
}

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>

/** "allowed", "denied", "failed", "waiting" (on you), "running". */
export function toolState(item: ToolItem, waitingOnYou: boolean): string {
  if (!item.done) return waitingOnYou ? 'waiting' : 'running'
  if (item.done.ok) return 'allowed'
  return /denied|blocked|not approved|timed out/i.test(item.done.resultPreview) ? 'denied' : 'failed'
}
/**
 * States for the agent's tool calls in order. With approvals pending, the first unfinished call is
 * "waiting" (the head of the agent's queue) and later unfinished ones are "queued" behind it.
 */
export function toolStates(tools: ToolItem[], pending: number): string[] {
  let unfinished = 0
  return tools.map((t) => {
    if (t.done || pending === 0) return toolState(t, false)
    return unfinished++ === 0 ? 'waiting' : 'queued'
  })
}
const STATE_DOT: Record<string, string> = { allowed: 'ok', denied: 'fail', failed: 'fail', waiting: 'wait', running: 'run', queued: 'idle' }

/** Hostnames cited by the agent's tool calls, first seen first. */
export function sourcesOf(agent: AgentView): string[] {
  const hosts = new Set<string>()
  for (const t of agent.timeline) {
    if (t.kind !== 'tool') continue
    for (const m of `${t.argsPreview} ${t.done?.resultPreview ?? ''}`.matchAll(/https?:\/\/([^/\s"'<>)]+)/g)) hosts.add(m[1].replace(/^www\./, ''))
  }
  return [...hosts]
}

/** Where the agent sits: what feeds it, what it feeds, and which of those wait on it. */
export function placeInGraph(view: RunView, agentId: string): { upstream: string[]; downstream: string[]; blocked: string[] } {
  const step = view.steps.find((s) => s.id === agentId)
  const downstream = view.steps.filter((s) => s.dependsOn?.includes(agentId)).map((s) => s.id)
  const passed = view.agents[agentId]?.status === 'done'
  return {
    upstream: step?.dependsOn?.length ? step.dependsOn : ['orchestrator'],
    downstream,
    blocked: passed ? [] : downstream.filter((id) => view.agents[id]?.status === 'queued'),
  }
}

export function AgentFocusView({ view, agentId, task, config, queue, readOnly, onRespond, onNavigate, onClose }: Props) {
  const agent = view.agents[agentId]
  const [tab, setTab] = useState<Tab>('live')
  const layer = useRef<HTMLDivElement>(null)
  const order = view.steps.map((s) => s.id)
  const index = order.indexOf(agentId)
  const prev = index > 0 ? order[index - 1] : null
  const next = index >= 0 && index < order.length - 1 ? order[index + 1] : null
  const now = useTick(!!agent && isWorking(agent.status))

  // Focus moves into the layer and returns to whatever opened it.
  const openedFrom = useRef(agentId)
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    const opener = active && active !== document.body ? active : null
    layer.current?.focus()
    return () => {
      const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>(`[data-testid="agent-title-${openedFrom.current}"]`)
      target?.focus()
    }
  }, [])

  // Esc closes; J/K (or the arrows) change agent without closing. Captured so the dock's Esc does not also fire.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === 'Escape') onClose()
      else if (key === 'j' && next) onNavigate(next)
      else if (key === 'k' && prev) onNavigate(prev)
      else if (key === 'Tab') trapTab(e, layer.current)
      else return
      if (key !== 'Tab') { e.preventDefault(); e.stopPropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onNavigate, next, prev])

  if (!agent) return null
  const { step } = agent
  const head = readOnly ? null : queue[0] ?? null
  const tag = stateTag(agent, config.maxRetriesPerAgent, !!head)
  const tools = agent.timeline.filter((t): t is ToolItem => t.kind === 'tool')
  const elapsed = elapsedMs(agent, isWorking(agent.status) ? now : agent.startedAt || 0)
  const phases = Math.max(0, ...view.steps.map((s) => s.phase))

  return (
    <div className="fixed inset-0 z-[70]" data-testid="agent-focus-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={layer}
        role="dialog"
        aria-modal="true"
        aria-label={`Agent ${step.id} ${step.label}`}
        tabIndex={-1}
        data-testid="agent-focus"
        data-agent={step.id}
        className="ma-focus absolute bottom-6 left-7 right-7 top-6 flex flex-col overflow-hidden rounded-[18px] text-ma-text outline-none"
      >
        <header className="flex items-center gap-3.5 border-b-[0.5px] border-white/[0.06] px-[22px] py-4">
          <button onClick={onClose} className="h-7 flex-none rounded-lg border-[0.5px] border-white/[0.12] px-2.5 font-mono text-[12px] text-[#bdbdbd] hover:bg-white/5" aria-label="Close (Esc)">Esc</button>
          <div className="min-w-0">
            <h2 className="truncate text-[16px] font-semibold">{step.id} {step.label}</h2>
            <p className="truncate font-mono text-[11.5px] text-ma-mute">{step.role} · {shortModel(step.model) || 'active model'} · phase {step.phase} of {phases}</p>
          </div>
          <span className={cn('inline-flex h-5 flex-none items-center rounded-[6px] border-[0.5px] px-2 font-mono text-[11px]', head ? APPROVAL_TONE : TAG_TONE[tag.tone])} data-testid="focus-chip">{tag.label}</span>
          <span className="flex-1" />
          <div className="flex flex-none gap-[18px] font-mono text-[12px] text-[#bdbdbd]" data-testid="focus-stats">
            <span>{formatTokens(agent.tokenCount || agent.streamedTokens)} tok</span>
            <span>{formatUsd(agent.costUsd)}</span>
            <span>{tools.length} tool call{tools.length === 1 ? '' : 's'}</span>
            <span>{elapsed === null ? '—' : formatElapsed(elapsed)}</span>
          </div>
          <div className="flex flex-none gap-1.5">
            <button disabled={!prev} onClick={() => prev && onNavigate(prev)} aria-label="Previous agent" className="h-7 rounded-lg border-[0.5px] border-white/[0.12] px-2.5 font-mono text-[12px] text-[#bdbdbd] hover:bg-white/5 disabled:opacity-35">K ↑</button>
            <button disabled={!next} onClick={() => next && onNavigate(next)} aria-label="Next agent" className="h-7 rounded-lg border-[0.5px] border-white/[0.12] px-2.5 font-mono text-[12px] text-[#bdbdbd] hover:bg-white/5 disabled:opacity-35">J ↓</button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <section className="flex min-w-0 flex-1 flex-col" aria-label="Agent output">
            <div role="tablist" className="flex gap-[22px] border-b-[0.5px] border-white/5 px-7 pt-3 text-[13px]">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
                  className={cn('-mb-px border-b-2 pb-2.5', tab === t.id ? 'border-ma-red text-white' : 'border-transparent text-ma-mute hover:text-ma-soft')}>
                  {t.label}{t.id === 'tools' && <span className="ml-1 font-mono text-[11px]">{tools.length}</span>}
                </button>
              ))}
            </div>
            <FollowScroll key={`${agentId}-${tab}`} deps={[agent.timeline, agent.liveText, tab]}>
              {tab === 'live' && <LiveOutput agent={agent} pending={head ? queue.length : 0} />}
              {tab === 'reasoning' && <ReasoningTab agent={agent} />}
              {tab === 'tools' && <div className="flex flex-col gap-3">{tools.length ? toolStates(tools, head ? queue.length : 0).map((state, i) => <ToolCard key={tools[i].callId} item={tools[i]} state={state} expanded />) : <Empty text="No tool calls yet." />}</div>}
              {tab === 'brief' && <BriefTab view={view} agent={agent} task={task} />}
              {tab === 'raw' && <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] text-ma-soft" data-testid="focus-raw">{JSON.stringify(rawOf(agent), null, 2)}</pre>}
            </FollowScroll>
            {head && <PinnedApproval key={head.requestId} request={head} position={1} total={queue.length} onRespond={onRespond} />}
          </section>
          <RightRail view={view} agent={agent} queue={readOnly ? [] : queue} config={config} />
        </div>
      </div>
    </div>
  )
}

function trapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return
  const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === root)) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus() }
}

function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** Scroll container that follows new content until the user scrolls up, and again once they return to the end. */
function FollowScroll({ deps, children }: { deps: unknown[]; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      ref={ref}
      data-testid="focus-scroll"
      onScroll={(e) => {
        const el = e.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
      className="min-h-0 flex-1 overflow-y-auto px-7 py-5"
    >
      {children}
    </div>
  )
}

const Empty = ({ text }: { text: string }) => <p className="text-[13px] text-ma-mute">{text}</p>
const Label = ({ children }: { children: React.ReactNode }) => <div className="mb-2 font-mono text-[11px] text-ma-mute">{children}</div>

function LiveOutput({ agent, pending }: { agent: AgentView; pending: number }) {
  // The current attempt: its tool calls, then the draft (streaming text, or the accepted answer).
  const last = Math.max(0, ...agent.timeline.map((t) => t.attempt))
  const current = agent.timeline.filter((t) => t.attempt === last)
  const currentTools = current.filter((t): t is ToolItem => t.kind === 'tool')
  const states = toolStates(currentTools, pending)
  const streaming = agent.status === 'running'
  const draft = streaming ? agent.liveText : agent.output ?? current.filter((t) => t.kind === 'output').map((t) => (t as { text: string }).text).at(-1) ?? ''
  return (
    <div className="flex flex-col gap-3.5" data-testid="focus-live">
      <div className="rounded-[10px] border-[0.5px] border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
        <div className="font-mono text-[11px] text-ma-mute">BRIEF</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#bdbdbd]">{agent.step.label}</p>
      </div>
      {currentTools.map((t, i) => <ToolCard key={t.callId} item={t} state={states[i]} />)}
      {draft ? (
        <div className="text-[14px] leading-[1.7] text-[#d8d8d8]" data-testid="focus-draft">
          <ClaimLinkedMarkdown text={draft} own={agent.step.id} isStreaming={streaming} />
          {streaming && <span className="ma-cursor" data-testid="focus-caret" />}
        </div>
      ) : (
        <Empty text={agent.status === 'queued' ? 'Not started yet.' : streaming ? 'Waiting for the first tokens…' : 'No answer yet.'} />
      )}
      {agent.failure && <p className="text-[13px] text-[#ff8c88]">{agent.failure}</p>}
    </div>
  )
}

function ToolCard({ item, state, expanded = false }: { item: ToolItem; state: string; expanded?: boolean }) {
  const tone = state === 'allowed' ? 'text-[#4ade80]' : state === 'waiting' ? 'text-[#e6b422]' : state === 'queued' ? 'text-ma-mute' : state === 'running' ? 'text-ma-redtext' : 'text-[#ff8c88]'
  return (
    <div className="overflow-hidden rounded-[10px] border-[0.5px] border-white/[0.07]" data-testid={`focus-tool-${item.callId}`}>
      <div className="flex items-center gap-2.5 bg-white/[0.03] px-3.5 py-2">
        <span className={cn('flex-none font-mono text-[12px]', tone)}>{item.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ma-mute" title={item.argsPreview}>{item.argsPreview}</span>
        <span className={cn('flex-none font-mono text-[11px]', tone)}>{state}</span>
      </div>
      {item.done && (
        <div className={cn('px-3.5 py-2.5 font-mono text-[11.5px] leading-relaxed text-[#9a9a9a]', expanded ? 'whitespace-pre-wrap break-words' : 'truncate')}>
          {expanded ? item.done.resultPreview : `${item.done.resultChars.toLocaleString()} chars · ${(item.done.durationMs / 1000).toFixed(1)}s · ${item.done.resultPreview.split('\n')[0]}`}
        </div>
      )}
    </div>
  )
}

function ReasoningTab({ agent }: { agent: AgentView }) {
  const items = agent.timeline.filter((t): t is Extract<TimelineItem, { kind: 'reasoning' }> => t.kind === 'reasoning')
  if (!items.length) return <Empty text="No reasoning streamed for this agent." />
  return (
    <div className="flex flex-col gap-4">
      {items.map((r, i) => (
        <div key={i}>
          <Label>attempt {r.attempt + 1} · {Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s</Label>
          <p className="whitespace-pre-wrap text-[13.5px] italic leading-relaxed text-[#a9a9a9]">{r.text}</p>
        </div>
      ))}
    </div>
  )
}

function BriefTab({ view, agent, task }: { view: RunView; agent: AgentView; task: string }) {
  const deps = agent.step.dependsOn ?? []
  return (
    <div className="flex flex-col gap-5 text-[13px] text-ma-soft" data-testid="focus-brief">
      <div><Label>SUBTASK</Label><p>{agent.step.label}</p></div>
      <div><Label>RUN TASK</Label><p className="whitespace-pre-wrap">{task || '—'}</p></div>
      <div><Label>ROLE AND MODEL</Label><p className="font-mono text-[12px]">{agent.step.role} · {agent.step.model || 'active model'}</p></div>
      <div>
        <Label>INPUTS</Label>
        {deps.length === 0 ? <p className="text-ma-mute">None — starts from the plan.</p> : deps.map((d) => {
          const dep = view.agents[d]
          return (
            <div key={d} className="mb-3">
              <p className="font-mono text-[12px] text-ma-mute">{d} {dep?.step.label} · {dep?.status ?? 'unknown'}</p>
              <p className="mt-1 line-clamp-6 whitespace-pre-wrap">{dep?.output || 'No output yet.'}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function rawOf(agent: AgentView): unknown {
  const { liveText: _live, ...rest } = agent
  return rest
}

function PinnedApproval({ request, position, total, onRespond }: { request: McpToolPermissionRequest; position: number; total: number; onRespond: (r: McpToolPermissionResponse) => void }) {
  const [sent, setSent] = useState(false)
  const code = typeof request.args.code === 'string' ? request.args.code : null
  const role = request.agent?.role ?? 'this agent'
  const respond = (approved: boolean, agentTrust?: 'trust'): void => {
    if (sent) return
    setSent(true)
    onRespond({ requestId: request.requestId, approved, alwaysAllow: false, userNote: '', ...(agentTrust && { agentTrust }) })
  }
  const btn = 'h-7 rounded-[7px] px-3 text-[12px] disabled:opacity-50'
  return (
    <div className="mx-7 mb-5 flex-none rounded-xl border-[0.5px] border-l-2 border-[#e6b422]/45 border-l-[#e6b422] bg-[#e6b422]/[0.08] px-4 py-3.5" data-testid="focus-approval">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[12px] text-[#e6b422]">{bareTool(request.toolName)}</span>
        <span className="text-[12.5px] text-[#d8d8d8]">{code ? 'wants to run code' : `wants to call ${request.serverName}`}</span>
        <span className="flex-1" />
        <span className="rounded-full bg-[#e6b422]/[0.12] px-2 py-0.5 font-mono text-[11px] text-[#e6b422]" data-testid="focus-queue-pos">{position} of {total} in this agent&apos;s queue</span>
      </div>
      <pre className="mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/35 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-[#bdbdbd]">
        {code ?? argsSummary(request.args)}
      </pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <button disabled={sent} onClick={() => respond(true)} className={cn(btn, 'bg-[#e6b422] font-medium text-[#0a0a0a] hover:bg-[#f0c33a]')}>Allow once</button>
        <button disabled={sent} onClick={() => respond(true, 'trust')} className={cn(btn, 'border-[0.5px] border-[#e6b422]/50 text-[#e6b422] hover:bg-[#e6b422]/10')}>Trust {role} for this run</button>
        <button disabled={sent} onClick={() => respond(false)} className={cn(btn, 'border-[0.5px] border-white/[0.12] text-ma-mute hover:bg-white/5 hover:text-ma-text')}>Deny</button>
      </div>
    </div>
  )
}

function RightRail({ view, agent, queue, config }: { view: RunView; agent: AgentView; queue: McpToolPermissionRequest[]; config: MultiAgentConfig }) {
  const tools = agent.timeline.filter((t): t is ToolItem => t.kind === 'tool')
  const place = useMemo(() => placeInGraph(view, agent.step.id), [view, agent.step.id])
  const gate = agent.reflections.at(-1)
  const judge = view.runConfig?.models.reflection ?? config.models.reflection
  const claims = Object.entries(agent.degraded?.claimStatuses ?? gate?.claimStatuses ?? {})
  const sources = useMemo(() => sourcesOf(agent), [agent])
  const cap = view.runConfig?.budgetCapUsd ?? config.budgetCapUsd
  const share = cap > 0 ? Math.min(1, agent.costUsd / cap) : 0
  const section = 'border-t-[0.5px] border-white/[0.06] pt-4'
  return (
    <aside className="flex w-[360px] flex-none flex-col gap-5 overflow-y-auto border-l-[0.5px] border-white/[0.06] px-[22px] py-5" aria-label="Agent details" data-testid="focus-rail">
      <div>
        <Label>TOOL TIMELINE</Label>
        {tools.length === 0 && queue.length === 0 && <Empty text="No tool calls yet." />}
        {toolStates(tools, queue.length).map((state, i) => <RailRow key={tools[i].callId} name={tools[i].tool} state={state} />)}
        {/* Requests with no tool_start of their own yet (older traces). */}
        {queue.slice(Math.max(1, tools.filter((t) => !t.done).length)).map((r) => <RailRow key={r.requestId} name={bareTool(r.toolName)} state="queued" />)}
      </div>
      <div className={section} data-testid="focus-place">
        <Label>PLACE IN THE GRAPH</Label>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[12px]">
          <span className="text-ma-mute">{place.upstream.join(' · ')}</span><span className="text-ma-dim">→</span>
          <span className="rounded-[6px] border-[0.5px] border-[#e6b422]/50 px-1.5 text-[#e6b422]">{agent.step.id}</span><span className="text-ma-dim">→</span>
          <span className="text-[#bdbdbd]">{place.downstream.length ? place.downstream.join(' · ') : 'final synthesis'}</span>
        </div>
        <p className="mt-2 text-[12px] leading-normal text-ma-mute">
          {place.blocked.length ? `${place.blocked.join(', ')} ${place.blocked.length === 1 ? 'is' : 'are'} blocked until this agent passes review.` : 'Nothing is waiting on this agent.'}
        </p>
      </div>
      <div className={section} data-testid="focus-reflection">
        <Label>REFLECTION · {shortModel(judge)}</Label>
        {gate ? (
          <>
            <p className={cn('text-[12.5px]', gate.passed ? 'text-[#7fdcb0]' : 'text-[#ff8c88]')}>{gate.score}/5 — {gate.reason}</p>
            {gate.claimsFailed !== undefined && <p className="mt-1 font-mono text-[11.5px] text-ma-mute">{gate.claimsFailed} of {gate.claimsChecked ?? '?'} claims failed</p>}
            {gate.issues?.length ? <ul className="mt-1 list-disc pl-4 text-[12px] text-ma-soft">{gate.issues.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
          </>
        ) : (
          <>
            <p className="text-[12.5px] leading-normal text-[#9a9a9a]">Runs when the agent finishes. Criteria score out of 5 and any failed citations show here.</p>
            <span className="mt-2 inline-block rounded-[6px] border-[0.5px] border-white/10 px-2 font-mono text-[11px] text-ma-mute">pending</span>
          </>
        )}
      </div>
      <div className={section} data-testid="focus-sources">
        <Label>SOURCES · {sources.length}</Label>
        {sources.length === 0 && claims.length === 0 && <Empty text="None cited yet." />}
        {sources.slice(0, 8).map((h) => <p key={h} className="truncate font-mono text-[11.5px] leading-[1.9] text-[#bdbdbd]">{h}</p>)}
        {claims.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {claims.map(([id, status]) => (
              <span key={id} className={cn('rounded-[5px] border-[0.5px] px-1.5 font-mono text-[11px]',
                status.startsWith('verified') ? 'border-ma-ok/30 text-ma-ok' : /fail|not_found|too_|elsewhere/.test(status) ? 'border-ma-red/35 text-[#ff8c88]' : 'border-white/10 text-ma-mute')}>
                {id} · {status}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={section} data-testid="focus-budget">
        <Label>BUDGET</Label>
        <div className="h-1.5 rounded-[3px] bg-white/[0.07]"><div className="h-1.5 rounded-[3px] bg-ma-red" style={{ width: `${share * 100}%` }} /></div>
        <p className="mt-1.5 font-mono text-[11px] text-ma-mute">{formatUsd(agent.costUsd)} of the {formatUsd(cap)} run budget · {formatTokens(agent.tokenCount || agent.streamedTokens)} tok</p>
      </div>
    </aside>
  )
}

function RailRow({ name, state }: { name: string; state: string }) {
  return (
    <div className="flex items-center gap-2.5 py-[5px]" data-testid="focus-timeline-row">
      <span className="ma-dot !h-[7px] !w-[7px]" data-s={STATE_DOT[state] ?? 'idle'} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ma-soft">{name}</span>
      <span className="font-mono text-[11px] text-ma-dim">{state}</span>
    </div>
  )
}
