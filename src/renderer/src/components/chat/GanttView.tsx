// Spec B 7c (design 13): where the time went. Full view (the Gantt tab beside List | Graph) and a compact strip (the
// List view's timeline and the dock's Run log). CSS only, no animation.
import { useMemo, useState } from 'react'
import { buildSegments, criticalPath, ganttFooter, segmentDetails, SEGMENT_LABEL } from '../../lib/gantt'
import type { Gantt, Lane, Segment, SegmentKind } from '../../lib/gantt'
import type { RunView } from '../../lib/multiAgentRunState'
import { cn } from '../../lib/utils'
import { Chip } from './ClaimsDrawer'

export const SEGMENT_CLASS: Record<SegmentKind, string> = {
  model: 'bg-[#3b82f6]',
  tool: 'bg-[#4ade80] opacity-80',
  wait: 'bg-[repeating-linear-gradient(45deg,#fbbf24_0_4px,#7a5c0f_4px_8px)]',
  judge: 'bg-[#a78bfa]',
  repair: 'bg-[#ff6b66]',
}
const LABEL = 'font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8a8a8a]'
const secs = (ms: number): string => `${Math.round(ms / 1000)} s`

/** The run log file a lane's calls are rendered in (MultiAgentRunLogger.recordFile). */
export function recordFileOf(laneId: string): string {
  if (laneId === 'plan' || laneId === 'approve') return 'planner.md'
  if (laneId === 'synth') return 'synthesis.md'
  if (laneId === 'assess') return 'run.md'
  return `agent-${laneId.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_') || '_'}.md`
}

function peakAgents(gantt: Gantt): number {
  const spans = gantt.lanes.filter((l) => /^\d/.test(l.id)).map((l) => [l.segments[0].start, l.segments.at(-1)!.end ?? gantt.end] as const)
  return Math.max(0, ...spans.map(([s]) => spans.filter(([a, b]) => a <= s && s < b).length))
}

function Track({ lane, gantt, onPick, picked, compact }: { lane: Lane; gantt: Gantt; onPick?: (seg: Segment) => void; picked?: Segment | null; compact?: boolean }) {
  const span = Math.max(gantt.end - gantt.t0, 1)
  const pct = (t: number): number => Math.min(100, Math.max(0, ((t - gantt.t0) / span) * 100))
  return (
    <>
      {lane.segments.map((s, i) => {
        const left = pct(s.start)
        const width = Math.max(pct(s.end ?? gantt.end) - left, compact ? 0.4 : 0.25)
        return (
          <button key={i} type="button" tabIndex={onPick ? 0 : -1} data-testid={`seg-${lane.id}-${i}`} data-kind={s.kind} data-open={s.end === null}
            aria-label={`${lane.label} · ${SEGMENT_LABEL[s.kind]} · ${secs((s.end ?? gantt.end) - s.start)}`}
            onClick={() => onPick?.(s)} onMouseEnter={() => onPick?.(s)}
            className={cn('absolute rounded-[3px]', compact ? 'top-[3px] h-[10px]' : 'top-[11px] h-[18px]', SEGMENT_CLASS[s.kind], picked === s && 'ring-1 ring-white/70')}
            style={{ left: `${left}%`, width: `${width}%` }} />
        )
      })}
    </>
  )
}

/** Compact lanes for the List view's timeline and the dock's Run log: same segments, no axis or popover. */
export function GanttStrip({ view, now, laneIds }: { view: RunView; now?: number; laneIds?: string[] }) {
  const gantt = useMemo(() => buildSegments(view, now), [view, now])
  const lanes = gantt.lanes.filter((l) => !laneIds || laneIds.includes(l.id))
  return (
    <div className="relative" data-testid="gantt-strip">
      {lanes.map((lane) => (
        <div key={lane.id} className="relative my-[3px] h-4" data-testid={`gantt-strip-${lane.id}`}>
          <Track lane={lane} gantt={gantt} compact />
        </div>
      ))}
    </div>
  )
}

