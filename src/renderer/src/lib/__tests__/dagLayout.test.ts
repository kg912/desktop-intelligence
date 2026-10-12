import { describe, it, expect } from 'vitest'
import { GRAPH_METRICS, dagDepths, layoutDag, overlaps } from '../dagLayout'

const m = GRAPH_METRICS

describe('dagDepths', () => {
  it('longest path from the roots; unknown ids, self edges and cycles do not break it', () => {
    const d = dagDepths([
      { id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['a', 'b', 'ghost'] }, { id: 's', dependsOn: ['s'] },
      { id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] },
    ])
    expect(Object.fromEntries(d)).toEqual({ a: 0, b: 1, c: 2, s: 0, x: 2, y: 1 }) // the cycle is cut where it is found
  })
})

describe('layoutDag', () => {
  it('columns by depth, centred; a dependant sits beside its parents', () => {
    const l = layoutDag([{ id: '1.1' }, { id: '1.2' }, { id: '1.3' }, { id: '2.1', dependsOn: ['1.1', '1.2', '1.3'] }])
    expect(l.columns).toEqual([['1.1', '1.2', '1.3'], ['2.1']])
    expect(l.positions.get('1.1')).toEqual({ col: 0, row: 0, x: m.pad, y: m.pad })
    expect(l.positions.get('2.1')).toEqual({ col: 1, row: 0, x: m.pad + m.nodeW + m.colGap, y: m.pad + m.nodeH + m.rowGap })
    expect(l.width).toBe(m.pad * 2 + 2 * m.nodeW + m.colGap)
    expect(l.height).toBe(m.pad * 2 + 3 * m.nodeH + 2 * m.rowGap)
  })

  it('orders a column by its parents\' rows (fewer crossings)', () => {
    const l = layoutDag([{ id: 'a' }, { id: 'b' }, { id: 'y', dependsOn: ['b'] }, { id: 'x', dependsOn: ['a'] }])
    expect(l.columns[1]).toEqual(['x', 'y'])
  })

  it('8-agent and 20-agent plans render without overlap', () => {
    const eight = [...Array(6)].map((_, i) => ({ id: `1.${i + 1}` })).concat([{ id: '2.1', dependsOn: ['1.1', '1.2', '1.3', '1.4'] }, { id: '3.1', dependsOn: ['2.1', '1.5', '1.6'] }] as never)
    const l8 = layoutDag(eight)
    expect(l8.positions.size).toBe(8)
    expect(overlaps(l8)).toBe(false)
    const twenty = [...Array(20)].map((_, i) => ({ id: `n${i}`, dependsOn: i < 8 ? [] : [`n${i % 8}`, ...(i >= 14 ? [`n${i - 6}`] : [])] }))
    const l20 = layoutDag(twenty)
    expect(l20.positions.size).toBe(20)
    expect(l20.columns.map((c) => c.length)).toEqual([8, 6, 6])
    expect(overlaps(l20)).toBe(false)
  })

  it('the same steps give the same positions (planning draft → final graph does not jump)', () => {
    const draft = layoutDag([{ id: '1.1' }, { id: '1.2' }, { id: '2.1', dependsOn: ['1.1', '1.2'] }])
    const final = layoutDag([{ id: '1.1' }, { id: '1.2' }, { id: '2.1', dependsOn: ['1.1', '1.2'] }])
    expect([...final.positions]).toEqual([...draft.positions])
  })

  it('empty', () => {
    expect(layoutDag([])).toMatchObject({ columns: [], width: m.pad * 2 })
  })
})
