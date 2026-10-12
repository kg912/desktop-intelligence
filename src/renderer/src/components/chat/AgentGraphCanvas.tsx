// The agent graph (UI Goals 5 and 6, designs/05-planning-state.png and 06-graph-view.png).
// One component draws the orchestrator's plan while it is written (draft and ghost nodes, dashed
// edges) and the run's final graph, so nodes keep their places when the plan lands. Layout comes
// from the dependency DAG (layoutDag). CSS transitions only; edge flow animates only on active
// edges, only while the run is live and the window is visible. Goal 7: the canvas re-fits (with a
// 180ms transform transition) when the bottom dock changes its height, and switches to compact
// cards when that gives the graph a clearly bigger scale.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import type { DagLayout, DagMetrics } from '../../lib/dagLayout'
import { COMPACT_METRICS, GRAPH_METRICS, layoutDag } from '../../lib/dagLayout'
import type { EdgeKind, GraphNode, NodeState } from '../../lib/agentGraphNodes'
import { edgeKind } from '../../lib/agentGraphNodes'
export type { GraphNode } from '../../lib/agentGraphNodes'

/** Below this, node text is unreadable; the interactive graph's automatic fit stops here (the fit button still fits all). */
export const AUTO_FIT_MIN_SCALE = 0.6

/**
 * Whole graph in view, centred. `readable`: a graph too wide for the pane is not shrunk below AUTO_FIT_MIN_SCALE
 * (it then starts at its left edge); the height always fits, so every dock state shows every row (Goal 7).
 */
export function fitView(size: { w: number; h: number }, layout: { width: number; height: number }, readable: boolean): { x: number; y: number; k: number } {
  const kw = Math.min(1, (size.w - 16) / layout.width)
  const kh = (size.h - 16) / layout.height
  const k = Math.min(readable ? Math.max(kw, AUTO_FIT_MIN_SCALE) : kw, kh)
  const x = layout.width * k <= size.w ? (size.w - layout.width * k) / 2 : 8
  return { k, x, y: Math.max(8, (size.h - layout.height * k) / 2) }
}

/** Compact cards only when they let the whole graph show at least 3% larger than regular ones (the height binds). */
export function pickDensity(size: { w: number; h: number }, regular: { width: number; height: number }, compact: { width: number; height: number }): 'regular' | 'compact' {
  if (!size.w || !size.h) return 'regular'
  return fitView(size, compact, false).k > fitView(size, regular, false).k * 1.03 ? 'compact' : 'regular'
}

