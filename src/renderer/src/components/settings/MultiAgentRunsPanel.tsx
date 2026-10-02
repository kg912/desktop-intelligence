/**
 * Settings → Debug → Multi-agent runs (specs/multi-agent-observability.md §5, designs/04-observability.html).
 * Read-only views of the per-run log tree; files open in the OS.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, FileText, FolderOpen, Trash2 } from 'lucide-react'
import type { RunDetail, RunListRow, TimelineCall } from '../../../../main/services/MultiAgentRunLogger'
import type { MultiAgentTraceLogEntry } from '../../../../main/services/ObservabilityService'

const MONO = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" }
export const EVENTS_PAGE = 25

const STATUS_CLASS: Record<RunListRow['status'], string> = {
  completed: 'text-ma-ok border-ma-ok/30 bg-ma-ok/10',
  failed: 'text-ma-redtext border-ma-red/35 bg-ma-red/[0.08]',
  incomplete: 'text-ma-amber border-ma-amber/30 bg-ma-amber/10',
  running: 'text-ma-redtext border-ma-red/35 bg-ma-red/[0.08]',
  not_recorded: 'text-ma-dim border-white/[0.09]',
}

const ROLE_BAR: Record<TimelineCall['role'], string> = {
  planner: 'bg-ma-mute/45',
  worker: 'bg-ma-red/55',
  reflection: 'bg-ma-amber/55',
  synthesis: 'bg-ma-ok/55',
}

const shortModel = (id: string): string => id.split('/').pop() ?? id
const fmtUsd = (n: number | null): string => (n == null ? '—' : `$${n.toFixed(4)}`)
const fmtSecs = (ms: number | null): string => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`)
const fmtWhen = (ms: number): string => new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export function MultiAgentRunsPanel({ enabled, onEnable }: { enabled: boolean; onEnable: () => void }) {
  const [rows, setRows] = useState<RunListRow[]>([])
  const [selected, setSelected] = useState<RunListRow | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [page, setPage] = useState<{ offset: number; total: number; entries: MultiAgentTraceLogEntry[] }>({ offset: 0, total: 0, entries: [] })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setRows((await window.api.obsListMultiAgentRuns?.()) ?? [])
  }, [])
  useEffect(() => { refresh().catch(console.error) }, [refresh, enabled])

  const loadEvents = useCallback(async (row: RunListRow, offset: number) => {
    const res = await window.api.obsListMultiAgentRunEvents(row.chatId, row.runId, offset, EVENTS_PAGE)
    setPage({ offset, total: res?.total ?? 0, entries: res?.entries ?? [] })
  }, [])

  const select = useCallback(async (row: RunListRow) => {
    if (row.status === 'not_recorded') return
    if (selected?.runId === row.runId) { setSelected(null); setDetail(null); return }
    setSelected(row)
    setDetail(await window.api.obsGetMultiAgentRun(row.chatId, row.runId))
    await loadEvents(row, 0)
  }, [selected, loadEvents])

  const remove = async (row: RunListRow) => {
    if (confirmDelete !== row.runId) { setConfirmDelete(row.runId); return }
    setConfirmDelete(null)
    if (await window.api.obsDeleteMultiAgentRun(row.chatId, row.runId)) {
      if (selected?.runId === row.runId) { setSelected(null); setDetail(null) }
      await refresh()
    }
  }

  const copy = async (runId: string) => {
    await navigator.clipboard?.writeText(runId).catch(() => {})
    setCopied(runId)
    setTimeout(() => setCopied(null), 1200)
  }

  const recorded = rows.filter((r) => r.status !== 'not_recorded').length
  return (
    <section data-testid="ma-runs">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-content-muted">Multi-agent runs</p>
        <span className="text-xs text-ma-dim">
          {enabled ? `${recorded} recorded${rows.length > recorded ? ` · ${rows.length - recorded} not recorded` : ''}` : 'Recording is off'}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border-[0.5px] border-white/[0.09] bg-ma-bg">
        {!enabled && (
          <div className="px-5 py-6 text-center" data-testid="ma-runs-off">
            <p className="text-[13.5px] text-ma-soft">Observability is off, so multi-agent runs are not being recorded.</p>
            <p className="mx-auto mb-3.5 mt-1.5 max-w-[520px] text-[12.5px] text-ma-dim">
              Turn it on to record the next run's prompts, raw outputs, tool calls, timing and cost. Runs that already happened while it was off cannot be recovered.
            </p>
            <button onClick={onEnable} className="h-[30px] rounded-[7px] border-[0.5px] border-ma-red/35 bg-ma-red/[0.08] px-3.5 text-[12.5px] text-ma-redtext hover:bg-ma-red/[0.14]">
              Turn on observability
            </button>
          </div>
        )}
        {enabled && rows.length === 0 && <p className="px-4 py-6 text-center text-xs text-ma-dim">No multi-agent runs yet.</p>}
        {rows.map((row) => {
          const isSel = selected?.runId === row.runId
          const notRecorded = row.status === 'not_recorded'
          return (
            <div key={row.runId} className="border-b-[0.5px] border-white/[0.05] last:border-b-0">
              <div
                role={notRecorded ? undefined : 'button'}
                tabIndex={notRecorded ? -1 : 0}
                aria-expanded={notRecorded ? undefined : isSel}
                onClick={() => void select(row)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void select(row) } }}
                title={notRecorded ? 'Observability was off when this run started' : undefined}
                className={`group grid items-center gap-3 px-4 py-[11px] text-[12.5px] ${notRecorded ? 'cursor-default opacity-55' : 'cursor-pointer hover:bg-ma-bg2'} ${isSel ? 'bg-ma-bg2 shadow-[inset_2px_0_0_#e53935]' : ''}`}
                style={{ gridTemplateColumns: 'minmax(0,1fr) auto 58px 44px 34px 112px' }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-ma-soft" title={row.chatTitle}>{row.chatTitle || '(untitled chat)'}</span>
                  <span className="block truncate text-[11px] text-ma-dim" style={MONO} title={Object.entries(row.models).map(([r, m]) => `${r}: ${m}`).join('\n')}>
                    {fmtWhen(row.startedAt)} · {notRecorded ? 'observability was off when this run started' : [...new Set(Object.values(row.models))].map(shortModel).join(' · ')}
                  </span>
                </span>
                <span className={`inline-flex h-5 items-center justify-self-start whitespace-nowrap rounded-[5px] border-[0.5px] px-[7px] text-[11px] ${STATUS_CLASS[row.status]}`} style={MONO}>
                  {row.status === 'not_recorded' ? 'not recorded' : row.status}
                </span>
                <span className="text-right text-[12px] text-ma-soft" style={MONO}>{notRecorded ? '' : fmtUsd(row.costUsd)}</span>
                <span className="text-right text-[12px] text-ma-soft" style={MONO}>{notRecorded ? '' : fmtSecs(row.durationMs)}</span>
                <span className={`text-right text-[11px] ${row.anomalyCount ? 'text-ma-amber' : 'text-ma-dim'}`} style={MONO} title="Anomalies">
                  {row.anomalyCount == null ? '' : row.anomalyCount ? `${row.anomalyCount} ⚠` : '0'}
                </span>
                {notRecorded ? <span /> : (
                  <span className={`flex justify-end gap-0.5 transition-opacity ${isSel || confirmDelete === row.runId ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                    <IconButton label="Open run.md" onClick={() => void window.api.obsOpenMultiAgentRunFile(row.chatId, row.runId)}><FileText className="h-3.5 w-3.5" /></IconButton>
                    <IconButton label="Reveal folder" onClick={() => void window.api.obsRevealMultiAgentRun(row.chatId, row.runId)}><FolderOpen className="h-3.5 w-3.5" /></IconButton>
                    <IconButton label={copied === row.runId ? 'Copied' : 'Copy run id'} onClick={() => void copy(row.runId)}><Copy className="h-3.5 w-3.5" /></IconButton>
                    <IconButton label={confirmDelete === row.runId ? 'Click again to delete' : 'Delete'} danger active={confirmDelete === row.runId} disabled={row.status === 'running'} onClick={() => void remove(row)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                  </span>
                )}
              </div>
              {isSel && detail && <RunDetailView row={row} detail={detail} />}
              {isSel && !detail && <p className="border-t-[0.5px] border-white/[0.05] bg-ma-bg1 px-4 py-4 text-xs text-ma-dim">This run's log could not be read.</p>}
            </div>
          )
        })}
      </div>

      {selected && (
        <div className="mt-8" data-testid="ma-raw-events">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-content-muted">Raw UI events · selected run</p>
            <span className="text-xs text-ma-dim">newest first</span>
          </div>
          <div className="overflow-hidden rounded-xl border-[0.5px] border-white/[0.09] bg-ma-bg">
            {page.entries.length === 0 && <p className="px-4 py-5 text-center text-xs text-ma-dim">No events recorded for this run.</p>}
            {page.entries.map((entry, i) => (
              <div key={`${entry.event.seq}-${i}`} className="grid gap-3 border-b-[0.5px] border-white/[0.05] px-4 py-[7px] text-[11.5px] text-ma-mute" style={{ ...MONO, gridTemplateColumns: '60px 110px 160px minmax(0,1fr)' }}>
                <span>#{entry.event.seq}</span>
                <span className="truncate">{entry.stepType}{entry.agentId && entry.agentId !== 'orchestrator' ? ` ${entry.agentId}` : ''}</span>
                <span className="truncate text-ma-redtext">{entry.event.type}</span>
                <span className="truncate font-sans text-[12px] text-[#a8a8a8]">{describeMultiAgentEntry(entry)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-2.5 text-xs text-ma-dim">
              <span>{page.total ? `Events ${page.offset + 1}–${Math.min(page.total, page.offset + EVENTS_PAGE)} of ${page.total}` : ''}</span>
              <span className="flex gap-1.5">
                <PageButton disabled={page.offset === 0} onClick={() => void loadEvents(selected, Math.max(0, page.offset - EVENTS_PAGE))}>Newer</PageButton>
                <PageButton disabled={page.offset + EVENTS_PAGE >= page.total} onClick={() => void loadEvents(selected, page.offset + EVENTS_PAGE)}>Older</PageButton>
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function IconButton(props: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => { e.stopPropagation(); props.onClick() }}
      className={`grid h-[26px] w-[26px] place-items-center rounded-md text-ma-mute hover:bg-ma-bg3 hover:text-ma-text disabled:cursor-not-allowed disabled:opacity-35 ${props.danger ? 'hover:!text-ma-redtext' : ''} ${props.active ? '!text-ma-redtext bg-ma-red/[0.08]' : ''}`}
    >
      {props.children}
    </button>
  )
}

function PageButton(props: { disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" disabled={props.disabled} onClick={props.onClick} className="h-[26px] rounded-md border-[0.5px] border-white/[0.09] px-2.5 text-xs text-ma-mute hover:text-ma-text disabled:cursor-default disabled:opacity-35">
      {props.children}
    </button>
  )
}

/** Plan columns by dependency depth (the same rule the sidecar uses for phases). */
export function planColumns(plan: RunDetail['plan']): RunDetail['plan'][] {
  const depth = new Map<string, number>()
  const byId = new Map(plan.map((s) => [s.id, s]))
  const depthOf = (id: string, trail: string[] = []): number => {
    if (depth.has(id)) return depth.get(id)!
    const s = byId.get(id)
    const d = 1 + Math.max(0, ...(s?.dependsOn ?? []).filter((x) => byId.has(x) && !trail.includes(x)).map((x) => depthOf(x, [...trail, id])))
    depth.set(id, d)
    return d
  }
  const cols: RunDetail['plan'][] = []
  for (const s of plan) (cols[depthOf(s.id) - 1] ??= []).push(s)
  return cols.filter(Boolean)
}

