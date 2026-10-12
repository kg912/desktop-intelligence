// Layered layout of an agent plan, computed from the dependency DAG (UI Goals 5 and 6).
// One function for the planning canvas and the final graph, so nodes never jump between them.

export interface DagInput { id: string; dependsOn?: string[] }
export interface DagPosition { col: number; row: number; x: number; y: number }
export interface DagLayout {
  positions: Map<string, DagPosition>
  /** Ids per column (column 0 = no dependencies), top to bottom. */
  columns: string[][]
  width: number
  height: number
}
export interface DagMetrics { nodeW: number; nodeH: number; colGap: number; rowGap: number; pad: number }

/** Regular density: cards with the model/token meta line (designs/08). */
export const GRAPH_METRICS: DagMetrics = { nodeW: 200, nodeH: 80, colGap: 72, rowGap: 16, pad: 24 }
/** Compact density for a short canvas (bottom dock open, designs/09): no meta line. */
export const COMPACT_METRICS: DagMetrics = { ...GRAPH_METRICS, nodeH: 64, rowGap: 14 }

/** Longest-path depth (0-based) of every node; unknown ids and self/cyclic edges are ignored. */
export function dagDepths(nodes: DagInput[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const of = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0 // cycle: break it here
    visiting.add(id)
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => d !== id && byId.has(d))
    const d = deps.length ? 1 + Math.max(...deps.map(of)) : 0
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  for (const n of nodes) of(n.id)
  return depth
}

/**
 * Columns by dependency depth; within a column, nodes are ordered by the mean row of the nodes they
 * depend on (fewer crossings), ties in input order. Columns are centred vertically.
 */
export function layoutDag(nodes: DagInput[], m: DagMetrics = GRAPH_METRICS): DagLayout {
  const depths = dagDepths(nodes)
  const columnCount = nodes.length ? Math.max(...depths.values()) + 1 : 0
  const columns: string[][] = Array.from({ length: columnCount }, () => [])
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  for (const n of nodes) columns[depths.get(n.id)!].push(n.id)
  const rowOf = new Map<string, number>()
  const byId = new Map(nodes.map((n) => [n.id, n]))
  columns.forEach((col, c) => {
    if (c > 0) {
      const key = (id: string): number => {
        const rows = (byId.get(id)?.dependsOn ?? []).map((d) => rowOf.get(d)).filter((r): r is number => r !== undefined)
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Number.MAX_SAFE_INTEGER
      }
      col.sort((a, b) => key(a) - key(b) || order.get(a)! - order.get(b)!)
    }
    col.forEach((id, r) => rowOf.set(id, r))
  })
  const rows = Math.max(1, ...columns.map((c) => c.length))
  const step = m.nodeH + m.rowGap
  const height = m.pad * 2 + rows * m.nodeH + (rows - 1) * m.rowGap
  const positions = new Map<string, DagPosition>()
  columns.forEach((col, c) => {
    const offset = ((rows - col.length) * step) / 2
    col.forEach((id, r) => positions.set(id, { col: c, row: r, x: m.pad + c * (m.nodeW + m.colGap), y: m.pad + offset + r * step }))
  })
  const width = m.pad * 2 + Math.max(0, columnCount * m.nodeW + (columnCount - 1) * m.colGap)
  return { positions, columns, width, height }
}

/** True when no two nodes overlap (used by tests and as a dev assertion). */
export function overlaps(layout: DagLayout, m: DagMetrics = GRAPH_METRICS): boolean {
  const boxes = [...layout.positions.values()]
  return boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.x < b.x + m.nodeW && b.x < a.x + m.nodeW && a.y < b.y + m.nodeH && b.y < a.y + m.nodeH))
}