export function GanttView({ view, now, chatId }: { view: RunView; now?: number; chatId?: string | null }) {
  const gantt = useMemo(() => buildSegments(view, now), [view, now])
  const path = useMemo(() => new Set(criticalPath(view)), [view])
  const footer = useMemo(() => ganttFooter(view, gantt), [view, gantt])
  const [picked, setPicked] = useState<{ lane: Lane; seg: Segment } | null>(null)
  const span = Math.max(gantt.end - gantt.t0, 1)
  const ticks = Array.from({ length: 11 }, (_, i) => Math.round((span * i) / 10 / 1000))
  const onPath = (lane: Lane): boolean => path.has(lane.id)
  return (
    <section className="relative flex h-full min-h-0 flex-col rounded-xl border-[0.5px] border-white/[0.08] bg-[#0a0a0a] px-[22px] py-5" data-testid="gantt-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className={LABEL}>Timeline · {Math.round(span / 1000)} s · {peakAgents(gantt)} agents peak</div>
          <div className="mt-1 text-[18px] font-semibold">Where the time went</div>
        </div>
        <div className="flex flex-wrap gap-4" data-testid="gantt-legend">
          {(Object.keys(SEGMENT_LABEL) as SegmentKind[]).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-[11.5px] text-[#a8a8a8]"><i className={cn('inline-block h-2.5 w-3 rounded-[2px]', SEGMENT_CLASS[k])} />{SEGMENT_LABEL[k]}</span>
          ))}
        </div>
      </div>
      <div className="relative mt-6 min-h-0 flex-1 overflow-auto">
        <div className="relative ml-[160px] mr-2.5 flex h-3.5 justify-between font-mono text-[10px] text-[#6a6a6a]" data-testid="gantt-axis">
          {ticks.map((t, i) => <span key={i}>{t}{i === 0 || i === ticks.length - 1 ? 's' : ''}</span>)}
        </div>
        {gantt.lanes.map((lane) => (
          <div key={lane.id} className="relative h-10 border-b-[0.5px] border-white/[0.05]" data-testid={`gantt-lane-${lane.id}`}>
            <div className="absolute left-0 top-0 flex h-10 w-[150px] items-center gap-1.5 truncate font-mono text-[12px]" title={lane.label}>
              <span className={cn('inline-block h-[7px] w-[7px] flex-none rounded-full', lane.segments.some((s) => s.end === null) ? 'bg-[#fbbf24]' : 'bg-[#4ade80]')} />
              <span className="truncate">{lane.label}</span>
            </div>
            <div className="absolute bottom-0 left-[160px] right-2.5 top-0">
              <Track lane={lane} gantt={gantt} picked={picked?.seg} onPick={(seg) => setPicked({ lane, seg })} />
            </div>
          </div>
        ))}
      </div>
      {picked && (
        <div className="absolute bottom-[70px] left-[180px] z-10 w-[360px] rounded-xl border-[0.5px] border-white/[0.08] bg-[#101010] p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)]" data-testid="gantt-popover">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[12px]">{picked.lane.id === 'synth' ? 'synthesize' : picked.lane.id} · {SEGMENT_LABEL[picked.seg.kind]}</span>
            <Chip tone={picked.seg.kind === 'wait' ? 'warn' : picked.seg.kind === 'repair' ? 'bad' : 'neutral'}>{(((picked.seg.end ?? gantt.end) - picked.seg.start) / 1000).toFixed(1)} s</Chip>
          </div>
          <div className="mt-2 text-[12px] leading-[1.7] text-[#8a8a8a]">
            {segmentDetails(picked.lane, picked.seg, onPath(picked.lane), gantt.end).map((line) => <div key={line}>{line}</div>)}
          </div>
          <div className="mt-2.5 flex gap-2">
            <button disabled={!chatId} onClick={() => chatId && void window.api.obsOpenMultiAgentRunFile?.(chatId, view.runId, recordFileOf(picked.lane.id))}
              className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] font-medium disabled:opacity-50">Open call record</button>
            <button onClick={() => setPicked(null)} className="rounded-lg border-[0.5px] border-white/[0.16] bg-[#141414] px-3 py-[7px] text-[12px] text-[#8a8a8a]">Close</button>
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t-[0.5px] border-white/[0.08] pt-3.5" data-testid="gantt-footer">
        <div className="flex flex-wrap gap-[22px] text-[12px]">
          <span><span className="text-[#8a8a8a]">Critical path</span> <b>{footer.criticalPath || '—'}</b></span>
          <span><span className="text-[#8a8a8a]">Retry time</span> <b className="text-[#ff6b66]">{secs(footer.retryMs)}</b></span>
          <span><span className="text-[#8a8a8a]">Approval wait</span> <b className="text-[#fbbf24]">{secs(footer.approvalWaitMs)}</b></span>
          <span><span className="text-[#8a8a8a]">Judge</span> <b className="text-[#a78bfa]">{secs(footer.judgeMs)}</b></span>
        </div>
        <Chip>click any segment to open its call record</Chip>
      </div>
    </section>
  )
}