function RunDetailView({ row, detail }: { row: RunListRow; detail: RunDetail }) {
  const flaggedAgents = useMemo(() => new Set(detail.calls.filter((c) => c.anomalous).map((c) => c.agentId)), [detail])
  const lanes = useMemo(() => {
    const map = new Map<string, TimelineCall[]>()
    for (const c of [...detail.calls].sort((a, b) => a.start - b.start)) {
      const key = `${c.agentId ?? ''} ${c.role === 'worker' ? 'worker' : c.role}`.trim()
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return [...map]
  }, [detail])
  const span = Math.max(1, ...detail.calls.map((c) => c.start + c.ms))
  const modelCalls = detail.calls.filter((c) => c.kind === 'model').length
  const open = (file: string) => void window.api.obsOpenMultiAgentRunFile(row.chatId, row.runId, file)
  const reconciled = !detail.anomalies.some((a) => a.kind === 'reconciliation')

  return (
    <div className="flex flex-col gap-6 border-t-[0.5px] border-white/[0.05] bg-ma-bg1 px-4 pb-5 pt-[18px]" data-testid="ma-run-detail">
      <div className="flex flex-wrap gap-x-8 gap-y-5">
      <div className="min-w-0">
        <Heading>Plan</Heading>
        <div className="flex flex-wrap items-center gap-2">
          {planColumns(detail.plan).map((col, i) => (
            <div key={i} className="flex items-center gap-2">
              {i > 0 && <span className="text-[13px] text-ma-dim">→</span>}
              <div className="flex flex-col gap-2">
                {col.map((s) => (
                  <button key={s.id} type="button" title={s.label} onClick={() => open(detail.calls.find((c) => c.agentId === s.id)?.file ?? `agent-${s.id}.md`)}
                    className={`whitespace-nowrap rounded-[7px] border-[0.5px] bg-ma-bg2 px-[9px] py-1.5 text-left text-[11.5px] hover:bg-ma-bg3 ${flaggedAgents.has(s.id) ? 'border-ma-red/35 text-ma-redtext' : 'border-white/[0.09] text-ma-soft'}`} style={MONO}>
                    {s.id} {s.role}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {detail.plan.length > 0 && <><span className="text-[13px] text-ma-dim">→</span><span className="rounded-[7px] border-[0.5px] border-dashed border-white/[0.09] px-[9px] py-1.5 text-[11.5px] text-ma-mute" style={MONO}>Synthesis</span></>}
        </div>
      </div>
      <div className="min-w-[220px] flex-1">
        <Heading>Run</Heading>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
          <dt className="text-ma-dim">Run id</dt><dd className="truncate text-[12px] text-ma-soft" style={MONO} title={row.runId}>{row.runId}</dd>
          <dt className="text-ma-dim">Peak parallel</dt><dd className="text-[12px] text-ma-soft" style={MONO}>{detail.peak} calls</dd>
          <dt className="text-ma-dim">Calls</dt><dd className="text-[12px] text-ma-soft" style={MONO}>{modelCalls} model · {detail.calls.length - modelCalls} tool</dd>
          <dt className="text-ma-dim">Totals</dt><dd className={`text-[12px] ${reconciled ? 'text-ma-soft' : 'text-ma-amber'}`} style={MONO}>{detail.meta.status === 'incomplete' ? 'run did not finish' : reconciled ? 'reconciled' : 'mismatch'}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {detail.files.map((f) => (
            <button key={f} type="button" onClick={() => open(f)} className="h-6 rounded-md border-[0.5px] border-white/[0.09] px-[9px] text-[11.5px] text-ma-mute hover:bg-ma-bg3 hover:text-ma-text" style={MONO}>{f}</button>
          ))}
        </div>
      </div>
      </div>
      <div>
        <Heading>Timeline</Heading>
        <div className="flex flex-col gap-[5px]">
          {lanes.map(([lane, calls]) => (
            <div key={lane} className="grid items-center gap-2.5 text-[11.5px] text-ma-mute" style={{ ...MONO, gridTemplateColumns: '120px minmax(0,1fr) 48px' }}>
              <span className="truncate">{lane}{calls.filter((c) => c.kind === 'model').length > 1 ? ` ×${calls.filter((c) => c.kind === 'model').length}` : ''}</span>
              <span className="relative h-3.5 rounded-[3px] bg-ma-bg2">
                {calls.map((c) => (
                  <button
                    key={c.seq}
                    type="button"
                    title={`#${c.seq} ${c.label} · ${c.ms} ms · ${c.finish}\nOpens ${c.file} (section ${c.anchor})`}
                    aria-label={`Call ${c.seq}: open ${c.file}`}
                    onClick={() => open(c.file)}
                    className={`absolute top-0.5 h-2.5 min-w-[3px] rounded-sm hover:outline hover:outline-1 hover:outline-ma-red/35 ${c.kind === 'tool' ? 'border-[0.5px] border-dashed border-ma-mute bg-transparent' : ROLE_BAR[c.role]} ${c.anomalous ? 'ring-1 ring-ma-amber' : ''}`}
                    style={{ left: `${(c.start / span) * 100}%`, width: `${(c.ms / span) * 100}%` }}
                  />
                ))}
              </span>
              <span className="text-right text-ma-dim">{fmtSecs(calls.reduce((s, c) => s + c.ms, 0))}</span>
            </div>
          ))}
          {lanes.length === 0 && <p className="text-xs text-ma-dim">No calls were recorded.</p>}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-3.5 text-[11.5px] text-ma-dim">
          {(['planner', 'worker', 'reflection', 'synthesis'] as const).map((r) => <span key={r}><i className={`mr-1.5 inline-block h-1.5 w-2.5 rounded-sm align-middle ${ROLE_BAR[r]}`} />{r}</span>)}
          <span><i className="mr-1.5 inline-block h-1.5 w-2.5 rounded-sm border-[0.5px] border-dashed border-ma-mute align-middle" />tool</span>
          <span>Click a bar to open its file.</span>
        </div>
        <Heading className="mt-5">Anomalies</Heading>
        <div className="flex flex-col gap-2.5" data-testid="ma-anomalies">
          {detail.anomalies.length === 0 && <p className="text-[12.5px] text-ma-dim">No anomalies.</p>}
          {detail.anomalies.map((a, i) => (
            <div key={i} className="text-[12.5px] text-ma-soft">
              <span className="flex items-baseline justify-between gap-3">
                <b className="text-[11px] font-medium text-ma-amber" style={MONO}>{a.kind}</b>
                {a.ref && <button type="button" onClick={() => open(a.ref!.split('#')[0])} className="truncate text-[11px] text-ma-mute hover:text-ma-text" style={MONO}>{a.ref}</button>}
              </span>
              <span className="block break-words">{a.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Heading({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <h4 className={`mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ma-dim ${className}`}>{children}</h4>
}

export function describeMultiAgentEntry(entry: MultiAgentTraceLogEntry): string {
  const e = entry.event
  switch (e.type) {
    case 'agent_start': return `${e.role} · ${e.model}`
    case 'agent_complete': return `${e.tokenCount.toLocaleString()} tok · $${e.costUsd.toFixed(4)}`
    case 'agent_failed': return e.reason
    case 'reflection_result': return `${e.score}/5 ${e.passed ? 'passed' : 'failed'} — ${e.reason}`
    case 'hitl_pause': return `${e.role} → ${e.serverName}:${e.toolName}`
    case 'task_complete': return `run total $${e.totalCostUsd.toFixed(4)} · ${e.totalTokens.toLocaleString()} tok`
    case 'task_failed': return e.reason
    default: return entry.runCostUsd !== undefined ? `run so far $${entry.runCostUsd.toFixed(4)}` : entry.chatId
  }
}