/** ResizeObserver callbacks reach React at most every RESIZE_THROTTLE_MS (the dock animates its height). */
export const RESIZE_THROTTLE_MS = 90

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const dx = (x2 - x1) / 2
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`
}

/** An element's size from a ResizeObserver. The first size (and the first after being hidden) lands at once;
 *  later ones at most every RESIZE_THROTTLE_MS, so a dock animating its height costs a few renders, not one per frame. */
export function useElementSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let latest = { w: 0, h: 0 }
    let shown = false
    const flush = (): void => {
      timer = null
      shown = latest.w > 0 && latest.h > 0
      const next = latest
      setSize((s) => (s.w === next.w && s.h === next.h ? s : next))
    }
    const ro = new ResizeObserver(([entry]) => {
      latest = { w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }
      if (!shown) flush()
      else timer ??= setTimeout(flush, RESIZE_THROTTLE_MS)
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (timer) clearTimeout(timer) }
  }, [ref])
  return size
}

/** Is the window visible? Animations stop while it is not. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

interface Props {
  nodes: GraphNode[]
  /** Column captions, by column index. */
  columnLabels?: string[]
  /** Run live (or planning) and window visible: allows shimmer/flow animations. */
  animate: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
  onOpen?: (id: string) => void
  /** Pan, zoom, fit, minimap and legend (Goal 6); off for the static planning canvas. */
  interactive?: boolean
  /** Caption at the bottom-left of a static canvas. */
  caption?: string
  /** A click (not a drag) on empty canvas. */
  onEmptyClick?: () => void
  className?: string
}

/** `smooth`: an automatic re-fit, animated by a CSS transition (never a pan or zoom by the user). */
interface View { x: number; y: number; k: number; smooth?: boolean }

export function AgentGraphCanvas({ nodes, columnLabels, animate, selectedId, onSelect, onOpen, interactive = false, caption, className, onEmptyClick }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const size = useElementSize(box)
  const regular = useMemo(() => layoutDag(nodes, GRAPH_METRICS), [nodes])
  const compactLayout = useMemo(() => layoutDag(nodes, COMPACT_METRICS), [nodes])
  const density = pickDensity(size, regular, compactLayout)
  const M = density === 'compact' ? COMPACT_METRICS : GRAPH_METRICS
  const layout = density === 'compact' ? compactLayout : regular
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  // Once the user pans or zooms, the graph stops re-fitting itself (until its height changes).
  const userMoved = useRef(false)
  const fitted = useRef(false)

  const fit = useCallback((readable = false): void => {
    if (!size.w || !size.h) { fitted.current = false; return } // hidden (e.g. the List tab is showing): nothing to fit
    setView({ ...fitView(size, layout, readable), smooth: fitted.current })
    fitted.current = true
  }, [size, layout])
  // Fit on first show, on resize and as nodes arrive, until the user takes over (interactive: kept readable).
  // A new available height (the bottom dock opened, closed or was resized) always re-fits.
  const lastH = useRef(0)
  useLayoutEffect(() => {
    if (lastH.current && size.h !== lastH.current) userMoved.current = false
    lastH.current = size.h
    if (!interactive || !userMoved.current) fit(interactive)
  }, [fit, interactive, nodes.length, size.h])

  const zoomBy = (factor: number, cx = size.w / 2, cy = size.h / 2): void => {
    userMoved.current = true
    setView((v) => {
      const k = Math.min(2, Math.max(0.25, v.k * factor))
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
    })
  }
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    if (!interactive || (e.target as HTMLElement).closest('[data-graph-node], button, svg[data-testid="graph-minimap"]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d || (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4)) return
    d.moved = true
    userMoved.current = true
    setView((v) => ({ x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y, k: v.k }))
  }
  const onPointerUp = (): void => {
    if (drag.current && !drag.current.moved) onEmptyClick?.()
    drag.current = null
  }
  const onWheel = (e: React.WheelEvent): void => {
    if (!interactive) return
    const rect = box.current!.getBoundingClientRect()
    if (e.ctrlKey || e.metaKey) zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
    else {
      userMoved.current = true
      setView((v) => ({ x: v.x - e.deltaX, y: v.y - e.deltaY, k: v.k }))
    }
  }

  return (
    <div
      ref={box}
      data-testid="agent-graph-canvas"
      data-animate={animate}
      data-density={density}
      className={cn('ma-canvas relative h-full w-full select-none overflow-hidden', interactive && 'cursor-grab active:cursor-grabbing', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      <div className={cn('absolute left-0 top-0 origin-top-left', view.smooth && 'ma-refit')} data-testid="graph-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, width: layout.width, height: layout.height }}>
        {columnLabels && layout.columns.map((_, c) => columnLabels[c] && (
          <div key={c} className="absolute font-mono text-[11px] text-ma-dim" style={{ left: M.pad + c * (M.nodeW + M.colGap), top: 2 }}>{columnLabels[c]}</div>
        ))}
        <GraphEdges nodes={nodes} byId={byId} layout={layout} m={M} />
        {nodes.map((n) => {
          const p = layout.positions.get(n.id)!
          return <GraphNodeCard key={n.id} node={n} x={p.x} y={p.y} m={M} selected={selectedId === n.id} onSelect={onSelect} onOpen={onOpen} />
        })}
      </div>
      {caption && <div className="pointer-events-none absolute bottom-2.5 left-5 font-mono text-[11px] text-ma-dim" data-testid="graph-caption">{caption}</div>}
      {interactive && (
        <>
          <div className="pointer-events-none absolute bottom-4 right-4 flex gap-3.5 font-mono text-[10.5px] text-ma-mute" data-testid="graph-legend">
            <span><span className="text-[#4ade80]">●</span> running</span>
            <span><span className="text-[#e6b422]">●</span> needs you</span>
            <span><span className="text-ma-dim">●</span> waiting</span>
          </div>
          <div className="absolute bottom-4 left-4 flex items-end gap-2.5">
            <div className="flex flex-col overflow-hidden rounded-lg border-[0.5px] border-white/[0.12] bg-[#0f0f0f] font-mono text-[13px] text-[#bdbdbd]">
              <button aria-label="Zoom in" onClick={() => zoomBy(1.2)} className="px-2.5 py-1 hover:bg-white/5">+</button>
              <button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} className="border-t-[0.5px] border-white/[0.08] px-2.5 py-1 hover:bg-white/5">−</button>
              <button aria-label="Fit graph" onClick={() => { userMoved.current = false; fit() }} className="border-t-[0.5px] border-white/[0.08] px-2.5 py-1 text-[10px] hover:bg-white/5">fit</button>
            </div>
            <Minimap layout={layout} m={M} view={view} size={size} onCenter={(x, y) => { userMoved.current = true; setView((v) => ({ k: v.k, x: size.w / 2 - x * v.k, y: size.h / 2 - y * v.k })) }} />
          </div>
        </>
      )}
    </div>
  )
}

const EDGE_STYLE: Record<EdgeKind, { stroke: string; width: number; dash?: string }> = {
  done: { stroke: 'rgba(74,222,128,0.35)', width: 1.2 },
  live: { stroke: 'rgba(229,57,53,0.85)', width: 1.4, dash: '5 5' },
  hold: { stroke: 'rgba(230,180,34,0.55)', width: 1.2, dash: '3 4' },
  idle: { stroke: 'rgba(255,255,255,0.14)', width: 1, dash: '3 4' },
}

const GraphEdges = memo(function GraphEdges({ nodes, byId, layout, m: M }: { nodes: GraphNode[]; byId: Map<string, GraphNode>; layout: DagLayout; m: DagMetrics }) {
  return (
    <svg className="pointer-events-none absolute left-0 top-0" width={layout.width} height={layout.height} aria-hidden data-testid="graph-edges">
      {nodes.flatMap((n) => n.dependsOn.filter((d) => byId.has(d)).map((d) => {
        const from = layout.positions.get(d)!
        const to = layout.positions.get(n.id)!
        const kind = edgeKind(byId.get(d)!.state, n.state)
        const s = EDGE_STYLE[kind]
        return (
          <path key={`${d}>${n.id}`} data-edge={`${d}>${n.id}`} data-kind={kind} className={kind === 'live' ? 'ma-flow' : undefined}
            d={curve(from.x + M.nodeW, from.y + M.nodeH / 2, to.x, to.y + M.nodeH / 2)}
            fill="none" stroke={s.stroke} strokeWidth={s.width} strokeDasharray={s.dash} />
        )
      }))}
    </svg>
  )
})

const STATE_DOT: Record<NodeState, string> = {
  done: 'bg-[#4ade80]', run: 'bg-[#4ade80]', approval: 'bg-[#e6b422]', wait: 'bg-ma-dim', fail: 'border-[1.5px] border-ma-red', draft: 'bg-[#4ade80]', ghost: 'bg-transparent',
}
const STATE_BORDER: Record<NodeState, string> = {
  done: 'border-[#4ade80]/40', run: 'border-[#4ade80]/40', approval: 'border-[#e6b422]/60', wait: 'border-white/[0.08] opacity-60',
  fail: 'border-ma-red/60', draft: 'border-[#4ade80]/45', ghost: 'ma-ghost border-dashed border-ma-red/40',
}
const STATE_TEXT: Record<NodeState, string> = {
  done: 'text-[#4ade80]', run: 'text-[#4ade80]', approval: 'text-[#e6b422]', wait: 'text-ma-dim', fail: 'text-[#ff8c88]', draft: 'text-ma-dim', ghost: 'text-ma-dim',
}

const GraphNodeCard = memo(function GraphNodeCard({ node, x, y, m: M, selected, onSelect, onOpen }: {
  node: GraphNode; x: number; y: number; m: DagMetrics; selected: boolean; onSelect?: (id: string) => void; onOpen?: (id: string) => void
}) {
  const ghost = node.state === 'ghost'
  const compact = M.nodeH < GRAPH_METRICS.nodeH
  return (
    <div
      data-graph-node={node.id}
      data-testid={`graph-node-${node.id}`}
      data-state={node.state}
      data-selected={selected}
      role={onSelect && !ghost ? 'button' : undefined}
      tabIndex={onSelect && !ghost ? 0 : undefined}
      aria-label={ghost ? undefined : `${node.label} ${node.title}`}
      onClick={() => !ghost && onSelect?.(node.id)}
      onDoubleClick={() => !ghost && onOpen?.(node.id)}
      onKeyDown={(e) => { if (!ghost && e.key === 'Enter') onSelect?.(node.id) }}
      className={cn(
        'absolute box-border overflow-hidden border-[0.5px] bg-[#101010] px-[11px] py-2 outline-none transition-[box-shadow,opacity] duration-300',
        compact ? 'rounded-[10px]' : 'rounded-[11px]',
        STATE_BORDER[node.state],
        selected && '!border-ma-red shadow-[0_0_0_3px_rgba(229,57,53,0.18)]',
        onSelect && !ghost && 'cursor-pointer focus-visible:shadow-[0_0_0_2px_rgba(229,57,53,0.5)]'
      )}
      style={{ left: x, top: y, width: M.nodeW, height: M.nodeH }}
    >
      {!ghost && (
        <>
          <div className="flex items-center gap-[7px]">
            <span className={cn('h-[7px] w-[7px] flex-none rounded-full', STATE_DOT[node.state])} />
            <span className="font-mono text-[11.5px] text-white">{node.label}</span>
            <span className="flex-1" />
            {node.badge ? <span className="rounded-full bg-[#e6b422] px-1.5 font-mono text-[10.5px] font-medium text-[#0a0a0a]" data-testid={`graph-badge-${node.id}`}>{node.badge}</span> : null}
            {node.stateText && <span className={cn('font-mono text-[10px]', STATE_TEXT[node.state])}>{node.stateText}</span>}
          </div>
          <div className="mt-1 line-clamp-2 h-[30px] text-[11.5px] leading-[15px] text-[#cfcfcf]">{node.title}</div>
          {!compact && <div className="mt-px truncate font-mono text-[10px] leading-[13px] text-ma-dim" data-testid="graph-node-meta">{node.meta}</div>}
        </>
      )}
    </div>
  )
})

function Minimap({ layout, m: M, view, size, onCenter }: { layout: DagLayout; m: DagMetrics; view: View; size: { w: number; h: number }; onCenter: (x: number, y: number) => void }) {
  const W = 150
  const H = 92
  const s = Math.min((W - 8) / layout.width, (H - 8) / layout.height)
  const ox = (W - layout.width * s) / 2
  const oy = (H - layout.height * s) / 2
  // The visible part of the graph, in graph coordinates.
  const vx = -view.x / view.k
  const vy = -view.y / view.k
  return (
    <svg width={W} height={H} data-testid="graph-minimap" className="cursor-pointer rounded-lg border-[0.5px] border-white/[0.12] bg-[#0f0f0f]"
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect()
        onCenter((e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s)
      }}>
      {[...layout.positions.values()].map((p, i) => (
        <rect key={i} x={ox + p.x * s} y={oy + p.y * s} width={M.nodeW * s} height={M.nodeH * s} rx={2} fill="rgba(255,255,255,0.14)" />
      ))}
      <rect x={ox + vx * s} y={oy + vy * s} width={(size.w / view.k) * s} height={(size.h / view.k) * s} rx={4} fill="none" stroke="rgba(229,57,53,0.6)" strokeWidth={0.8} />
    </svg>
  )
}
